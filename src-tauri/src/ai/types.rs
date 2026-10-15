//! Shared types for the AI layer.
//!
//! These are the wire shapes between Rust and the frontend. They deliberately
//! contain **no secrets**: the API key never appears in any of them.

use serde::{Deserialize, Serialize};

/// A provider profile as persisted on disk. Note there is no key field — the
/// key lives in Windows Credential Manager under `credential_id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiProfile {
    pub id: String,
    pub display_name: String,
    /// e.g. `https://api.deepseek.com` — normalised on save.
    pub base_url: String,
    /// Fully editable; never hard-coded to a specific shipped model.
    pub model: String,
    /// Name of the Credential Manager entry holding the key.
    pub credential_id: String,
    /// Whether this profile is the default one.
    #[serde(default)]
    pub is_default: bool,
}

/// What the UI is allowed to know about a profile's credential state.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileStatus {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub model: String,
    pub is_default: bool,
    /// True when a secret exists locally. The value itself is never exposed.
    pub has_key: bool,
    /// Loopback + plain HTTP: shown in the UI as "本地非加密连接".
    pub is_loopback_insecure: bool,
}

/// A chat message as sent by the frontend. `role` is validated in Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Everything needed to start one streamed completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub request_id: String,
    pub profile_id: String,
    pub messages: Vec<ChatMessage>,
    /// Optional per-request overrides — kept minimal on purpose.
    #[serde(default)]
    pub temperature: Option<f32>,
}

/// Inclusive, serialisable mirror of the channel events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Started,
    Delta { text: String },
    Completed { finish_reason: Option<String> },
    Cancelled,
    Error { code: String, safe_message: String },
}

/// Result of `test_connection`.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionTest {
    pub ok: bool,
    pub code: String,
    /// Safe, human readable. Never contains the key or a raw provider body.
    pub message: String,
    /// Round-trip milliseconds when `ok`.
    pub elapsed_ms: u64,
    /// Model echoed back by the provider when it told us.
    pub model_echo: Option<String>,
}

/// Token/character accounting for a built context, surfaced in the UI before
/// anything is sent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextStats {
    pub chars: usize,
    /// Rough estimate, clearly labelled as such in the UI.
    pub approx_tokens: usize,
    pub truncated: bool,
    pub pages_sent: Vec<u32>,
}
