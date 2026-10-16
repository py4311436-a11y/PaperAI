//! The provider contract and the OpenAI-compatible implementation.
//!
//! Scope for this round: **Chat Completions only** — `POST /chat/completions`
//! with `stream: true` and `data: {...}` / `data: [DONE]` SSE. DeepSeek is a
//! preset of this same code path, not a fork.
//!
//! The request body is deliberately minimal. Many "OpenAI-compatible" gateways
//! reject unknown fields and some bill differently when reasoning flags are
//! present, so we send only what every implementation understands.
//!
//! Everything here is `async`. Nothing builds a nested runtime: the Tauri
//! command spawns a task on the app's runtime and reads from it there.

use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::watch;

use crate::error::{codes, AppError, AppResult};

use super::client::{self, classify_status, classify_transport, FIRST_TOKEN_TIMEOUT};
use super::{config, settings};
use super::secrets;
use super::stream::{SseEvent, SseParser};
use super::types::{
    AiStreamEvent, ChatMessage, ConnectionTest, Content, ContentPart, ImageUrl, ModelOption,
};

/// Total budget for the small, non-streaming helper requests (connection probe,
/// model catalogue). A whole-exchange deadline is right for those and wrong for
/// the chat stream — see the A-16 note in `client::build_client`.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(35);

/// Ceiling on one inline image, in base64 characters.
///
/// DeepSeek's documented body ceiling is 48 MiB and OpenAI's per-image limit is
/// 20 MB, so this is comfortably inside both — but it is here to turn a
/// confusing gateway rejection into a local one we can phrase. The frontend
/// already downscales; this is the backstop for anything that reaches Rust.
const MAX_INLINE_IMAGE_CHARS: usize = 8 * 1024 * 1024;

/// Ceiling on inline image payload across a whole request.
const MAX_TOTAL_IMAGE_CHARS: usize = 24 * 1024 * 1024;

/// A future produced by a provider. Boxed and `Send` so it can be spawned on
/// the app runtime and outlive the IPC call that started it.
pub type ChatFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>>;

/// The narrow interface the rest of the app uses.
///
/// Kept as a trait so a second dialect can be added without touching the
/// command layer; this round only ships the OpenAI-compatible implementation.
pub trait Provider: Send + Sync + 'static {
    /// Stream a completion, emitting [`AiStreamEvent`]s on `sink`.
    ///
    /// `cancel` flips to `true` when the user presses stop. The implementation
    /// must drop the HTTP body promptly and emit **exactly one** terminal event
    /// (`completed` / `cancelled` / `error`).
    ///
    /// Takes `Arc<Self>` and owned request data so the returned future is
    /// `'static` and can be spawned.
    fn start_chat(
        self: Arc<Self>,
        req: ChatCall,
        sink: Channel<AiStreamEvent>,
        cancel: watch::Receiver<bool>,
    ) -> ChatFuture;
}

/// Everything one streamed completion needs. Owned so the future can be
/// `'static`; the values are small (a profile id, a URL, a model name) and the
/// message list is built once by the frontend.
pub struct ChatCall {
    pub profile_id: String,
    pub base_url: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    /// Stable per-conversation id, sent as `x-opencode-session` when the
    /// profile asks for it. Never derived from a credential.
    pub session_id: Option<String>,
    /// See `AiProfile::sends_session_header`.
    pub send_session_header: bool,
}

/// Attach the OpenCode session header when the profile asks for it.
///
/// Their gateway documents this as a requirement ("Send a stable session ID in
/// `x-opencode-session` for each conversation so we can optimize routing and
/// prompt caching") and warns that requests without it may start failing. The
/// value is a random conversation id, not a secret. Sent to every provider that
/// has the flag on and to nobody else — this is not host sniffing.
fn with_session(
    rb: reqwest::RequestBuilder,
    send: bool,
    session_id: Option<&str>,
) -> reqwest::RequestBuilder {
    match (send, session_id) {
        (true, Some(sid)) if !sid.trim().is_empty() => rb.header("x-opencode-session", sid),
        _ => rb,
    }
}

/// OpenAI-compatible Chat Completions provider.
pub struct OpenAiCompatible {
    http: reqwest::Client,
}

