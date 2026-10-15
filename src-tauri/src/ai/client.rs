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

/// Classify a non-2xx status. `body` is only used for a *sanitised* excerpt.
pub fn classify_status(status: u16, body: &str) -> AppError {
    let hint = safe_excerpt(body);
    match status {
        401 => AppError::new(codes::AI_UNAUTHORIZED, "API Key 无效或已过期（401）"),
        403 => AppError::new(codes::AI_UNAUTHORIZED, "API Key 无权限访问该服务（403）"),
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
/// Providers sometimes echo request details; we cap the length, strip control
/// characters, and the caller never logs it at info level.
fn safe_excerpt(body: &str) -> String {
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

    #[test]
    fn client_builds_without_disabling_tls() {
        // Smoke test: construction must not panic or need any danger_* option.
        assert!(build_client().is_ok());
    }
}
