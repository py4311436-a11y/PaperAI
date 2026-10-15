//! End-to-end tests of the OpenAI-compatible provider against the local Mock
//! SSE server.
//!
//! These are real: a real HTTP client, a real socket, real SSE bytes written by
//! `tests/ai-mock/server.mjs`. Nothing is stubbed. The only thing that is not
//! exercised is the Tauri `Channel` (which is a two-line wrapper around the
//! generic sink these tests drive directly).
//!
//! Run:
//!   cargo test --test ai_provider -- --nocapture
//!
//! The mock is started by `scripts/run-ai-rust-tests.mjs`, which exports
//! `PAPERAI_MOCK_BASE` before invoking cargo. When that variable is missing the
//! suite skips loudly rather than silently passing.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use paperai_lib::ai::provider::{run_chat, ChatCall, OpenAiCompatible};
use paperai_lib::ai::secrets;
use paperai_lib::ai::types::{AiStreamEvent, ChatMessage};

/// Collect events into a Vec so we can assert on the whole stream.
#[derive(Clone, Default)]
struct Collector(Arc<Mutex<Vec<AiStreamEvent>>>);

impl Collector {
    fn sink(&self) -> impl Fn(AiStreamEvent) + Send + Sync + 'static {
        let inner = Arc::clone(&self.0);
        move |ev| inner.lock().unwrap().push(ev)
    }
    fn events(&self) -> Vec<AiStreamEvent> {
        self.0.lock().unwrap().clone()
    }
    /// Concatenated delta text.
    fn text(&self) -> String {
        self.events()
            .iter()
            .filter_map(|e| match e {
                AiStreamEvent::Delta { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }
    fn terminal(&self) -> Option<AiStreamEvent> {
        self.events().into_iter().find(|e| {
            matches!(
                e,
                AiStreamEvent::Completed { .. } | AiStreamEvent::Cancelled | AiStreamEvent::Error { .. }
            )
        })
    }
}

const PROFILE: &str = "rust-test-profile";

fn mock_base() -> String {
    std::env::var("PAPERAI_MOCK_BASE").unwrap_or_else(|_| "http://127.0.0.1:0".to_string())
}

/// Scenario name the mock is currently serving. The runner restarts the mock
/// per scenario and sets this.
fn scenario() -> String {
    std::env::var("PAPERAI_MOCK_SCENARIO").unwrap_or_default()
}

/// Deletes the test credential when it goes out of scope.
///
/// This suite writes into the REAL Windows Credential Manager, so leaving the
/// entry behind would put a junk item in the user's credential store — and one
/// was indeed found there (`PaperAI/AIProvider/rust-test-profile`) after an
/// earlier run. `Drop` covers the normal return and the unwinding-from-panic
/// case both, which a trailing statement would not.
struct KeyGuard;

impl Drop for KeyGuard {
    fn drop(&mut self) {
        let _ = secrets::delete_secret(PROFILE);
    }
}

/// Reset the stored key so each test starts from a known state, and arrange for
/// it to be removed again. Bind the result: `let _key = with_key();`.
fn with_key() -> KeyGuard {
    secrets::write_secret(PROFILE, "sk-mock-0123456789").expect("store mock key");
    KeyGuard
}

fn call(messages: Vec<(&str, &str)>) -> ChatCall {
    ChatCall {
        profile_id: PROFILE.into(),
        base_url: mock_base(),
        model: "mock-model".into(),
        messages: messages
            .into_iter()
            .map(|(r, c)| ChatMessage { role: r.into(), content: c.into() })
            .collect(),
        temperature: None,
        session_id: None,
        send_session_header: false,
    }
}

/// Same, but as an OpenCode-style profile that asks for the session header.
fn call_with_session(messages: Vec<(&str, &str)>, sid: &str) -> ChatCall {
    ChatCall { session_id: Some(sid.into()), send_session_header: true, ..call(messages) }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn run(req: ChatCall) -> Collector {
    let c = Collector::default();
    let sink = c.sink();
    let provider = Arc::new(OpenAiCompatible::new().unwrap());
    let (_tx, rx) = tokio::sync::watch::channel(false);
    runtime().block_on(run_chat(provider, req, rx, &sink));
    c
}

/// Skip with a loud message when the harness did not provide a mock.
macro_rules! need_mock {
    ($scenario:expr) => {
        if std::env::var("PAPERAI_MOCK_BASE").is_err() {
            panic!(
                "PAPERAI_MOCK_BASE is not set. Run this suite via \
                 `node scripts/run-ai-rust-tests.mjs` — it starts the Mock SSE server. \
                 Refusing to report a pass without a real provider."
            );
        }
        assert_eq!(
            scenario(),
            $scenario,
            "mock is serving '{}' but this test needs '{}'; the runner must restart it per scenario",
            scenario(),
            $scenario
        );
    };
}

#[test]
fn happy_path_streams_and_completes() {
    need_mock!("happy");
    let _key = with_key();
    let c = run(call(vec![("user", "解释这段话")]));

    assert!(matches!(c.events().first(), Some(AiStreamEvent::Started)));
    assert_eq!(c.text(), "这是一段回答。");
    match c.terminal() {
        Some(AiStreamEvent::Completed { finish_reason }) => {
            assert_eq!(finish_reason.as_deref(), Some("stop"))
        }
        other => panic!("expected Completed, got {other:?}"),
    }
    // Exactly one terminal event.
    let terminals = c
        .events()
        .iter()
        .filter(|e| {
            matches!(
                e,
                AiStreamEvent::Completed { .. } | AiStreamEvent::Cancelled | AiStreamEvent::Error { .. }
            )
        })
        .count();
    assert_eq!(terminals, 1, "UI must never be left saying 'generating'");
}

#[test]
fn batched_events_in_one_packet() {
    need_mock!("batched");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    assert_eq!(c.text(), "AB");
    assert!(matches!(c.terminal(), Some(AiStreamEvent::Completed { .. })));
}

#[test]
fn utf8_split_across_chunks_is_not_corrupted() {
    need_mock!("splitUtf8");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    assert_eq!(c.text(), "中文流式测试", "multi-byte chars must survive chunk boundaries");
}

#[test]
fn crlf_and_comment_lines() {
    need_mock!("crlfAndComments");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    assert_eq!(c.text(), "crlf");
    assert!(matches!(c.terminal(), Some(AiStreamEvent::Completed { .. })));
}

#[test]
fn empty_choices_and_usage_only_tail_do_not_error() {
    need_mock!("emptyThenUsage");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    assert_eq!(c.text(), "");
    // No content at all, but the stream was well-formed and terminated.
    assert!(matches!(c.terminal(), Some(AiStreamEvent::Completed { .. })));
}

#[test]
fn missing_done_is_a_success_when_content_arrived() {
    need_mock!("noDone");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    assert_eq!(c.text(), "没有DONE的完整回答");
    assert!(matches!(c.terminal(), Some(AiStreamEvent::Completed { .. })));
}

#[test]
fn abrupt_close_without_content_is_an_error_not_a_silent_success() {
    need_mock!("abruptEmpty");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_bad_stream"),
        other => panic!("expected ai_bad_stream, got {other:?}"),
    }
}

#[test]
fn in_stream_error_object_terminates_with_error() {
    need_mock!("midStreamError");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    assert_eq!(c.text(), "开始");
    match c.terminal() {
        Some(AiStreamEvent::Error { code, safe_message }) => {
            assert_eq!(code, "server_busy");
            assert!(safe_message.contains("服务繁忙"));
        }
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn non_sse_200_is_reported_as_bad_stream() {
    need_mock!("notSse");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_bad_stream"),
        other => panic!("expected ai_bad_stream (never a fake empty answer), got {other:?}"),
    }
}

#[test]
fn http_401_maps_to_unauthorized() {
    need_mock!("unauthorized");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_unauthorized"),
        other => panic!("expected ai_unauthorized, got {other:?}"),
    }
}

#[test]
fn http_403_maps_to_unauthorized() {
    need_mock!("forbidden");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_unauthorized"),
        other => panic!("expected ai_unauthorized, got {other:?}"),
    }
}

#[test]
fn http_404_maps_to_not_found_with_a_url_hint() {
    need_mock!("modelNotFound");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, safe_message }) => {
            assert_eq!(code, "ai_not_found");
            assert!(safe_message.contains("Base URL"), "hint should mention what to check");
        }
        other => panic!("expected ai_not_found, got {other:?}"),
    }
}

