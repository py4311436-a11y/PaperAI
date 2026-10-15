//! Tauri IPC commands.
//!
//! Least privilege: the frontend never gets a general file-system handle. It
//! can only (a) read a path that came from the picker / OS shell, and
//! (b) ask the save service to write an explicit target the user chose.

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Response;

use crate::error::{codes, AppError, AppResult};
use crate::paths::{inspect_path, resolve_pdf_path, PathInfo, MAX_PDF_BYTES};
use crate::save_service::{save_pdf, SaveRequest, SaveResult};

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "PaperAI".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    }
}

/// Read a PDF that was already validated by [`open_pdf`].
/// Returns raw bytes (not JSON) so multi-MB documents stay fast.
#[tauri::command]
pub async fn read_pdf_file(path: String) -> AppResult<Response> {
    let p = resolve_pdf_path(&path, None)?;
    let bytes = std::fs::read(&p)?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(AppError::new(codes::TOO_LARGE, "文件超过大小限制"));
    }
    Ok(Response::new(bytes))
}

/// Validate + normalise a path coming from the shell/CLI/picker.
#[tauri::command]
pub fn open_pdf(path: String) -> AppResult<OpenedFile> {
    let p = resolve_pdf_path(&path, None)?;
    let meta = std::fs::metadata(&p)?;
    Ok(OpenedFile {
        path: p.to_string_lossy().to_string(),
        name: p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        size: meta.len(),
        readonly: meta.permissions().readonly(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub readonly: bool,
}

#[tauri::command]
pub fn stat_path(path: String) -> PathInfo {
    inspect_path(&path)
}

#[tauri::command]
pub fn sha256_of(path: String) -> AppResult<String> {
    let p = PathBuf::from(crate::paths::clean_arg(&path));
    crate::save_service::sha256_of_file(&p)
}

/// The single write path. See `save_service::save_pdf`.
#[tauri::command]
pub fn save_document(req: SaveRequest) -> SaveResult {
    save_pdf(req)
}

/// Drain files handed over by single-instance / startup argv.
#[tauri::command]
pub fn take_pending_files(state: tauri::State<'_, crate::PendingFiles>) -> Vec<String> {
    state.take()
}

/// Read-only scan for a recoverable save (K-07). Safe to call on every open.
///
/// Reports; never touches the filesystem. Restoring requires an explicit
/// [`apply_save_recovery`] call with the user's choice.
#[tauri::command]
pub fn scan_save_recovery(path: String) -> crate::recovery::RecoveryReport {
    crate::recovery::scan(&path)
}

/// Apply the user's explicit recovery choice. Idempotent.
#[tauri::command]
pub fn apply_save_recovery(
    path: String,
    action: crate::recovery::RecoveryAction,
) -> AppResult<crate::recovery::RecoveryResult> {
    crate::recovery::apply(&path, action)
}
