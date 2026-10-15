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
use super::secrets;
use super::stream::{SseEvent, SseParser};
use super::types::{AiStreamEvent, ChatMessage, ConnectionTest};

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
/// Kept separate from the `Channel` so it can be driven end-to-end by the
/// integration tests (which collect events into a Vec) without a Tauri app.
/// The `Channel` implementation above is a two-line wrapper.
pub async fn run_chat<S>(provider: Arc<OpenAiCompatible>, req: ChatCall, mut cancel: watch::Receiver<bool>, sink: &S)
where
    S: Fn(AiStreamEvent) + Send + Sync,
{
    sink(AiStreamEvent::Started);

    let target = match client::resolve_target(&req.base_url) {
        Ok(t) => t,
        Err(e) => return fail(sink, e),
    };
    let auth = match secrets::read_secret(&req.profile_id) {
        Ok(k) => format!("Bearer {k}"),
        Err(e) => return fail(sink, e),
    };

    let payload = build_body(&req.model, &req.messages, req.temperature, true);

    let send = provider
        .http
        .post(&target.url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .timeout(CONNECT_TIMEOUT)
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
        return fail(sink, classify_status(status.as_u16(), &body));
    }

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

    let resp = http
        .post(&target.url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .timeout(CONNECT_TIMEOUT + std::time::Duration::from_secs(20))
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