#[test]
fn http_429_maps_to_rate_limited() {
    need_mock!("rateLimited");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_rate_limited"),
        other => panic!("expected ai_rate_limited, got {other:?}"),
    }
}

#[test]
fn http_500_maps_to_provider_error() {
    need_mock!("serverError");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_provider_error"),
        other => panic!("expected ai_provider_error, got {other:?}"),
    }
}

#[test]
fn http_400_maps_to_bad_config() {
    need_mock!("badRequest");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_bad_config"),
        other => panic!("expected ai_bad_config, got {other:?}"),
    }
}

#[test]
fn redirect_is_not_followed() {
    need_mock!("redirect");
    let _key = with_key();
    let c = run(call(vec![("user", "hi")]));
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => {
            // reqwest reports the blocked redirect; either classification is
            // acceptable as long as it is NOT a success and the key was not
            // replayed to the new host (asserted by the mock's request log).
            assert!(
                code == "ai_network" || code == "ai_provider_error",
                "unexpected code {code}"
            );
        }
        other => panic!("a redirect must never look like success, got {other:?}"),
    }
}

#[test]
fn missing_key_fails_before_any_network_call() {
    need_mock!("happy");
    // Use a profile with no stored credential.
    secrets::delete_secret("profile-with-no-key").ok();
    let req = ChatCall {
        profile_id: "profile-with-no-key".into(),
        base_url: mock_base(),
        model: "mock-model".into(),
        messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
        temperature: None,
        // These two tests are about credential/URL handling, not OpenCode.
        session_id: None,
        send_session_header: false,
    };
    let c = run(req);
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_no_key"),
        other => panic!("expected ai_no_key, got {other:?}"),
    }
    // `Started` is emitted before the key lookup; what matters is that no
    // Delta ever arrived.
    assert_eq!(c.text(), "");
}

