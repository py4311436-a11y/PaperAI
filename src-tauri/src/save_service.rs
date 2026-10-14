//! DocumentSaveService — the ONLY place PaperAI writes to disk.
//!
//! Guarantee we aim for (and describe honestly in SAVE_SAFETY_DESIGN.md):
//!   a failed save must leave the original file byte-identical and leave a
//!   recoverable copy behind.
//!
//! Sequence:
//!   1. validate target + writable
//!   2. unique temp file *in the same directory/volume* as the target
//!   3. write -> flush -> sync_all
//!   4. verify the temp file (size, %PDF- header, %%EOF trailer)
//!   5. backup the original (optional, user policy)
//!   6. safe replace:  target -> target.old  ->  temp -> target  ->  drop .old
//!      (Windows `rename` cannot overwrite, hence the two-step dance)
//!   7. sha256 of the final file
//!
//! `rename` on Windows is NOT atomic across volumes and offers no crash
//! guarantee; the backup + .old file is what makes the operation recoverable.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{codes, AppError, AppResult};

/// Fault injection is only honoured when this env var is set, so a production
/// build can never be tricked into destroying a document.
const FAULT_ENV: &str = "PAPERAI_ALLOW_FAULT_INJECTION";

#[derive(Debug, Deserialize)]
pub struct SaveRequest {
    /// Absolute path of the file to (over)write.
    pub target_path: String,
    /// PDF bytes, base64 encoded (JSON-safe transport).
    pub data_base64: String,
    /// Keep a `<target>.paperai.bak` copy of the previous revision.
    #[serde(default = "default_true")]
    pub make_backup: bool,
    /// Optional fault injection; ignored unless FAULT_ENV is set.
    #[serde(default)]
    pub inject_failure: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveResult {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub target: String,
    pub bytes: u64,
    pub sha256: String,
    pub backup_path: Option<String>,
    /// Set when a temp file could not be removed — recorded, never hidden.
    pub leftover_temp: Option<String>,
}

pub fn sha256_of_file(path: &Path) -> AppResult<String> {
    let bytes = fs::read(path)?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(format!("{:x}", h.finalize()))
}

fn unique_temp(dir: &Path) -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".paperai-tmp-{}-{}-{}", std::process::id(), nanos, n))
}

fn injection_allowed() -> bool {
    std::env::var(FAULT_ENV).map(|v| v == "1").unwrap_or(false)
}

/// Verify that `path` really looks like a complete PDF before we let it
/// replace the user's document.
fn verify_pdf_file(path: &Path, expected_len: usize) -> AppResult<()> {
    let meta = fs::metadata(path).map_err(|_| AppError::new(codes::SAVE_TEMP_MISSING, "临时文件不存在"))?;
    if meta.len() as usize != expected_len {
        return Err(AppError::new(
            codes::SAVE_TEMP_INVALID,
            format!("临时文件大小不符: {} != {}", meta.len(), expected_len),
        ));
    }
    let bytes = fs::read(path)?;
    if bytes.len() < 5 || &bytes[..5] != b"%PDF-" {
        return Err(AppError::new(codes::SAVE_TEMP_INVALID, "临时文件缺少 %PDF- 头"));
    }
    let tail = &bytes[bytes.len().saturating_sub(2048)..];
    if !twoway_find(tail, b"%%EOF").is_some() {
        return Err(AppError::new(codes::SAVE_TEMP_INVALID, "临时文件缺少 %%EOF 尾"));
    }
    Ok(())
}

fn twoway_find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn cleanup(path: &Path) -> Option<String> {
    match fs::remove_file(path) {
        Ok(()) => None,
        Err(_) => Some(path.to_string_lossy().to_string()),
    }
}

/// Clean up `temp`, then fail — the leftover path (if any) is reported so a
/// stranded temp file is never silently forgotten.
fn fail<T>(code: &str, msg: impl Into<String>, temp: Option<&Path>) -> AppResult<T> {
    let leftover = match temp {
        Some(p) if p.exists() => cleanup(p),
        _ => None,
    };
    let mut m = msg.into();
    if let Some(l) = leftover {
        m.push_str(&format!(" (未清理临时文件: {})", l));
    }
    Err(AppError::new(code, m))
}

/// Execute the full safe-save pipeline. Never panics; always returns a result.
pub fn save_pdf(req: SaveRequest) -> SaveResult {
    match save_pdf_inner(req) {
        Ok(r) => r,
        Err(e) => SaveResult {
            ok: false,
            code: e.code.clone(),
            message: e.message.clone(),
            target: String::new(),
            bytes: 0,
            sha256: String::new(),
            backup_path: None,
            leftover_temp: None,
        },
    }
}

