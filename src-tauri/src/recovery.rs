//! Crash recovery for the document save pipeline (K-07).
//!
//! The save sequence is `temp -> verify -> backup -> rename(target,.old) ->
//! rename(temp,target) -> delete .old`. A crash between the two renames leaves
//! the user's file **missing** with their content sitting in `.paperai.old`.
//! Nothing is atomic about that, and this module does not pretend otherwise —
//! it exists so the situation is *detectable and recoverable* rather than
//! silent data loss.
//!
//! Design rules, all of them load-bearing:
//!
//! * **Never automatic.** Scanning is read-only and reports; restoring happens
//!   only when the caller passes an explicit choice. Silently moving files
//!   around on a user's disk is worse than the crash.
//! * **Validate before offering.** A candidate must exist, be non-trivial, have
//!   a `%PDF-` header and an `%%EOF` trailer. A truncated `.old` is reported as
//!   `recover_invalid` instead of being offered as a rescue.
//! * **Idempotent.** Restoring twice is harmless: the second call sees the
//!   target already present with the right hash and reports `recover_none`.
//! * **Never destroy the only good copy.** `keep-new` deletes the `.old` file;
//!   `restore-old` renames `.old` onto the target, but only after moving the
//!   current target aside to a `.superseded` name rather than deleting it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{codes, AppError, AppResult};
use crate::save_service::sha256_of_file;

/// Suffix used by the save pipeline for the pre-replace revision.
const OLD_SUFFIX: &str = "pdf.paperai.old";
/// Suffix used for the single-generation backup.
const BAK_SUFFIX: &str = "pdf.paperai.bak";
/// Suffix used when a recovery has to displace an existing target.
const SUPERSEDED_SUFFIX: &str = "pdf.paperai.superseded";
/// Prefix of our temp files.
const TMP_PREFIX: &str = ".paperai-tmp-";

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryCandidate {
    /// Absolute path of the candidate file.
    pub path: String,
    /// `old` | `bak` | `temp`
    pub kind: String,
    pub bytes: u64,
    pub valid_pdf: bool,
    pub sha256: String,
    /// Why it was rejected, when `valid_pdf` is false.
    pub invalid_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryReport {
    /// True when the target PDF itself is present.
    pub target_exists: bool,
    pub target_bytes: u64,
    pub target_sha256: String,
    /// Set when the target exists but does not parse as a PDF.
    pub target_invalid_reason: Option<String>,
    /// Candidates found, newest-looking first.
    pub candidates: Vec<RecoveryCandidate>,
    /// True when the target is missing and at least one valid candidate exists —
    /// i.e. the user's document disappeared and can be brought back.
    pub needs_recovery: bool,
    /// Files that look like our temp files and were left behind.
    pub leftover_temps: Vec<String>,
    /// Human-readable summary for the UI. Never contains a filesystem path
    /// outside the document's own directory.
    pub summary: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    /// Restore the `.old` revision over the target.
    RestoreOld,
    /// Delete the `.old` revision, keeping the current target.
    KeepNew,
    /// Delete leftover temp files only.
    CleanTemps,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryResult {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub target: String,
    pub restored_from: Option<String>,
    pub displaced_to: Option<String>,
}

fn with_suffix(target: &Path, suffix: &str) -> PathBuf {
    // Mirrors `Path::with_extension` as used by the save service: `foo.pdf` ->
    // `foo.pdf.paperai.old`.
    let mut p = target.to_path_buf();
    p.set_extension(suffix);
    p
}

/// Cheap, self-contained PDF plausibility check.
///
/// We do NOT fully parse: this runs on a file the app did not write, and a
/// parser bug must not be able to declare a corrupt file "good". Header +
/// trailer + a sane minimum size is what distinguishes "a PDF" from "a
/// fragment left by a crash".
fn inspect_pdf(path: &Path) -> (bool, u64, Option<String>) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return (false, 0, Some(format!("无法读取: {e}"))),
    };
    let len = meta.len();
    if len < 32 {
        return (false, len, Some("文件过小，不是完整 PDF".into()));
    }
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => return (false, len, Some(format!("无法读取内容: {e}"))),
    };
    if &bytes[..5] != b"%PDF-" {
        return (false, len, Some("缺少 %PDF- 文件头".into()));
    }
    let tail = &bytes[len.saturating_sub(4096) as usize..];
    if !tail.windows(5).any(|w| w == b"%%EOF") {
        return (false, len, Some("缺少 %%EOF 结束标记（文件可能被截断）".into()));
    }
    (true, len, None)
}