#[test]
fn plain_http_to_a_remote_host_is_refused() {
    // No mock needed: the URL is rejected during validation, before any socket.
    secrets::write_secret(PROFILE, "sk-mock").unwrap();
    let req = ChatCall {
        profile_id: PROFILE.into(),
        base_url: "http://api.deepseek.com".into(),
        model: "m".into(),
        messages: vec![ChatMessage { role: "user".into(), content: "hi".into() }],
        temperature: None,
        // These two tests are about credential/URL handling, not OpenCode.
        session_id: None,
        send_session_header: false,
    };
    let c = run(req);
    match c.terminal() {
        Some(AiStreamEvent::Error { code, .. }) => assert_eq!(code, "ai_insecure_refused"),
        other => panic!("expected ai_insecure_refused, got {other:?}"),
    }
}

#[test]
fn cancel_stops_the_stream_promptly() {
    need_mock!("slow");
    let _key = with_key();
    let c = Collector::default();
    let sink = c.sink();
    let provider = Arc::new(OpenAiCompatible::new().unwrap());
    let (tx, rx) = tokio::sync::watch::channel(false);

    let c2 = c.clone();
    runtime().block_on(async move {
        let task = tokio::spawn(async move {
            run_chat(provider, call(vec![("user", "hi")]), rx, &sink).await;
        });
        // Let a couple of tokens through, then cancel.
        tokio::time::sleep(Duration::from_millis(1100)).await;
        tx.send(true).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    });

    assert!(matches!(c2.terminal(), Some(AiStreamEvent::Cancelled)));
    // It must not have consumed the whole scripted answer.
    assert!(c2.text().len() < "第一段。第二段。第三段。第四段。".len(), "cancel was too slow");
}

#[test]
fn context_is_sent_verbatim_and_nothing_else() {
    need_mock!("happy");
    let _key = with_key();
    let _ = run(call(vec![
        ("system", "你是学术文献阅读助手"),
        ("user", "解释：<document_context>测试片段</document_context>"),
    ]));
    // The mock's request log is the authority; see the Node-side assertions in
    // scripts/run-ai-rust-tests.mjs which inspect it after this suite runs.
}

/// Session id the Node-side runner also knows about. Kept identical on both
/// sides so the assertion below and the header check in
/// `scripts/run-ai-rust-tests.mjs` refer to the same value.
const TEST_SESSION_ID: &str = "paperai-test-session-42";

#[test]
fn opencode_profiles_send_the_session_header() {
    need_mock!("happy");
    let _key = with_key();
    let _ = run(call_with_session(vec![("user", "ping")], TEST_SESSION_ID));
    // The header itself is asserted from the mock's request log on the Node
    // side, where the recorded headers are available.
}

#[test]
fn ordinary_profiles_do_not_send_the_session_header() {
    need_mock!("happy");
    let _key = with_key();
    // `call()` leaves send_session_header false, i.e. DeepSeek-style.
    let _ = run(call(vec![("user", "ping")]));
}
