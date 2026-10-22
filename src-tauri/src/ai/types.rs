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
    /// Send a stable `x-opencode-session` header on every request.
    ///
    /// OpenCode's gateway asks every client to identify the conversation this
    /// way ("Send a stable session ID in `x-opencode-session` for each
    /// conversation so we can optimize routing and prompt caching"), and its
    /// docs warn that requests without it may start failing. It is a
    /// per-profile flag rather than host sniffing so the behaviour is visible
    /// and switchable. The value is a random id for the conversation — never a
    /// credential — so nothing here is a secret.
    #[serde(default)]
    pub sends_session_header: bool,
    /// Per-image token charge, where the provider documents one.
    ///
    /// `None` means unknown — and unknown must stay `None`. A number here is
    /// shown to the user as the cost of an image, so a guess would be a lie with
    /// a decimal point on it. Only providers that publish a flat per-image cap
    /// get one; providers that tile by resolution cannot be summarised by a
    /// single number at all, because the cost depends on the image.
    #[serde(default)]
    pub image_tokens: Option<u32>,
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
    pub sends_session_header: bool,
    /// Per-image token charge, when the provider documents one.
    ///
    /// Surfaced so the UI can turn "7 张截图" into a number the user can act on.
    /// `None` for providers whose image cost depends on the image itself, which
    /// is most of them — see the note on `AiProfile`.
    pub image_tokens: Option<u32>,
}

/// One entry from a provider's model catalogue.
#[derive(Debug, Clone, Serialize)]
pub struct ModelOption {
    pub id: String,
    /// `chat` — known to work with the OpenAI-compatible `/chat/completions`
    /// endpoint this app speaks.
    /// `incompatible` — served by the provider on a different protocol
    /// (`/messages`, `/responses`), so selecting it here would fail.
    /// `unknown` — the provider does not distinguish; the usual case, and
    /// normally fine.
    pub compatibility: String,
    /// **Inferred**, not authoritative: true when the id ends in `-free`.
    ///
    /// OpenCode's catalogue endpoint returns only `id / object / created /
    /// owned_by` — there is no price field to read — so the name is the only
    /// signal available. The UI labels it as a guess for that reason. It is
    /// used solely to sort free models to the top of the list; nothing
    /// downstream depends on it.
    pub free_hint: bool,
}

/// An image reference inside a multimodal message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImageUrl {
    /// A `data:` URL (base64 inline) or an `https://` URL.
    ///
    /// Validated in Rust before the request goes out — see
    /// `provider::validate_images`. Plain `http://` is refused: it would put
    /// the user's document on the wire in cleartext.
    pub url: String,
    /// `low` / `high` / `auto`, when the provider supports the knob.
    ///
    /// Omitted rather than defaulted: DeepSeek documents `low` as a 512×512
    /// downscale, and sending an unrecognised value is a 400 on stricter
    /// gateways. Absence is the portable choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// One block of a multimodal message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

/// Message content — plain text, or a sequence of blocks.
///
/// Untagged, so a text-only message still serialises as a bare JSON string.
/// That is not cosmetic. Providers match on the request prefix, and the
/// document message has to stay byte-identical between turns for the cache to
/// hold — which it only does if it keeps the exact shape it always had. A
/// caller that assembles the document as a one-element block list would
/// otherwise turn every turn into a cache miss without any visible symptom.
/// `provider::content_value` enforces the collapse, so the shape does not
/// depend on the caller remembering.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Parts(Vec<ContentPart>),
}