/// Read-only scan. Safe to call on every open.
pub fn scan(target_path: &str) -> RecoveryReport {
    let target = PathBuf::from(crate::paths::clean_arg(target_path));
    let dir = target.parent().map(Path::to_path_buf);

    let (target_valid, target_bytes, target_invalid) = if target.exists() {
        let (ok, len, why) = inspect_pdf(&target);
        (ok, len, if ok { None } else { why })
    } else {
        (false, 0, None)
    };

    let mut candidates: Vec<RecoveryCandidate> = Vec::new();
    let mut temps: Vec<String> = Vec::new();

    if let Some(dir) = dir.as_deref() {
        for (suffix, kind) in [(OLD_SUFFIX, "old"), (BAK_SUFFIX, "bak")] {
            let p = with_suffix(&target, suffix);
            if !p.exists() {
                continue;
            }
            let (ok, len, why) = inspect_pdf(&p);
            candidates.push(RecoveryCandidate {
                path: p.to_string_lossy().to_string(),
                kind: kind.to_string(),
                bytes: len,
                valid_pdf: ok,
                // Only hash a file we are willing to offer; hashing a corrupt
                // multi-hundred-MB file would just stall the UI.
                sha256: if ok { sha256_of_file(&p).unwrap_or_default() } else { String::new() },
                invalid_reason: why,
            });
        }

        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with(TMP_PREFIX) {
                    temps.push(e.path().to_string_lossy().to_string());
                }
            }
        }
    }

    // A `.old` is the interesting one: it is the revision displaced by a save
    // that may not have completed.
    let valid_old = candidates.iter().any(|c| c.kind == "old" && c.valid_pdf);
    let needs_recovery = !target.exists() && valid_old;

    let summary = if !target.exists() && valid_old {
        "未找到原文档，但存在一份可恢复的上一版本".to_string()
    } else if !target.exists() && !candidates.is_empty() {
        "未找到原文档，且找到的副本不是完整 PDF".to_string()
    } else if target.exists() && valid_old {
        "文档存在，同时保留了一份可回退的上一版本".to_string()
    } else if !temps.is_empty() {
        format!("发现 {} 个遗留临时文件", temps.len())
    } else {
        "无需恢复".to_string()
    };

    RecoveryReport {
        target_exists: target.exists(),
        target_bytes,
        target_sha256: if target_valid {
            sha256_of_file(&target).unwrap_or_default()
        } else {
            String::new()
        },
        target_invalid_reason: target_invalid,
        candidates,
        needs_recovery,
        leftover_temps: temps,
        summary,
    }
}

