//! AI layer: provider abstraction, streaming, secrets and profile settings.
//!
//! Layering rule (mirrors the PDF side): the frontend never touches a key, and
//! never talks HTTP. It sends visible text plus a `profile_id`; Rust resolves
//! the credential, builds the request, streams the answer back over a Channel,
//! and returns only sanitised error codes.

pub mod client;
pub mod config;
pub mod memory;
pub mod provider;
pub mod secrets;
pub mod session;
pub mod settings;
pub mod stream;
pub mod types;

pub use types::*;

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::error::{codes, AppError};
use provider::{ChatCall, OpenAiCompatible, Provider};
use session::SessionRegistry;

/// Managed state: the provider instance, and the cancellation registry.
pub struct AiState {
    provider: Arc<OpenAiCompatible>,
    sessions: Arc<SessionRegistry>,
}

impl AiState {
    pub fn new() -> crate::error::AppResult<Self> {
        Ok(Self {
            provider: Arc::new(OpenAiCompatible::new()?),
            sessions: Arc::new(SessionRegistry::new()),
        })
    }

    /// Exposed so the tests and diagnostics can inspect in-flight work.
    pub fn sessions(&self) -> &Arc<SessionRegistry> {
        &self.sessions
    }
}

// ------------------------------------------------------------------ commands

/// List profiles with their credential *state* (never the key itself).
#[tauri::command]
pub fn ai_list_profiles() -> Vec<ProfileStatus> {
    settings::load().iter().map(settings::status_of).collect()
}

/// The provider presets the UI offers. Every base URL in here was taken from the
/// provider's own documentation and checked against its live `/models`
/// endpoint — see `settings::presets`.
#[tauri::command]
pub fn ai_provider_presets() -> Vec<AiProfile> {
    settings::presets()
}

/// Fetch a provider's live model catalogue so the user picks from what the
/// provider currently serves rather than from a list baked into this build.
///
/// `profile_id` is optional so the catalogue can be browsed **before** anything
/// is saved — OpenCode's endpoints answer unauthenticated, which is what makes
/// it possible to look at the free models first. When a profile *is* given, its
/// stored key is used.
///
/// Key-scoping rule: a credential is only ever read for a saved profile, so the
/// stored key cannot be aimed at a host the user never configured. Passing no
/// profile means an unauthenticated request, not "use some key".
#[tauri::command]
pub async fn ai_list_models(
    state: State<'_, AiState>,
    base_url: String,
    profile_id: Option<String>,
    send_session_header: Option<bool>,
) -> Result<Vec<ModelOption>, AppError> {
    // Validate before the network so a bad URL fails fast with a precise code.
    config::normalize_base_url(&base_url)?;

    let (credential_id, session_header) = match profile_id {
        Some(id) if !id.trim().is_empty() => {
            let p = settings::get(&id)?;
            (Some(p.credential_id), p.sends_session_header)
        }
        _ => (None, send_session_header.unwrap_or(false)),
    };

    provider::list_models(
        state.provider.http(),
        credential_id.as_deref(),
        &base_url,
        session_header,
    )
    .await
}

/// Create or update a profile. Base URL is validated and normalised here.
#[tauri::command]
pub fn ai_save_profile(profile: AiProfile) -> Result<ProfileStatus, AppError> {
    let saved = settings::upsert(profile)?;
    Ok(settings::status_of(&saved))
}

/// Delete a profile, optionally removing its stored credential too.
#[tauri::command]
pub fn ai_delete_profile(id: String, delete_credential: bool) -> Result<(), AppError> {
    settings::remove(&id, delete_credential)
}

/// Store (or replace) the API key for a profile.
///
/// There is deliberately no command that returns the key: the UI can only learn
/// whether one exists, via `ProfileStatus::has_key`.
#[tauri::command]
pub fn ai_set_key(profile_id: String, key: String) -> Result<(), AppError> {
    // Require the profile to exist first, so a typo cannot create an orphan
    // credential the UI would never show or clean up.
    let p = settings::get(&profile_id)?;
    secrets::write_secret(&p.credential_id, key.trim())
}

/// Remove the stored key for a profile.
#[tauri::command]
pub fn ai_delete_key(profile_id: String) -> Result<(), AppError> {
    let p = settings::get(&profile_id)?;
    secrets::delete_secret(&p.credential_id)
}

/// Whether a key exists for a profile, without exposing it.
#[tauri::command]
pub fn ai_has_key(profile_id: String) -> Result<bool, AppError> {
    let p = settings::get(&profile_id)?;
    Ok(secrets::has_secret(&p.credential_id))
}

/// User-initiated connectivity probe. Sends exactly one 1-token request.
#[tauri::command]
pub async fn ai_test_connection(
    state: State<'_, AiState>,
    profile_id: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<ConnectionTest, AppError> {
    let p = settings::get(&profile_id)?;
    let base = base_url.unwrap_or_else(|| p.base_url.clone());
    let mdl = model.unwrap_or_else(|| p.model.clone());
    // Validate before touching the network so a bad value fails fast with a
    // precise code instead of a generic network error.
    config::normalize_base_url(&base)?;
    if mdl.trim().is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "模型名不能为空"));
    }
    Ok(provider::probe_connection(
        state.provider.http(),
        &p.credential_id,
        &base,
        &mdl,
        p.sends_session_header,
    )
    .await)
}

