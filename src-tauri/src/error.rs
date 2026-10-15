//! Unified error model.
//!
//! Every failure surfaced to the frontend carries a stable machine-readable
//! `code` plus a human `message`. Codes are used by the automated tests, so
//! they must not change casually.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    /// Stable machine-readable code (see `codes` below).
    pub code: String,
    /// Human readable, localised-ish message safe to show in the UI.
    pub message: String,
}

pub mod codes {
    pub const PATH_EMPTY: &str = "path_empty";
    pub const PATH_NOT_FOUND: &str = "path_not_found";
    pub const PATH_NOT_FILE: &str = "path_not_file";
    pub const PATH_NOT_PDF: &str = "path_not_pdf";
    pub const PATH_INVALID: &str = "path_invalid";
    pub const IO: &str = "io";
    pub const TOO_LARGE: &str = "too_large";

    pub const SAVE_NO_DATA: &str = "save_no_data";
    pub const SAVE_NO_DIR: &str = "save_no_parent_dir";
    pub const SAVE_TEMP_CREATE: &str = "save_temp_create";
    pub const SAVE_TEMP_WRITE: &str = "save_temp_write";
    pub const SAVE_TEMP_MISSING: &str = "save_temp_missing";
    pub const SAVE_TEMP_INVALID: &str = "save_temp_invalid";
    pub const SAVE_TARGET_READONLY: &str = "save_target_readonly";
    pub const SAVE_TARGET_LOCKED: &str = "save_target_locked";
    pub const SAVE_BACKUP: &str = "save_backup";
    pub const SAVE_REPLACE: &str = "save_replace";
    pub const SAVE_RESTORE_FAILED: &str = "save_restore_failed";
    pub const SAVE_INJECTED: &str = "save_injected_fault";
    pub const SAVE_INJECTION_DISABLED: &str = "save_injection_disabled";

    // --- save recovery (K-07) ---
    pub const RECOVER_NONE: &str = "recover_none";
    pub const RECOVER_CANDIDATE: &str = "recover_candidate";
    pub const RECOVER_INVALID: &str = "recover_invalid";
    pub const RECOVER_TARGET_EXISTS: &str = "recover_target_exists";
    pub const RECOVER_WRITE: &str = "recover_write";

    // --- AI layer ---
    /// No API key stored for the requested profile.
    pub const AI_NO_KEY: &str = "ai_no_key";
    /// The profile id does not exist.
    pub const AI_NO_PROFILE: &str = "ai_no_profile";
    /// Provider configuration is unusable (bad URL, empty model, ...).
    pub const AI_BAD_CONFIG: &str = "ai_bad_config";
    /// Plain HTTP to a non-loopback host was refused.
    pub const AI_INSECURE_REFUSED: &str = "ai_insecure_refused";
    /// Could not establish a connection in time.
    pub const AI_TIMEOUT: &str = "ai_timeout";
    /// First byte of the stream did not arrive in time.
    pub const AI_FIRST_TOKEN_TIMEOUT: &str = "ai_first_token_timeout";
    /// 401 / 403 from the provider.
    pub const AI_UNAUTHORIZED: &str = "ai_unauthorized";
    /// 404 (usually a wrong model or base URL).
    pub const AI_NOT_FOUND: &str = "ai_not_found";
    /// 429.
    pub const AI_RATE_LIMITED: &str = "ai_rate_limited";
    /// 5xx.
    pub const AI_PROVIDER_ERROR: &str = "ai_provider_error";
    /// DNS / TLS / connection reset.
    pub const AI_NETWORK: &str = "ai_network";
    /// Response was not the SSE dialect we support.
    pub const AI_BAD_STREAM: &str = "ai_bad_stream";
    /// Request was cancelled by the user.
    pub const AI_CANCELLED: &str = "ai_cancelled";
    /// Context exceeded the configured limit.
    pub const AI_CONTEXT_TOO_LARGE: &str = "ai_context_too_large";
    /// Windows Credential Manager failure.
    pub const AI_SECRET_STORE: &str = "ai_secret_store";
    /// Catch-all.
    pub const AI_INTERNAL: &str = "ai_internal";
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(codes::IO, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
