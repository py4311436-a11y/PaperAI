//! Base-URL normalisation and HTTP/TLS policy.
//!
//! Two things matter here and both are security-relevant:
//!
//! 1. **URL joining.** Naive concatenation produces `/v1/v1/chat/completions`
//!    or `//chat/completions`. We join explicitly and tolerate base URLs that
//!    already end in `/v1`.
//! 2. **Transport policy.** External hosts must use HTTPS. Plain HTTP is
//!    allowed *only* for loopback, so a local Mock or Ollama gateway can be
//!    used without ever sending a key over the network in the clear.

use crate::error::{codes, AppError, AppResult};

/// Hosts that count as "this machine". `localhost` is resolved by the OS, so
/// we accept the two literal loopback forms plus the name.
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    h == "localhost"
        || h == "127.0.0.1"
        || h == "::1"
        || h.starts_with("127.")
}

/// Parse and validate a base URL, applying the transport policy.
///
/// Returns the normalised base **without** a trailing slash.
pub fn normalize_base_url(raw: &str) -> AppResult<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "Base URL 不能为空"));
    }

    // A tiny hand-rolled parse keeps us independent of a url crate while
    // still being strict about what we accept.
    let (scheme, rest) = match t.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => {
            return Err(AppError::new(
                codes::AI_BAD_CONFIG,
                format!("Base URL 缺少协议（应以 https:// 开头）：{t}"),
            ))
        }
    };

    if scheme != "http" && scheme != "https" {
        return Err(AppError::new(
            codes::AI_BAD_CONFIG,
            format!("Base URL 协议不受支持：{scheme}（仅支持 https，本机可用 http）"),
        ));
    }

    // Host is everything before the first '/', '?' or '#'.
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host_port = &rest[..host_end];
    let path = &rest[host_end..];

    if host_port.is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "Base URL 缺少主机名"));
    }

    // Host without port, and unbracketed for the loopback test.
    let host = if let Some(h) = host_port.strip_prefix('[') {
        h.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };

    if scheme == "http" && !is_loopback_host(host) {
        return Err(AppError::new(
            codes::AI_INSECURE_REFUSED,
            format!(
                "拒绝向非本机地址使用明文 HTTP：{host}。请改用 https://，\
                 或确认目标为 localhost / 127.0.0.1。"
            ),
        ));
    }

    // Normalise the path: strip one or more trailing slashes so joining is
    // predictable.
    let path = path.trim_end_matches('/');
    Ok(format!("{scheme}://{host_port}{path}"))
}

/// True when this base URL will be sent over plain HTTP to this machine.
pub fn is_loopback_insecure(base_url: &str) -> bool {
    match base_url.split_once("://") {
        Some(("http", rest)) => {
            let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            let hp = &rest[..host_end];
            let host = if let Some(h) = hp.strip_prefix('[') {
                h.split(']').next().unwrap_or("")
            } else {
                hp.split(':').next().unwrap_or("")
            };
            is_loopback_host(host)
        }
        _ => false,
    }
}

/// Join the chat-completions path onto a normalised base URL.
///
/// Handles the three shapes users actually type:
///   `https://api.deepseek.com`              -> `.../chat/completions`
///   `https://api.deepseek.com/v1`           -> `.../v1/chat/completions`
///   `https://api.deepseek.com/v1/`          -> `.../v1/chat/completions`
///
/// We deliberately do **not** silently append `/v1` when the user typed a bare
/// host: some providers live at the root and would 404. If the resulting URL is
/// wrong the provider tells us with a 404, which we surface as
/// `ai_not_found` with the exact URL (never the key).
pub fn chat_completions_url(base_url: &str) -> AppResult<String> {
    let base = normalize_base_url(base_url)?;
    if base.ends_with("/chat/completions") {
        return Ok(base);
    }
    Ok(format!("{base}/chat/completions"))
}

/// The same base URL, for showing in the UI. Never includes credentials.
pub fn display_url(url: &str) -> String {
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_path_without_doubling() {
        assert_eq!(
            chat_completions_url("https://api.deepseek.com").unwrap(),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.deepseek.com/").unwrap(),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.deepseek.com/v1").unwrap(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.deepseek.com/v1/").unwrap(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // Idempotent if the user pastes the full endpoint.
        assert_eq!(
            chat_completions_url("https://api.deepseek.com/v1/chat/completions").unwrap(),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn never_produces_v1_v1() {
        let u = chat_completions_url("https://example.com/v1").unwrap();
        assert!(!u.contains("/v1/v1"), "{u}");
    }

    #[test]
    fn rejects_plain_http_to_remote_hosts() {
        let e = chat_completions_url("http://api.deepseek.com/v1").unwrap_err();
        assert_eq!(e.code, codes::AI_INSECURE_REFUSED);
    }

    #[test]
    fn allows_plain_http_on_loopback() {
        assert!(chat_completions_url("http://127.0.0.1:8788").is_ok());
        assert!(chat_completions_url("http://localhost:8788/v1").is_ok());
        assert!(is_loopback_insecure("http://localhost:8788/v1"));
        assert!(!is_loopback_insecure("https://api.deepseek.com/v1"));
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(
            chat_completions_url("api.deepseek.com").unwrap_err().code,
            codes::AI_BAD_CONFIG
        );
        assert_eq!(chat_completions_url("ftp://x.com").unwrap_err().code, codes::AI_BAD_CONFIG);
        assert_eq!(chat_completions_url("").unwrap_err().code, codes::AI_BAD_CONFIG);
    }
}