/// One complete answer, collected server-side instead of streamed.
///
/// Used by the reading-memory pipeline: it must hold the *whole* reply before
/// writing anything, and a half-received chunk note stored as if it were
/// complete would poison the notes permanently. It reuses `run_chat` — same
/// request path, same SSE parser, same timeout rules — and only differs in that
/// the sink collects instead of forwarding.
#[tauri::command]
pub async fn ai_ask_once(
  state: State<'_, AiState>,
  profile_id: String,
  messages: Vec<ChatMessage>,
) -> Result<String, AppError> {
  let p = settings::get(&profile_id)?;
  let (_tx, rx) = tokio::sync::watch::channel(false);
  let collected = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
  let sink_out = std::sync::Arc::clone(&collected);

  let call = ChatCall {
    profile_id: p.credential_id.clone(),
    base_url: p.base_url.clone(),
    model: p.model.clone(),
    messages,
    temperature: None,
    // A per-call id keeps prompt caching as effective as the chat path's.
    session_id: Some(format!("paperai-notes-{}", p.id)),
    send_session_header: p.sends_session_header,
  };

  {
    let out = sink_out;
    let sink = move |ev: AiStreamEvent| {
      if let AiStreamEvent::Delta { text } = ev {
        if let Ok(mut s) = out.lock() {
          s.push_str(&text);
        }
      }
    };
    provider::run_chat(std::sync::Arc::clone(&state.provider), call, rx, &sink).await;
  }

  let text = collected.lock().map(|s| s.clone()).unwrap_or_default();
  if text.trim().is_empty() {
    return Err(AppError::new(
      codes::AI_BAD_STREAM,
      "模型没有返回任何内容，无法生成笔记",
    ));
  }
  Ok(text)
}

/// The reading-memory sidecar for a document, if it has one.
///
/// Takes the *PDF's* path and derives everything else, so the frontend cannot
/// aim a write at an arbitrary location.
#[tauri::command]
pub fn ai_memory_read(pdf_path: String) -> Result<Option<memory::MemoryFile>, AppError> {
  memory::read_memory(std::path::Path::new(&pdf_path))
}

/// Replace a document's reading memory with `body`.
#[tauri::command]
pub fn ai_memory_write(pdf_path: String, body: String) -> Result<memory::MemoryFile, AppError> {
  memory::write_memory(std::path::Path::new(&pdf_path), &body)
}

/// Append one Q&A entry to the reading memory (used after whole-document
/// answers, so notes accumulate without re-summarising the paper).
#[tauri::command]
pub fn ai_memory_append(
  pdf_path: String,
  heading: String,
  entry: String,
) -> Result<memory::MemoryFile, AppError> {
  memory::append_entry(std::path::Path::new(&pdf_path), &heading, &entry)
}

/// Start a streamed completion.
///
/// Returns as soon as the task is spawned; the answer arrives on `sink` tagged
/// with the caller's `request_id`. The caller must ignore deltas whose id is no
/// longer current (document switch / new question).
#[tauri::command]
pub async fn ai_start_chat(
    state: State<'_, AiState>,
    request_id: String,
    profile_id: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
    // Stable per-conversation id from the frontend. Sent as
    // `x-opencode-session` for profiles that ask for it (see
    // `AiProfile::sends_session_header`). It is a random conversation id, not a
    // credential, and is never logged.
    session_id: Option<String>,
    sink: Channel<AiStreamEvent>,
) -> Result<(), AppError> {
    if request_id.trim().is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "request_id 不能为空"));
    }
    if messages.is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "消息不能为空"));
    }
    if messages.iter().all(|m| m.content.trim().is_empty()) {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "消息内容不能为空"));
    }

    let profile = settings::get(&profile_id)?;
    // Fail fast and cheaply when there is no key, rather than opening a socket
    // to learn it from a 401.
    secrets::read_secret(&profile.credential_id)?;

    let cancel = state.sessions.register(&request_id);
    let sessions = Arc::clone(&state.sessions);
    let provider = Arc::clone(&state.provider);
    let id_for_cleanup = request_id.clone();

    let call = provider::ChatCall {
        profile_id: profile.credential_id.clone(),
        base_url: profile.base_url.clone(),
        model: profile.model.clone(),
        messages,
        temperature,
        session_id,
        send_session_header: profile.sends_session_header,
    };

    let fut = provider.clone().start_chat(call, sink, cancel);
    // Spawn so the IPC call returns immediately and a long answer never holds
    // the command's future (and therefore the UI) open.
    tauri::async_runtime::spawn(async move {
        fut.await;
        sessions.unregister(&id_for_cleanup);
    });

    Ok(())
}

/// Cancel a running request. Returns whether it was actually running.
#[tauri::command]
pub fn ai_cancel_chat(state: State<'_, AiState>, request_id: String) -> bool {
    state.sessions.cancel(&request_id)
}

/// Cancel everything — used when the window closes.
#[tauri::command]
pub fn ai_cancel_all(state: State<'_, AiState>) -> usize {
    state.sessions.cancel_all()
}

/// How many requests are currently in flight (diagnostics / tests).
#[tauri::command]
pub fn ai_active_requests(state: State<'_, AiState>) -> usize {
    state.sessions.active_count()
}