impl Content {
    /// Plain text, concatenated. Used for logging and emptiness checks — never
    /// for the wire, where the block structure has to survive.
    pub fn text(&self) -> String {
        match self {
            Content::Text(s) => s.clone(),
            Content::Parts(parts) => parts
                .iter()
                .map(|p| match p {
                    ContentPart::Text { text } => text.as_str(),
                    ContentPart::ImageUrl { .. } => "",
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }

    /// True when there is neither text nor an image.
    ///
    /// An image-only message is legitimate — "what is in this figure" with no
    /// other words — so images count as content here.
    pub fn is_empty(&self) -> bool {
        match self {
            Content::Text(s) => s.trim().is_empty(),
            Content::Parts(parts) => parts.iter().all(|p| match p {
                ContentPart::Text { text } => text.trim().is_empty(),
                ContentPart::ImageUrl { image_url } => image_url.url.trim().is_empty(),
            }),
        }
    }

    pub fn image_count(&self) -> usize {
        match self {
            Content::Text(_) => 0,
            Content::Parts(parts) => parts
                .iter()
                .filter(|p| matches!(p, ContentPart::ImageUrl { .. }))
                .count(),
        }
    }

    /// Bytes of inline image payload, used to keep the audit log answerable
    /// when a gateway rejects an oversized body. Counts the base64 characters
    /// of `data:` URLs only; a remote URL contributes nothing to the body.
    pub fn image_payload_bytes(&self) -> usize {
        match self {
            Content::Text(_) => 0,
            Content::Parts(parts) => parts
                .iter()
                .filter_map(|p| match p {
                    ContentPart::ImageUrl { image_url } => Some(image_url.url.len()),
                    ContentPart::Text { .. } => None,
                })
                .sum(),
        }
    }
}

/// Ergonomic constructors, so the common "just text" case stays a one-liner at
/// every call site instead of forcing `Content::Text(...)` into places that
/// have nothing to do with multimodality.
impl From<&str> for Content {
    fn from(s: &str) -> Self {
        Content::Text(s.to_string())
    }
}

impl From<String> for Content {
    fn from(s: String) -> Self {
        Content::Text(s)
    }
}

/// A chat message as sent by the frontend. `role` is validated in Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Content,
    /// Set on an assistant message that asked to call tools.
    ///
    /// Separate from `content` because the protocol treats them separately: the
    /// model may return text *and* a call, and the arguments are a JSON string,
    /// not prose to be parsed out of an answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// Set on a `tool` message: which call it answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// One function call requested by the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    /// Always `function` today. Kept because the wire format requires it.
    #[serde(rename = "type", default = "function_kind")]
    pub kind: String,
    pub function: FunctionCall,
}

fn function_kind() -> String {
    "function".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    /// JSON-encoded arguments, verbatim from the model. Not parsed here: the
    /// caller validates them against the tool it offered, and a parse failure
    /// there is a refusal, not a crash.
    pub arguments: String,
}

/// A tool offered to the model for one request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    #[serde(rename = "type", default = "function_kind")]
    pub kind: String,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments.
    pub parameters: serde_json::Value,
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
    /// Tools the model may call. Absent means the request is plain chat, which
    /// is every path except the page-refetch loop.
    #[serde(default)]
    pub tools: Option<Vec<ToolDef>>,
}

/// Inclusive, serialisable mirror of the channel events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Started,
    Delta { text: String },
    /// The model's thinking, as it thinks it.
    ///
    /// Never part of the answer: the UI shows it while the model works so the
    /// wait reads as work rather than as a hang, and drops it the moment the
    /// answer starts. It is not appended to `Delta`, because a reader who
    /// copied the answer would get the thinking with it.
    Reasoning { text: String },
    /// The model has been thinking for longer than the content deadline allows,
    /// and has produced nothing.
    ///
    /// Not an error: the deadline exists to stop a stream that has died, and a
    /// model that is visibly still thinking has not died. Emitted so the UI can
    /// put the choice to the reader — keep waiting, or stop — instead of the
    /// app deciding for them.
    Stalled { waited_secs: u64 },
    Completed { finish_reason: Option<String> },
    Cancelled,
    Error { code: String, safe_message: String },
    /// The model asked to call tools instead of (or as well as) answering.
    ///
    /// Terminal: the request is over and the caller decides what to do. Emitted
    /// as a structured field, never as text in `Delta` — a document that spells
    /// out a call inside its own body cannot reach this variant.
    ToolCalls { calls: Vec<ToolCall> },
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