fn save_pdf_inner(req: SaveRequest) -> AppResult<SaveResult> {
    // ---- 0. fault injection (test builds only) ----------------------------
    let inject = req.inject_failure.clone().unwrap_or_default();
    let inject = inject.trim().to_ascii_lowercase();
    if !inject.is_empty() && inject != "none" {
        if !injection_allowed() {
            return Err(AppError::new(
                codes::SAVE_INJECTION_DISABLED,
                "故障注入未启用（需设置 PAPERAI_ALLOW_FAULT_INJECTION=1）",
            ));
        }
    }

    // ---- 1. decode + basic validation -------------------------------------
    if req.data_base64.is_empty() {
        return Err(AppError::new(codes::SAVE_NO_DATA, "没有待保存的数据"));
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(req.data_base64.trim())
        .map_err(|_| AppError::new(codes::SAVE_NO_DATA, "数据 base64 解码失败"))?;
    if data.len() < 5 || &data[..5] != b"%PDF-" {
        return Err(AppError::new(codes::SAVE_TEMP_INVALID, "待保存数据不是 PDF"));
    }

    let target = PathBuf::from(crate::paths::clean_arg(&req.target_path));
    let dir = target
        .parent()
        .filter(|p| p.is_dir())
        .ok_or_else(|| AppError::new(codes::SAVE_NO_DIR, "目标目录不存在"))?
        .to_path_buf();

    // ---- 2. writability ----------------------------------------------------
    if !crate::paths::is_writable_target(&target)? {
        return Err(AppError::new(
            codes::SAVE_TARGET_READONLY,
            format!("目标文件只读或被占用: {}", target.display()),
        ));
    }

    // Injected fault: pretend the target was read-only from the start.
    if inject == "target_readonly" {
        return Err(AppError::new(
            codes::SAVE_INJECTED,
            "注入故障: 目标只读 — 原件未改动",
        ));
    }

    // ---- 3. temp file on the same volume ----------------------------------
    let temp = unique_temp(&dir);
    let leftover_temp: Option<String> = None;

    if inject == "temp_create" {
        return Err(AppError::new(codes::SAVE_INJECTED, "注入故障: 临时文件创建失败 — 原件未改动"));
    }

    let mut f = fs::File::create(&temp)
        .map_err(|e| AppError::new(codes::SAVE_TEMP_CREATE, format!("无法创建临时文件: {}", e)))?;

    if inject == "temp_write" {
        drop(f);
        return fail(codes::SAVE_INJECTED, "注入故障: 临时文件写入失败 — 原件未改动", Some(&temp));
    }

    if let Err(e) = f
        .write_all(&data)
        .and_then(|_| f.flush())
        .and_then(|_| f.sync_all())
    {
        drop(f);
        return fail(codes::SAVE_TEMP_WRITE, format!("写入临时文件失败: {}", e), Some(&temp));
    }
    drop(f);

    // ---- 4. verify the temp file ------------------------------------------
    if let Err(e) = verify_pdf_file(&temp, data.len()) {
        return fail(&e.code, e.message, Some(&temp));
    }

    // ---- 5. backup ---------------------------------------------------------
    let mut backup_path: Option<String> = None;
    if req.make_backup && target.exists() {
        let bak = target.with_extension("pdf.paperai.bak");
        match fs::copy(&target, &bak) {
            Ok(_) => backup_path = Some(bak.to_string_lossy().to_string()),
            Err(e) => return fail(codes::SAVE_BACKUP, format!("备份原件失败: {}", e), Some(&temp)),
        }
    }

    // ---- 6. safe replace ---------------------------------------------------
    if inject == "replace" {
        return fail(codes::SAVE_INJECTED, "注入故障: 替换步骤失败 — 原件未改动", Some(&temp));
    }

    let old = target.with_extension("pdf.paperai.old");
    let mut staged = false;
    if target.exists() {
        // Free the path first: Windows rename cannot overwrite.
        if let Err(e) = fs::rename(&target, &old) {
            return fail(
                codes::SAVE_TARGET_LOCKED,
                format!("目标被占用/无法移动 ({}). 原件未改动", e),
                Some(&temp),
            );
        }
        staged = true;
    }

    match fs::rename(&temp, &target) {
        Ok(()) => {
            if staged {
                let _ = fs::remove_file(&old);
            }
        }
        Err(e) => {
            // Roll the original back before reporting failure.
            let restored = if staged {
                fs::rename(&old, &target).is_ok()
            } else {
                true
            };
            return Err(if restored {
                fail::<()>(codes::SAVE_REPLACE, format!("替换目标失败，已恢复原件: {}", e), Some(&temp))
                    .unwrap_err()
            } else {
                fail::<()>(
                    codes::SAVE_RESTORE_FAILED,
                    format!("替换失败且恢复原件失败! 副本保留在 {}", old.display()),
                    Some(&temp),
                )
                .unwrap_err()
            });
        }
    }

    // ---- 7. final hash -----------------------------------------------------
    let final_meta = fs::metadata(&target)?;
    let sha = sha256_of_file(&target).unwrap_or_default();

    Ok(SaveResult {
        ok: true,
        code: "saved".to_string(),
        message: "已保存".to_string(),
        target: target.to_string_lossy().to_string(),
        bytes: final_meta.len(),
        sha256: sha,
        backup_path,
        leftover_temp,
    })
}
