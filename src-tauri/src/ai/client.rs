//! HTTP client and error classification.
//!
//! Security posture:
//! * TLS verification is never disabled; `reqwest` is built with `rustls-tls`
//!   and we do not call any `danger_*` builder.
//! * Redirects are disabled. Some CDNs redirect a `/chat/completions` to
//!   another host, and `reqwest` would replay the `Authorization` header to it.
//!   Turning redirects off makes that impossible rather than merely unlikely.
//! * Timeouts are explicit and cover connect, first token and idle gaps.

use std::time::Duration;

use crate::error::{codes, AppError, AppResult};

use super::config::{chat_completions_url, normalize_base_url};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const FIRST_TOKEN_TIMEOUT: Duration = Duration::from_secs(60);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Build the shared client. Cheap to clone (it is an `Arc` inside).
pub fn build_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(IDLE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("PaperAI/", env!("CARGO_PKG_VERSION")))
        // Explicitly keep the default (verified) TLS behaviour.
        .use_rustls_tls()
        .build()
        .map_err(|e| AppError::new(codes::AI_NETWORK, format!("HTTP 客户端初始化失败：{e}")))
}

/// Classify a transport error into one of our stable codes.
pub fn classify_transport(e: &reqwest::Error) -> AppError {
    if e.is_timeout() {
        return AppError::new(codes::AI_TIMEOUT, "连接或响应超时");
    }
    if e.is_connect() {
        return AppError::new(codes::AI_NETWORK, "无法连接到服务（请检查网络或 Base URL）");
    }
    if e.is_redirect() {
        return AppError::new(
            codes::AI_NETWORK,
            "服务返回了重定向；为避免把 API Key 发往其他主机，已拒绝跟随。请直接填写最终 Base URL。",
        );
    }
    AppError::new(codes::AI_NETWORK, format!("网络错误：{e}"))
}

