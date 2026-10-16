//! PaperAI desktop backend.

// Public so the integration tests in `tests/` can drive the provider against
// the local Mock SSE server, and the save/recovery pipeline against real files,
// without going through the Tauri IPC layer.
pub mod ai;

mod commands;
mod error;
mod paths;
pub mod recovery;
pub mod save_service;

use std::sync::Mutex;

use error::AppError;
use paths::resolve_pdf_path;
use tauri::{Emitter, Manager, RunEvent};

/// Files handed to us by the OS before the WebView was ready.
///
/// Both the startup argv and the single-instance callback can fire while the
/// frontend is still booting; events emitted at that point are lost. The
/// frontend drains this queue once it signals readiness.
pub struct PendingFiles(Mutex<Vec<String>>);

impl PendingFiles {
    fn push(&self, paths: Vec<String>) {
        if paths.is_empty() {
            return;
        }
        if let Ok(mut g) = self.0.lock() {
            for p in paths {
                if !g.contains(&p) {
                    g.push(p);
                }
            }
        }
    }

    fn take(&self) -> Vec<String> {
        self.0.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default()
    }
}

/// Event name the frontend listens to for "another instance asked us to open
/// these files".
pub const OPEN_FILES_EVENT: &str = "paperai://open-files";

/// Append one line to the app's audit log.
///
/// Release builds use the Windows GUI subsystem, so `println!` is invisible;
/// a log file is the only way to verify what the shell actually handed us.
/// Never logs document content — only paths and lifecycle events.
pub fn audit(msg: &str) {
    use std::io::Write;
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let dir = std::path::Path::new(&base).join("PaperAI");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("paperai.log"))
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

/// Extract PDF paths from a raw argv slice (argv[0] is the executable).
fn pdf_paths_from_argv(argv: &[String], cwd: Option<&std::path::Path>) -> Vec<String> {
    let mut out = Vec::new();
    audit(&format!("argv = {:?}", argv));
    for a in argv.iter().skip(1) {
        if a.starts_with("--") || a.starts_with('-') {
            continue;
        }
        match resolve_pdf_path(a, cwd) {
            Ok(p) => out.push(p.to_string_lossy().to_string()),
            Err(e) => audit(&format!("  rejected {:?}: {}", a, e)),
        }
    }
    out
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Windows refuses to steal foreground focus in many cases; we do what
        // the platform allows and record the real behaviour in the report.
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup: Vec<String> = {
        let argv: Vec<String> = std::env::args_os().map(|s| s.to_string_lossy().into_owned()).collect();
        let cwd = std::env::current_dir().ok();
        pdf_paths_from_argv(&argv, cwd.as_deref())
    };

    let startup_for_setup = startup.clone();

    // Build the AI state before the builder so a missing HTTP client fails
    // loudly at startup rather than on the user's first question.
    let ai_state = ai::AiState::new().expect("failed to initialise AI state");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let found = pdf_paths_from_argv(&argv, Some(std::path::Path::new(&cwd)));
            audit(&format!("single-instance: {} file(s) forwarded", found.len()));
            if found.is_empty() {
                focus_main_window(app);
                return;
            }
            eprintln!("[PaperAI] single-instance forwarded: {:?}", found);
            app.state::<PendingFiles>().push(found.clone());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.emit(OPEN_FILES_EVENT, found);
            }
            focus_main_window(app);
        }))
        .manage(PendingFiles(Mutex::new(startup.clone())))
        .manage(ai_state)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::open_pdf,
            commands::read_pdf_file,
            commands::stat_path,
            commands::sha256_of,
            commands::save_document,
            commands::take_pending_files,
            commands::scan_save_recovery,
            commands::apply_save_recovery,
            ai::ai_list_profiles,
            ai::ai_provider_presets,
            ai::ai_list_models,
            ai::ai_save_profile,
            ai::ai_delete_profile,
            ai::ai_set_key,
            ai::ai_delete_key,
            ai::ai_has_key,
            ai::ai_test_connection,
            ai::ai_ask_once,
            ai::ai_memory_read,
            ai::ai_memory_write,
            ai::ai_memory_append,
            ai::ai_start_chat,
            ai::ai_cancel_chat,
            ai::ai_cancel_all,
            ai::ai_active_requests,
        ])
        .setup(move |_app| {
            if !startup_for_setup.is_empty() {
                eprintln!("[PaperAI] startup argv files: {:?}", startup_for_setup);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building PaperAI");

    app.run(|_handle, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // Dirty-state protection is handled in the frontend, which can
            // veto the close via the window API.
        }
    });
}

/// Helper used by tests/docs: report a friendly error for a bad path.
#[allow(dead_code)]
fn describe(err: &AppError) -> String {
    format!("{}: {}", err.code, err.message)
}