impl OpenAiCompatible {
    pub fn new() -> AppResult<Self> {
        Ok(Self { http: client::build_client()? })
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
}

impl Provider for OpenAiCompatible {
    fn start_chat(
        self: Arc<Self>,
        req: ChatCall,
        sink: Channel<AiStreamEvent>,
        cancel: watch::Receiver<bool>,
    ) -> ChatFuture {
        Box::pin(async move {
            let emit = move |ev: AiStreamEvent| {
                let _ = sink.send(ev);
            };
            run_chat(self, req, cancel, &emit).await;
        })
    }
}

/// The streaming core, generic over the sink.
///
/// Total characters sent, logged so "the gateway refused because the payload was
/// too big" is answerable after the fact instead of guessed at.
///
/// Text only: images are accounted separately by `Content::image_payload_bytes`,
/// because a screenshot's base64 is three orders of magnitude larger than its
/// caption and would swamp the number that diagnoses text-heavy rejections.
fn req_chars(req: &ChatCall) -> usize {
    req.messages.iter().map(|m| m.content.text().chars().count()).sum()
}

/// One log line per request outcome.
///
/// Added because a provider rejection was undiagnosable: `paperai.log` recorded
/// only argv, so when OpenCode answered 403/`inference_failed` there was nothing
/// on the machine to say which model, which host, how large the payload was, or
/// what the gateway's own reason was. Those four facts decide almost every case,
/// and none of them is a secret.
///
/// Recorded: model, host, status, the provider's own error token, payload size,
/// elapsed time. NOT recorded: the key, message content, document text, titles.
fn audit_outcome(
    model: &str,
    base_url: &str,
    status: u16,
    body: &str,
    chars: usize,
    started: Instant,
) {
    let code = if body.is_empty() {
        "-".to_string()
    } else {
        client::provider_error_code(body).unwrap_or_else(|| "none".into())
    };
    crate::audit(&format!(
        "ai: model={model} host={} status={status} provider_code={code} chars={chars} elapsed_ms={}",
        config::host_of(base_url),
        started.elapsed().as_millis()
    ));
}

/// Kept separate from the `Channel` so it can be driven end-to-end by the
/// integration tests (which collect events into a Vec) without a Tauri app.
/// The `Channel` implementation above is a two-line wrapper.
pub async fn run_chat<S>(
    provider: Arc<OpenAiCompatible>,
    req: ChatCall,
    cancel: watch::Receiver<bool>,
    sink: &S,
) where
    S: Fn(AiStreamEvent) + Send + Sync,
{
    run_chat_with_deadlines(provider, req, cancel, sink, FIRST_TOKEN_TIMEOUT).await
}

/// [`run_chat`] with the stall deadline supplied by the caller.
///
/// Exists so the "provider dies mid-answer" test does not have to sit through
/// the full production deadline. The app always goes through [`run_chat`]; there
/// is no environment variable and no test-only branch in the request path, so
/// the tests drive the same loop that ships.
pub async fn run_chat_with_deadlines<S>(
    provider: Arc<OpenAiCompatible>,
    req: ChatCall,
    mut cancel: watch::Receiver<bool>,
    sink: &S,
    stall_timeout: std::time::Duration,
) where
    S: Fn(AiStreamEvent) + Send + Sync,
{
    sink(AiStreamEvent::Started);
    let started = Instant::now();

    if let Err(e) = validate_images(&req.messages) {
        return fail(sink, e);
    }

    let target = match client::resolve_target(&req.base_url) {
        Ok(t) => t,
        Err(e) => return fail(sink, e),
    };
    let auth = match secrets::read_secret(&req.profile_id) {
        Ok(k) => format!("Bearer {k}"),
        Err(e) => return fail(sink, e),
    };

    let payload = build_body(&req.model, &req.messages, req.temperature, true);

    // A-16: NO `.timeout(...)` on this request.
    //
    // `RequestBuilder::timeout()` is a *total* deadline covering connect through
    // the end of the response body, and it overrides the client setting. Putting
    // `CONNECT_TIMEOUT` (15s) here meant every completion lasting more than 15
    // seconds was cut off mid-stream and reported as `ai_timeout` — which is how
    // a whole-document question could show reasoning output and then die at a
    // suspiciously round 15 s. Stall protection lives in this event loop
    // instead, where it can distinguish "nothing yet" from "stopped mid-answer".
    let send = with_session(
        provider
            .http
            .post(&target.url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream"),
        req.send_session_header,
        req.session_id.as_deref(),
    )
    .json(&payload)
    .send();

    let resp = tokio::select! {
        biased;
        _ = wait_cancel(&mut cancel) => {
            sink(AiStreamEvent::Cancelled);
            return;
        }
        r = send => r,
    };

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return fail(sink, classify_transport(&e)),
    };

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let err = classify_status(status.as_u16(), &body);
        audit_outcome(&req.model, &target.base_url, status.as_u16(), &body, req_chars(&req), started);
        return fail(sink, err);
    }
    audit_outcome(&req.model, &target.base_url, status.as_u16(), "", req_chars(&req), started);