/// Pull the provider's own machine-readable error token out of a body.
///
/// Most OpenAI-compatible gateways return something like
/// `{"error":{"message":"...","code":"inference_failed","type":"..."}}`, and the
/// code is the part that actually explains the failure. A raw 240-character
/// excerpt of JSON, on its own, makes the user read through JSON to find it.
pub fn provider_error_code(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let err = v.get("error").unwrap_or(&v);
    for key in ["code", "type"] {
        if let Some(s) = err.get(key).and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// The provider's human-readable message, when it sent one.
pub fn provider_error_message(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let err = v.get("error").unwrap_or(&v);
    for key in ["message", "detail", "description"] {
        if let Some(s) = err.get(key).and_then(|x| x.as_str()) {
            let t: String = s.chars().filter(|c| !c.is_control() || *c == ' ').collect();
            let t = t.trim();
            if !t.is_empty() {
                return Some(t.chars().take(200).collect());
            }
        }
    }
    None
}

/// Classify a non-2xx status. `body` is only used for a *sanitised* excerpt.
pub fn classify_status(status: u16, body: &str) -> AppError {
    let hint = safe_excerpt(body);
    let why = provider_error_code(body)
        .map(|c| format!("服务给出的原因：{c}。"))
        .unwrap_or_default();
    match status {
        401 => AppError::new(codes::AI_UNAUTHORIZED, "API Key 无效或已过期（401）"),
        // NOT "your key is wrong". OpenCode's gateway answers 403 with
        // `inference_failed` when an *upstream provider* refuses the request,
        // which is a completely different problem with a completely different
        // fix. Telling the user to re-check their key sends them down the wrong
        // path for an hour. Name both possibilities and let the provider's own
        // code break the tie.
        403 => AppError::new(
            codes::AI_UNAUTHORIZED,
            format!(
                "服务拒绝了该请求（403）。{why}这不一定是密钥问题：网关也用 403 表示\
                 上游推理服务拒绝了请求。若上面有服务自身的错误码，以它为准。{hint}"
            ),
        ),
        404 => AppError::new(
            codes::AI_NOT_FOUND,
            format!("接口或模型不存在（404）。请检查 Base URL 与模型名。{hint}"),
        ),
        429 => AppError::new(codes::AI_RATE_LIMITED, "请求过于频繁或额度不足（429）"),
        s if (500..600).contains(&s) => {
            AppError::new(codes::AI_PROVIDER_ERROR, format!("服务端错误（{s}）{hint}"))
        }
        400 => AppError::new(
            codes::AI_BAD_CONFIG,
            format!("请求被拒绝（400）。{hint}"),
        ),
        other => AppError::new(codes::AI_PROVIDER_ERROR, format!("服务返回 {other}{hint}")),
    }
}

/// A short, sanitised excerpt of a provider error body.
///
/// A JSON error body is preferred in its own words: the provider's `message`
/// beats 240 characters of raw JSON with the useful part buried in the middle.
/// Raw text is still used when the body is not JSON.
fn safe_excerpt(body: &str) -> String {
    if let Some(m) = provider_error_message(body) {
        return format!(" 服务返回：{m}");
    }
    let cleaned: String = body
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .take(240)
        .collect();
    let t = cleaned.trim();
    if t.is_empty() {
        String::new()
    } else {
        format!(" 服务返回：{t}")
    }
}

/// Everything needed to open a streamed completion.
pub struct StreamTarget {
    pub url: String,
    pub base_url: String,
}

pub fn resolve_target(base_url: &str) -> AppResult<StreamTarget> {
    let normalized = normalize_base_url(base_url)?;
    let url = chat_completions_url(&normalized)?;
    Ok(StreamTarget { url, base_url: normalized })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_status_codes() {
        assert_eq!(classify_status(401, "").code, codes::AI_UNAUTHORIZED);
        assert_eq!(classify_status(403, "").code, codes::AI_UNAUTHORIZED);
        assert_eq!(classify_status(404, "").code, codes::AI_NOT_FOUND);
        assert_eq!(classify_status(429, "").code, codes::AI_RATE_LIMITED);
        assert_eq!(classify_status(500, "").code, codes::AI_PROVIDER_ERROR);
        assert_eq!(classify_status(503, "").code, codes::AI_PROVIDER_ERROR);
        assert_eq!(classify_status(418, "").code, codes::AI_PROVIDER_ERROR);
    }

    #[test]
    fn excerpt_is_bounded_and_control_chars_stripped() {
        let long = "x".repeat(1000);
        let s = safe_excerpt(&long);
        assert!(s.chars().count() <= 260, "too long: {}", s.chars().count());
        let with_ctrl = safe_excerpt("bad\u{0}thing\nhere");
        assert!(!with_ctrl.contains('\u{0}'));
        assert!(!with_ctrl.contains('\n'));
    }

    #[test]
    fn empty_body_yields_no_hint() {
        assert_eq!(safe_excerpt("   "), "");
    }

    #[test]
    fn resolve_target_normalises() {
        let t = resolve_target("https://api.deepseek.com/v1/").unwrap();
        assert_eq!(t.url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(t.base_url, "https://api.deepseek.com/v1");
    }

    /// The real body from an OpenCode gateway refusal, which is what prompted
    /// all of this: the console showed `403 Rejected / inference_failed`.
    const OPENCODE_403: &str = r#"{"error":{"message":"upstream provider refused the request","code":"inference_failed","type":"upstream_error"}}"#;

    #[test]
    fn extracts_the_providers_own_error_code() {
        assert_eq!(provider_error_code(OPENCODE_403).as_deref(), Some("inference_failed"));
        // Flat shapes, as some gateways use.
        assert_eq!(
            provider_error_code(r#"{"code":"model_not_found"}"#).as_deref(),
            Some("model_not_found")
        );
        // Nothing to find is not an error.
        assert_eq!(provider_error_code("not json"), None);
        assert_eq!(provider_error_code(r#"{"error":{}}"#), None);
    }

    #[test]
    fn excerpt_prefers_the_providers_own_words_over_raw_json() {
        let e = safe_excerpt(OPENCODE_403);
        assert!(e.contains("upstream provider refused"), "{e}");
        assert!(
            !e.contains('{'),
            "the user should not have to read JSON to find the reason: {e}"
        );
    }

    /// The bug this fixes: 403 was reported as "your key lacks permission",
    /// which sends the user to re-check a key that may be perfectly fine.
    #[test]
    fn a_403_does_not_assert_the_key_is_the_problem() {
        let e = classify_status(403, OPENCODE_403);
        let m = e.message;
        assert!(!m.contains("无权限"), "still blames the key: {m}");
        assert!(m.contains("inference_failed"), "does not surface the real reason: {m}");
        assert!(m.contains("上游"), "does not mention the other possibility: {m}");
    }

    #[test]
    fn a_401_still_means_the_key() {
        // Not weakened: a genuine auth failure must still say so.
        assert!(classify_status(401, "").message.contains("API Key"));
    }

    #[test]
    fn host_of_never_leaks_the_path() {
        assert_eq!(crate::ai::config::host_of("https://opencode.ai/inference/go/v1"), "opencode.ai");
        assert_eq!(crate::ai::config::host_of("https://api.deepseek.com"), "api.deepseek.com");
        assert_eq!(crate::ai::config::host_of("http://127.0.0.1:8788/v1"), "127.0.0.1:8788");
        // A tenant id or token in the path must not reach the log file.
        let h = crate::ai::config::host_of("https://gw.example.com/v1/tenant-42?key=abc");
        assert!(!h.contains("tenant-42") && !h.contains("abc"), "{h}");
        assert_eq!(crate::ai::config::host_of("garbage"), "(unparsed)");
    }

    #[test]
    fn client_builds_without_disabling_tls() {
        // Smoke test: construction must not panic or need any danger_* option.
        assert!(build_client().is_ok());
    }
}
