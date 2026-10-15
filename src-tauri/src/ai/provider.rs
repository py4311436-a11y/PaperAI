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

use super::client::{self, classify_status, classify_transport, CONNECT_TIMEOUT, FIRST_TOKEN_TIMEOUT};
use super::{config, settings};
use super::secrets;
use super::stream::{SseEvent, SseParser};
use super::types::{AiStreamEvent, ChatMessage, ConnectionTest, ModelOption};

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
fn req_chars(req: &ChatCall) -> usize {
    req.messages.iter().map(|m| m.content.chars().count()).sum()
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
pub async fn run_chat<S>(provider: Arc<OpenAiCompatible>, req: ChatCall, mut cancel: watch::Receiver<bool>, sink: &S)
where
    S: Fn(AiStreamEvent) + Send + Sync,
{
    sink(AiStreamEvent::Started);
    let started = Instant::now();

    let target = match client::resolve_target(&req.base_url) {
        Ok(t) => t,
        Err(e) => return fail(sink, e),
    };
    let auth = match secrets::read_secret(&req.profile_id) {
        Ok(k) => format!("Bearer {k}"),
        Err(e) => return fail(sink, e),
    };

    let payload = build_body(&req.model, &req.messages, req.temperature, true);

    let send = with_session(
        provider
            .http
            .post(&target.url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .timeout(CONNECT_TIMEOUT),
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

    // First-token deadline: measured from the moment the request was accepted,
    // reset on every chunk so it acts as an idle timeout too.
    let mut deadline = tokio::time::Instant::now() + FIRST_TOKEN_TIMEOUT;

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
                sink(AiStreamEvent::Error {
                    code: codes::AI_FIRST_TOKEN_TIMEOUT.to_string(),
                    safe_message: "等待模型响应超时".to_string(),
                });
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
                        deadline = tokio::time::Instant::now() + FIRST_TOKEN_TIMEOUT;
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
        .map(|m| MsgOut { role: m.role.clone(), content: m.content.clone() })
        .collect();

    let mut obj = serde_json::Map::new();
    obj.insert("model".into(), serde_json::Value::String(model.to_string()));
    obj.insert("messages".into(), serde_json::to_value(msgs).unwrap_or_default());
    obj.insert("stream".into(), serde_json::Value::Bool(stream));
    if let Some(t) = temperature {
        obj.insert("temperature".into(), serde_json::json!(t));
    }
    serde_json::Value::Object(obj)
}

#[derive(Serialize)]
struct MsgOut {
    role: String,
    content: String,
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
            .timeout(CONNECT_TIMEOUT + std::time::Duration::from_secs(20)),
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
    send_session_header: bool,
) -> Result<Vec<ModelOption>, AppError> {
    let url = config::models_url(base_url)?;

    let auth = credential_id
        .and_then(|id| secrets::read_secret(id).ok())
        .map(|k| format!("Bearer {k}"));

    let mut rb = with_session(
        http.get(&url)
            .header("Accept", "application/json")
            .timeout(CONNECT_TIMEOUT + std::time::Duration::from_secs(20)),
        send_session_header,
        Some("paperai-models"),
    );
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

    #[test]
    fn body_is_minimal_and_lowercase_roles_only() {
        let msgs = vec![
            ChatMessage { role: "system".into(), content: "s".into() },
            ChatMessage { role: "user".into(), content: "u".into() },
            ChatMessage { role: "tool".into(), content: "should be dropped".into() },
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
        let msgs = vec![ChatMessage { role: "user".into(), content: "u".into() }];
        assert!(!build_body("m", &msgs, None, true).as_object().unwrap().contains_key("temperature"));
        // f32 -> Value goes through f64, so compare approximately rather than
        // against the literal 0.3.
        let t = build_body("m", &msgs, Some(0.3), true)["temperature"]
            .as_f64()
            .expect("temperature is a number");
        assert!((t - 0.3).abs() < 1e-6, "got {t}");
    }
}