    let mut parser = SseParser::new();
    let mut body = resp.bytes_stream();
    let mut saw_any = false;

    // Stall deadline: measured from the moment the request was accepted, reset
    // on every chunk so it acts as an idle timeout too. This — not a total
    // request deadline — is what bounds a hung provider (A-16).
    let mut deadline = tokio::time::Instant::now() + stall_timeout;

    loop {
        tokio::select! {
            biased;

            _ = wait_cancel(&mut cancel) => {
                sink(AiStreamEvent::Cancelled);
                // Dropping `body` here closes the connection instead of waiting
                // for a provider that may never send more bytes.
                return;
            }

            _ = tokio::time::sleep_until(deadline) => {
                // A-16: say WHICH kind of stall this is. Before, a stream that
                // had already produced text was reported as "waiting for the
                // model timed out", which is both false and unhelpful: nothing
                // is being waited for, the answer was cut off. The two cases
                // have different causes (bad endpoint vs. a gateway dropping a
                // long response) and the message now reflects that.
                let (code, msg) = if saw_any {
                    (
                        codes::AI_TIMEOUT,
                        "回答生成到一半被中断（连接在输出过程中停止）。可尝试重试，或改用更小的上下文范围。",
                    )
                } else {
                    (
                        codes::AI_FIRST_TOKEN_TIMEOUT,
                        "等待模型响应超时：连接已建立，但一直没有收到内容。请检查 Base URL 与模型名。",
                    )
                };
                sink(AiStreamEvent::Error { code: code.to_string(), safe_message: msg.to_string() });
                return;
            }

            item = body.next() => {
                match item {
                    None => {
                        for ev in parser.finish() {
                            if !apply(ev, &mut saw_any, sink) {
                                return;
                            }
                        }
                        if parser.is_finished() {
                            return;
                        }
                        if saw_any {
                            // Many gateways omit [DONE]; a clean close after
                            // content is a successful completion.
                            sink(AiStreamEvent::Completed { finish_reason: None });
                        } else {
                            sink(AiStreamEvent::Error {
                                code: codes::AI_BAD_STREAM.to_string(),
                                safe_message: "服务未返回任何内容。请确认它支持 OpenAI 兼容的 \
                                               Chat Completions 流式接口。"
                                    .to_string(),
                            });
                        }
                        return;
                    }
                    Some(Err(e)) => return fail(sink, classify_transport(&e)),
                    Some(Ok(bytes)) => {
                        deadline = tokio::time::Instant::now() + stall_timeout;
                        for ev in parser.push(&bytes) {
                            if !apply(ev, &mut saw_any, sink) {
                                return;
                            }
                        }
                        if parser.is_finished() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

/// Resolves when the request should stop (either already-cancelled or a later flip).
async fn wait_cancel(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow_and_update() {
        return;
    }
    // `changed()` errors only when the sender is dropped, which means the
    // registry was torn down — treat that as "stop".
    let _ = rx.changed().await;
}

fn emit(sink: &Channel<AiStreamEvent>, ev: AiStreamEvent) {
    let _ = sink.send(ev);
}

fn fail<S: Fn(AiStreamEvent)>(sink: &S, e: AppError) {
    sink(AiStreamEvent::Error { code: e.code, safe_message: e.message });
}

/// Minimal request body: model, messages, stream, optional temperature.
/// Serialize one message's content, collapsing an all-text block list to a bare
/// JSON string.
///
/// The collapse is the prefix-cache invariant made structural rather than
/// remembered. Providers match on the request prefix, and the document message
/// must stay byte-identical between turns — which it only does if it keeps the
/// shape it always had. A caller that assembles the document as a one-element
/// block list would otherwise turn every turn into a cache miss, with no
/// symptom anywhere: the answer still arrives, it just costs full price and
/// takes seconds longer.
///
/// So the rule is total and independent of the caller: **no images means the
/// content is text, and text goes out as a string.** Blocks that carry no image
/// are joined with a newline, which is what separate text blocks mean.
fn content_value(content: &Content) -> serde_json::Value {
    match content {
        Content::Text(s) => serde_json::Value::String(s.clone()),
        Content::Parts(parts) => {
            let has_image = parts
                .iter()
                .any(|p| matches!(p, ContentPart::ImageUrl { .. }));
            if has_image {
                serde_json::to_value(parts).unwrap_or_default()
            } else {
                let joined = parts
                    .iter()
                    .map(|p| match p {
                        ContentPart::Text { text } => text.as_str(),
                        ContentPart::ImageUrl { .. } => "",
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                serde_json::Value::String(joined)
            }
        }
    }
}

/// Reject images that cannot possibly succeed, before spending a round trip.
///
/// Two rules, both about failures that are otherwise diagnosable only from a
/// gateway's error text:
///
///  - `http://` is refused. A screenshot of a paper is the most sensitive thing
///    this app sends; fetching it over cleartext to save a base64 encoding is
///    not a trade worth making. `data:` and `https:` only.
///  - Size ceilings, because a gateway's 413 arrives as an opaque 400 on most
///    OpenAI-compatible implementations.
fn validate_images(messages: &[ChatMessage]) -> AppResult<()> {
    let mut total = 0usize;
    for m in messages {
        let Content::Parts(parts) = &m.content else {
            continue;
        };
        for p in parts {
            let ContentPart::ImageUrl { image_url } = p else {
                continue;
            };
            let url = image_url.url.trim();
            if !(url.starts_with("data:") || url.starts_with("https://")) {
                return Err(AppError::new(
                    codes::AI_BAD_CONFIG,
                    "图片地址只支持 data: 或 https://（http:// 会明文传输文档内容）",
                ));
            }
            if url.len() > MAX_INLINE_IMAGE_CHARS {
                return Err(AppError::new(
                    codes::AI_BAD_CONFIG,
                    "单张图片过大，请截取更小的区域",
                ));
            }
            total += url.len();
        }
    }
    if total > MAX_TOTAL_IMAGE_CHARS {
        return Err(AppError::new(
            codes::AI_BAD_CONFIG,
            "图片总大小超出限制，请减少图片数量或截取更小的区域",
        ));
    }
    Ok(())
}

/// Deliberately free of `tools`, `response_format`, `thinking`,
/// `reasoning_effort` and every other vendor extension.
fn build_body(
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    stream: bool,
) -> serde_json::Value {
    let msgs: Vec<MsgOut> = messages
        .iter()
        .filter(|m| matches!(m.role.as_str(), "system" | "user" | "assistant"))
        .map(|m| MsgOut {
            role: m.role.clone(),
            content: content_value(&m.content),
        })
        .collect();

    let mut obj = serde_json::Map::new();
    obj.insert("model".into(), serde_json::Value::String(model.to_string()));
    obj.insert("messages".into(), serde_json::to_value(&msgs).unwrap_or_default());
    obj.insert("stream".into(), serde_json::Value::Bool(stream));
    if let Some(t) = temperature {
        obj.insert("temperature".into(), serde_json::json!(t));
    }
    serde_json::Value::Object(obj)
}

#[derive(Serialize)]
struct MsgOut {
    role: String,
    content: serde_json::Value,
}

/// Apply one parsed SSE event to the sink.
/// Returns `false` when the stream is over (a terminal event was emitted).
fn apply<S: Fn(AiStreamEvent)>(ev: SseEvent, saw_any: &mut bool, sink: &S) -> bool {
    match ev {
        SseEvent::Done => {
            sink(AiStreamEvent::Completed { finish_reason: None });
            false
        }
        SseEvent::Chunk(c) => {
            if let Some(msg) = c.error_message {
                sink(AiStreamEvent::Error {
                    code: c.error_code.unwrap_or_else(|| codes::AI_PROVIDER_ERROR.to_string()),
                    safe_message: msg,
                });
                return false;
            }
            if let Some(t) = c.content {
                if !t.is_empty() {
                    *saw_any = true;
                    sink(AiStreamEvent::Delta { text: t });
                }
            }
            if let Some(fr) = c.finish_reason {
                sink(AiStreamEvent::Completed { finish_reason: Some(fr) });
                return false;
            }
            true
        }
    }
}

/// One-shot, non-streaming connection probe.
///
/// Separate from the trait because it needs an explicit URL: the user may be
/// testing a profile they have not saved yet. It intentionally sends a
/// 1-token request and the UI warns that this may cost a small amount.
pub async fn probe_connection(
    http: &reqwest::Client,
    profile_id: &str,
    base_url: &str,
    model: &str,
    send_session_header: bool,
) -> ConnectionTest {
    let started = Instant::now();
    let elapsed = |t: &Instant| t.elapsed().as_millis() as u64;

    let target = match client::resolve_target(base_url) {
        Ok(t) => t,
        Err(e) => return bad(e, elapsed(&started)),
    };
    if model.trim().is_empty() {
        return bad(
            AppError::new(codes::AI_BAD_CONFIG, "模型名不能为空"),
            elapsed(&started),
        );
    }
    let auth = match secrets::read_secret(profile_id) {
        Ok(k) => format!("Bearer {k}"),
        Err(e) => return bad(e, elapsed(&started)),
    };

    let payload = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "stream": false,
        "max_tokens": 1
    });

    let resp = with_session(
        http.post(&target.url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            // A total budget is CORRECT here, unlike in `run_chat` (A-16): this
            // is a single non-streaming 1-token probe that must finish quickly,
            // so a deadline on the whole exchange is exactly what we want.
            .timeout(PROBE_TIMEOUT),
        send_session_header,
        // A probe is not a conversation; a fixed id is enough to satisfy the
        // gateway and keeps the request a fair sample of the real ones.
        Some("paperai-probe"),
    )
    .json(&payload)
    .send()
    .await;

    match resp {
        Err(e) => bad(classify_transport(&e), elapsed(&started)),
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            let ms = elapsed(&started);
            if status.is_success() {
                let echoed = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_string));
                ConnectionTest {
                    ok: true,
                    code: "ok".into(),
                    message: "连接正常".into(),
                    elapsed_ms: ms,
                    model_echo: echoed,
                }
            } else {
                bad(classify_status(status.as_u16(), &text), ms)
            }
        }
    }
}

fn bad(e: AppError, ms: u64) -> ConnectionTest {
    ConnectionTest {
        ok: false,
        code: e.code,
        message: e.message,
        elapsed_ms: ms,
        model_echo: None,
    }
}

/// Fetch a provider's live model catalogue.
///
/// This exists so the UI never has to ship a hard-coded model list: OpenCode's
/// catalogue gained and retired several ids within weeks, and any list baked
/// into the app is wrong within a release or two. The endpoint is
/// `GET {base}/models` and the shape is the OpenAI convention
/// (`{"object":"list","data":[{"id":...}]}`).
///
/// The key is optional on purpose — some gateways (OpenCode Zen and Go among
/// them) serve their catalogue unauthenticated, so a user can browse free models
/// before deciding to create a key. When a credential id *is* given it is sent,
/// because some providers list a different, per-account subset when
/// authenticated.
///
/// Every id is annotated with [`protocol_hint`] so the UI can warn about models
/// the provider serves on a different protocol than the one this app speaks.
pub async fn list_models(
    http: &reqwest::Client,
    credential_id: Option<&str>,
    base_url: &str,
) -> Result<Vec<ModelOption>, AppError> {
    let url = config::models_url(base_url)?;

    let auth = credential_id
        .and_then(|id| secrets::read_secret(id).ok())
        .map(|k| format!("Bearer {k}"));

    // No `x-opencode-session` here, deliberately. OpenCode's own guidance is that
    // model-catalogue requests do not carry it — they are not part of a
    // conversation, so there is no backend to pin. Sending one would give the
    // catalogue its own pointless affinity scope; the header belongs on inference
    // requests only, which is where `with_session` is called in `run_chat`.
    let mut rb = http
        .get(&url)
        .header("Accept", "application/json")
        // Total budget is correct for a catalogue GET (A-16); the stream in
        // `run_chat` is the opposite case.
        .timeout(PROBE_TIMEOUT);
    if let Some(a) = auth {
        rb = rb.header("Authorization", a);
    }

    let resp = rb.send().await.map_err(|e| classify_transport(&e))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // Include the resolved URL: a wrong base URL is the most likely cause,
        // and "no models" alone gives the user nothing to act on.
        let e = classify_status(status.as_u16(), &body);
        return Err(AppError::new(&e.code, format!("{}（请求 {url}）", e.message)));
    }

    let ids = parse_model_ids(&body)
        .ok_or_else(|| {
            AppError::new(
                codes::AI_BAD_STREAM,
                format!(
                    "无法解析模型列表：{url} 的返回不是 OpenAI 兼容的 \
                     {{\"data\":[{{\"id\":…}}]}} 结构。请确认 Base URL 指向服务根路径。"
                ),
            )
        })?;

    // Free models first, then alphabetical. Purely a convenience ordering: the
    // catalogue can be dozens of ids and the free ones are what a user trying
    // a provider out wants to see. `free_hint` is a name-based inference, so it
    // is used only for sorting.
    let mut options: Vec<ModelOption> = ids
        .into_iter()
        .map(|id| ModelOption {
            compatibility: settings::protocol_hint(&id).to_string(),
            free_hint: id.to_ascii_lowercase().ends_with("-free"),
            id,
        })
        .collect();
    options.sort_by(|a, b| {
        b.free_hint
            .cmp(&a.free_hint)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(options)
}

/// Pull model ids out of the several shapes providers actually return.
///
/// The OpenAI convention is the target, but a bare array and a top-level
/// `models` key both occur in the wild; accepting them costs three lines and
/// avoids a confusing failure on a perfectly good endpoint.
fn parse_model_ids(body: &str) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|m| m.as_array()))
        .or_else(|| v.as_array())?;

    let mut ids: Vec<String> = arr
        .iter()
        .filter_map(|m| {
            m.get("id")
                .and_then(|i| i.as_str())
                // A bare array of strings.
                .or_else(|| m.as_str())
                .map(str::to_string)
        })
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    ids.sort();
    ids.dedup();
    Some(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Content {
        Content::Text(s.to_string())
    }

    fn img(url: &str) -> ContentPart {
        ContentPart::ImageUrl {
            image_url: ImageUrl {
                url: url.to_string(),
                detail: None,
            },
        }
    }

    #[test]
    fn body_is_minimal_and_lowercase_roles_only() {
        let msgs = vec![
            ChatMessage { role: "system".into(), content: text("s") },
            ChatMessage { role: "user".into(), content: text("u") },
            ChatMessage { role: "tool".into(), content: text("should be dropped") },
        ];
        let b = build_body("m", &msgs, None, true);
        let obj = b.as_object().unwrap();
        assert_eq!(obj.len(), 3, "unexpected extra fields: {obj:?}");
        assert_eq!(obj["model"], "m");
        assert_eq!(obj["stream"], true);
        assert_eq!(obj["messages"].as_array().unwrap().len(), 2);
        for banned in ["tools", "response_format", "thinking", "reasoning_effort", "top_p"] {
            assert!(!obj.contains_key(banned), "{banned} must not be sent");
        }
    }

    #[test]
    fn temperature_only_when_requested() {
        let msgs = vec![ChatMessage { role: "user".into(), content: text("u") }];
        assert!(!build_body("m", &msgs, None, true).as_object().unwrap().contains_key("temperature"));
        // f32 -> Value goes through f64, so compare approximately rather than
        // against the literal 0.3.
        let t = build_body("m", &msgs, Some(0.3), true)["temperature"]
            .as_f64()
            .expect("temperature is a number");
        assert!((t - 0.3).abs() < 1e-6, "got {t}");
    }

    /// The prefix-cache invariant, stated as a test.
    ///
    /// Providers match on the request prefix, so the document message has to be
    /// byte-identical between turns. It only is if it keeps the shape it always
    /// had — a bare string. A one-element block list would serialise as an
    /// array and silently cost the cache on every question, with no symptom
    /// beyond a slower, more expensive answer.
    #[test]
    fn text_only_content_stays_a_bare_string() {
        let msgs = vec![ChatMessage { role: "user".into(), content: text("论文全文") }];
        let c = &build_body("m", &msgs, None, true)["messages"][0]["content"];
        assert!(c.is_string(), "text must stay a string, got {c}");
        assert_eq!(c.as_str().unwrap(), "论文全文");
    }

    /// The collapse, independent of the caller.
    ///
    /// `Content::Text` is the documented way to say "text", but a caller that
    /// builds a one-element block list must not quietly become a cache miss.
    /// The rule is total: no images means the content is text.
    #[test]
    fn all_text_block_list_collapses_to_a_string() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: Content::Parts(vec![
                ContentPart::Text { text: "论文全文".into() },
                ContentPart::Text { text: "第 3 页".into() },
            ]),
        }];
        let c = &build_body("m", &msgs, None, true)["messages"][0]["content"];
        assert!(c.is_string(), "no images means a string, got {c}");
        assert_eq!(c.as_str().unwrap(), "论文全文\n第 3 页");
    }