/// Apply an explicit user choice. Idempotent.
pub fn apply(target_path: &str, action: RecoveryAction) -> AppResult<RecoveryResult> {
    let target = PathBuf::from(crate::paths::clean_arg(target_path));
    let old = with_suffix(&target, OLD_SUFFIX);

    match action {
        RecoveryAction::CleanTemps => {
            let mut removed = 0usize;
            if let Some(dir) = target.parent() {
                if let Ok(entries) = fs::read_dir(dir) {
                    for e in entries.flatten() {
                        if e.file_name().to_string_lossy().starts_with(TMP_PREFIX) {
                            if fs::remove_file(e.path()).is_ok() {
                                removed += 1;
                            }
                        }
                    }
                }
            }
            Ok(RecoveryResult {
                ok: true,
                code: "cleaned".into(),
                message: format!("已清理 {removed} 个临时文件"),
                target: target.to_string_lossy().to_string(),
                restored_from: None,
                displaced_to: None,
            })
        }

        RecoveryAction::KeepNew => {
            if !old.exists() {
                // Idempotent: already done, or nothing was ever staged.
                return Ok(RecoveryResult {
                    ok: true,
                    code: codes::RECOVER_NONE.into(),
                    message: "没有需要删除的上一版本".into(),
                    target: target.to_string_lossy().to_string(),
                    restored_from: None,
                    displaced_to: None,
                });
            }
            if !target.exists() {
                // Deleting the only surviving copy would be data loss. Refuse
                // and tell the user to restore instead.
                return Err(AppError::new(
                    codes::RECOVER_INVALID,
                    "原文档不存在；删除上一版本会造成数据丢失，请改为「恢复上一版本」",
                ));
            }
            let (ok, _, why) = inspect_pdf(&target);
            if !ok {
                return Err(AppError::new(
                    codes::RECOVER_INVALID,
                    format!(
                        "当前文档不是完整 PDF（{}）；删除上一版本会造成数据丢失，请改为「恢复上一版本」",
                        why.unwrap_or_else(|| "未知原因".into())
                    ),
                ));
            }
            fs::remove_file(&old).map_err(|e| AppError::new(codes::RECOVER_WRITE, format!("删除失败: {e}")))?;
            Ok(RecoveryResult {
                ok: true,
                code: "kept_new".into(),
                message: "已保留当前文档并删除上一版本".into(),
                target: target.to_string_lossy().to_string(),
                restored_from: None,
                displaced_to: None,
            })
        }

        RecoveryAction::RestoreOld => {
            if !old.exists() {
                // Idempotent: a second call after a successful restore lands here.
                return Ok(RecoveryResult {
                    ok: true,
                    code: codes::RECOVER_NONE.into(),
                    message: "没有可恢复的上一版本".into(),
                    target: target.to_string_lossy().to_string(),
                    restored_from: None,
                    displaced_to: None,
                });
            }
            let (ok, _, why) = inspect_pdf(&old);
            if !ok {
                return Err(AppError::new(
                    codes::RECOVER_INVALID,
                    format!("上一版本不是完整 PDF：{}", why.unwrap_or_else(|| "未知原因".into())),
                ));
            }

            // Never overwrite a healthy target without keeping it. If the
            // target is missing or itself unreadable we just place the restore.
            let mut displaced: Option<String> = None;
            if target.exists() {
                let superseded = with_suffix(&target, SUPERSEDED_SUFFIX);
                let _ = fs::remove_file(&superseded); // best effort: replace an older supersede
                fs::rename(&target, &superseded).map_err(|e| {
                    AppError::new(
                        codes::RECOVER_WRITE,
                        format!("目标文件被占用，无法替换（未做任何改动）: {e}"),
                    )
                })?;
                displaced = Some(superseded.to_string_lossy().to_string());
            }

            if let Err(e) = fs::rename(&old, &target) {
                // Put the displaced file back so the user is not left with
                // nothing.
                if let Some(d) = displaced.as_deref() {
                    let _ = fs::rename(d, &target);
                }
                return Err(AppError::new(codes::RECOVER_WRITE, format!("恢复失败: {e}")));
            }

            // Verify the thing we just put in place.
            let (ok, len, why) = inspect_pdf(&target);
            if !ok {
                return Err(AppError::new(
                    codes::RECOVER_INVALID,
                    format!(
                        "恢复后的文件未能通过校验（{}）；当前内容位于 {}",
                        why.unwrap_or_else(|| "未知原因".into()),
                        displaced.as_deref().unwrap_or("(原位置)")
                    ),
                ));
            }

            Ok(RecoveryResult {
                ok: true,
                code: "restored".into(),
                message: format!("已恢复上一版本（{len} 字节）"),
                target: target.to_string_lossy().to_string(),
                restored_from: Some(old.to_string_lossy().to_string()),
                displaced_to: displaced,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A byte string that passes `inspect_pdf`.
    fn fake_pdf(tag: &str) -> Vec<u8> {
        let mut v = b"%PDF-1.6\n".to_vec();
        v.extend_from_slice(tag.as_bytes());
        v.extend_from_slice(b"\n% padding padding padding padding\n%%EOF\n");
        v
    }

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("paperai-recovery-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_target_with_valid_old_needs_recovery() {
        let d = tmpdir("missing-old");
        let target = d.join("paper.pdf");
        fs::write(with_suffix(&target, OLD_SUFFIX), fake_pdf("OLD")).unwrap();

        let r = scan(&target.to_string_lossy());
        assert!(!r.target_exists);
        assert!(r.needs_recovery, "summary={}", r.summary);
        assert!(r.candidates.iter().any(|c| c.kind == "old" && c.valid_pdf));
    }

    #[test]
    fn truncated_old_is_reported_invalid_not_offered() {
        let d = tmpdir("truncated-old");
        let target = d.join("paper.pdf");
        // Header, but no %%EOF: exactly what a crash mid-write leaves.
        fs::write(with_suffix(&target, OLD_SUFFIX), b"%PDF-1.6\npartial").unwrap();

        let r = scan(&target.to_string_lossy());
        assert!(!r.needs_recovery, "a truncated file must not be offered");
        let c = r.candidates.iter().find(|c| c.kind == "old").unwrap();
        assert!(!c.valid_pdf);
        assert!(c.invalid_reason.is_some());
        assert!(c.sha256.is_empty(), "must not hash a file we would not restore");
    }

    #[test]
    fn restore_old_puts_the_old_revision_back() {
        let d = tmpdir("restore");
        let target = d.join("paper.pdf");
        fs::write(with_suffix(&target, OLD_SUFFIX), fake_pdf("OLD")).unwrap();

        let res = apply(&target.to_string_lossy(), RecoveryAction::RestoreOld).unwrap();
        assert!(res.ok);
        assert!(target.exists());
        let body = fs::read(&target).unwrap();
        assert!(String::from_utf8_lossy(&body).contains("OLD"));
        assert!(!with_suffix(&target, OLD_SUFFIX).exists());
    }

    #[test]
    fn restore_is_idempotent() {
        let d = tmpdir("idempotent");
        let target = d.join("paper.pdf");
        fs::write(with_suffix(&target, OLD_SUFFIX), fake_pdf("OLD")).unwrap();

        let first = apply(&target.to_string_lossy(), RecoveryAction::RestoreOld).unwrap();
        assert_eq!(first.code, "restored");
        let second = apply(&target.to_string_lossy(), RecoveryAction::RestoreOld).unwrap();
        assert!(second.ok);
        assert_eq!(second.code, codes::RECOVER_NONE);
        assert!(target.exists(), "the restored file must survive a second call");
    }

    #[test]
    fn restore_displaces_rather_than_deletes_a_healthy_target() {
        let d = tmpdir("displace");
        let target = d.join("paper.pdf");
        fs::write(&target, fake_pdf("NEW")).unwrap();
        fs::write(with_suffix(&target, OLD_SUFFIX), fake_pdf("OLD")).unwrap();

        let res = apply(&target.to_string_lossy(), RecoveryAction::RestoreOld).unwrap();
        assert_eq!(res.code, "restored");
        let displaced = PathBuf::from(res.displaced_to.expect("must report where the new one went"));
        assert!(displaced.exists(), "the previous content must not be deleted");
        assert!(String::from_utf8_lossy(&fs::read(&displaced).unwrap()).contains("NEW"));
        assert!(String::from_utf8_lossy(&fs::read(&target).unwrap()).contains("OLD"));
    }

    #[test]
    fn keep_new_refuses_to_delete_the_only_surviving_copy() {
        let d = tmpdir("keep-new-guard");
        let target = d.join("paper.pdf");
        fs::write(with_suffix(&target, OLD_SUFFIX), fake_pdf("OLD")).unwrap();
        // Target is missing entirely.

        let err = apply(&target.to_string_lossy(), RecoveryAction::KeepNew).unwrap_err();
        assert_eq!(err.code, codes::RECOVER_INVALID);
        assert!(with_suffix(&target, OLD_SUFFIX).exists(), "must not have deleted it");
    }

    #[test]
    fn keep_new_deletes_old_when_the_target_is_healthy() {
        let d = tmpdir("keep-new-ok");
        let target = d.join("paper.pdf");
        fs::write(&target, fake_pdf("NEW")).unwrap();
        fs::write(with_suffix(&target, OLD_SUFFIX), fake_pdf("OLD")).unwrap();

        let res = apply(&target.to_string_lossy(), RecoveryAction::KeepNew).unwrap();
        assert_eq!(res.code, "kept_new");
        assert!(!with_suffix(&target, OLD_SUFFIX).exists());
        assert!(String::from_utf8_lossy(&fs::read(&target).unwrap()).contains("NEW"));
    }

    #[test]
    fn restore_refuses_an_invalid_old() {
        let d = tmpdir("restore-invalid");
        let target = d.join("paper.pdf");
        fs::write(with_suffix(&target, OLD_SUFFIX), b"%PDF-1.6\ntruncated").unwrap();

        let err = apply(&target.to_string_lossy(), RecoveryAction::RestoreOld).unwrap_err();
        assert_eq!(err.code, codes::RECOVER_INVALID);
        assert!(!target.exists(), "nothing should have been put in place");
    }

    #[test]
    fn clean_temps_removes_only_our_temp_files() {
        let d = tmpdir("temps");
        let target = d.join("paper.pdf");
        fs::write(&target, fake_pdf("X")).unwrap();
        fs::write(d.join(format!("{TMP_PREFIX}123-456-0")), b"junk").unwrap();
        fs::write(d.join(format!("{TMP_PREFIX}123-456-1")), b"junk").unwrap();
        fs::write(d.join("unrelated.tmp"), b"keep me").unwrap();

        let r = scan(&target.to_string_lossy());
        assert_eq!(r.leftover_temps.len(), 2);

        apply(&target.to_string_lossy(), RecoveryAction::CleanTemps).unwrap();
        assert!(!d.join(format!("{TMP_PREFIX}123-456-0")).exists());
        assert!(d.join("unrelated.tmp").exists(), "must not touch other temp files");
        assert!(target.exists());
    }

    #[test]
    fn scan_on_a_healthy_document_reports_nothing_to_do() {
        let d = tmpdir("healthy");
        let target = d.join("paper.pdf");
        fs::write(&target, fake_pdf("OK")).unwrap();

        let r = scan(&target.to_string_lossy());
        assert!(r.target_exists);
        assert!(!r.needs_recovery);
        assert!(r.candidates.is_empty());
        assert!(r.leftover_temps.is_empty());
        assert!(r.target_invalid_reason.is_none());
        assert_eq!(r.summary, "无需恢复");
    }

    #[test]
    fn a_corrupt_target_is_flagged() {
        let d = tmpdir("corrupt-target");
        let target = d.join("paper.pdf");
        fs::write(&target, b"not a pdf at all, but long enough to pass the size check").unwrap();

        let r = scan(&target.to_string_lossy());
        assert!(r.target_exists);
        assert!(r.target_invalid_reason.is_some());
        assert!(r.target_sha256.is_empty());
    }
}