    /// The multimodal shape: a block array, text first, in the order given.
    #[test]
    fn mixed_content_becomes_a_block_array() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: Content::Parts(vec![
                ContentPart::Text { text: "这条曲线为什么断开？".into() },
                img("data:image/png;base64,AAAA"),
            ]),
        }];
        let c = &build_body("m", &msgs, None, true)["messages"][0]["content"];
        let arr = c.as_array().expect("mixed content must be an array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[0]["text"], "这条曲线为什么断开？");
        assert_eq!(arr[1]["type"], "image_url");
        assert_eq!(arr[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }

    /// An image with no words is a legitimate question. It must not be treated
    /// as an empty message and rejected.
    #[test]
    fn image_only_message_is_not_empty() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: Content::Parts(vec![img("data:image/png;base64,AAAA")]),
        }];
        assert!(!msgs[0].content.is_empty(), "an image is content");
        let c = &build_body("m", &msgs, None, true)["messages"][0]["content"];
        assert_eq!(c.as_array().unwrap().len(), 1);
    }

    /// `detail` is omitted rather than defaulted. Most gateways reject an
    /// unrecognised enum value, and absence is portable across all of them.
    #[test]
    fn detail_is_omitted_when_unset() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: Content::Parts(vec![img("data:image/png;base64,AAAA")]),
        }];
        let part = &build_body("m", &msgs, None, true)["messages"][0]["content"][0];
        assert!(part["image_url"].get("detail").is_none(), "got {part}");
    }

    /// A screenshot of a paper is the most sensitive payload this app sends.
    /// Fetching it over cleartext to avoid a base64 encoding is not a trade
    /// worth making.
    #[test]
    fn http_image_url_is_refused() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: Content::Parts(vec![img("http://example.com/a.png")]),
        }];
        let e = validate_images(&msgs).unwrap_err();
        assert_eq!(e.code, codes::AI_BAD_CONFIG);
    }

    #[test]
    fn https_and_data_urls_are_accepted() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: Content::Parts(vec![
                img("https://example.com/a.png"),
                img("data:image/png;base64,AAAA"),
            ]),
        }];
        assert!(validate_images(&msgs).is_ok());
    }

    /// A gateway's 413 arrives as an opaque 400 on most OpenAI-compatible
    /// implementations, so the ceiling is enforced locally where the message
    /// can name the real problem.
    #[test]
    fn oversized_image_is_refused() {
        let big = format!("data:image/png;base64,{}", "A".repeat(MAX_INLINE_IMAGE_CHARS + 1));
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: Content::Parts(vec![img(&big)]),
        }];
        let e = validate_images(&msgs).unwrap_err();
        assert_eq!(e.code, codes::AI_BAD_CONFIG);
    }

    /// The document message must survive an image turn untouched: images belong
    /// to the question, never to the cached prefix.
    #[test]
    fn document_message_is_unchanged_by_an_image_question() {
        let msgs = vec![
            ChatMessage { role: "system".into(), content: text("sys") },
            ChatMessage { role: "user".into(), content: text("<document_context>论文</document_context>") },
            ChatMessage {
                role: "user".into(),
                content: Content::Parts(vec![
                    ContentPart::Text { text: "这是什么图？".into() },
                    img("data:image/png;base64,AAAA"),
                ]),
            },
        ];
        let b = build_body("m", &msgs, None, true);
        let arr = b["messages"].as_array().unwrap();
        assert!(arr[1]["content"].is_string(), "the document must stay a string");
        assert!(arr[2]["content"].is_array(), "the question carries the image");
    }
}
