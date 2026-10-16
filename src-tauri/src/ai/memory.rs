//! Per-document reading memory: a Markdown sidecar next to the PDF.
//!
//! Why it exists: a whole-document question has to fit in one context window.
//! A long paper does not, so the app either truncates (and says so) or answers
//! from a summary the model no longer has in front of it. This module stores
//! that summary on disk so it survives the conversation *and* the next launch:
//! re-open the same PDF and the notes come back as prior context.
//!
//! # Safety rules, in order of importance
//!
//! 1. **Never clobber a file we did not write.** A target that exists without
//!    [`MARKER`] is refused. Someone's `paper.pdf.paperai-notes.md` full of
//!    their own hand-written notes must never be replaced by generated text.
//! 2. **Write beside the document, nowhere else.** The path is derived from the
//!    PDF path; there is no way to ask for an arbitrary destination.
//! 3. **Bounded.** [`MAX_MEMORY_BYTES`] caps a file, so a runaway loop of
//!    appends cannot fill a disk.
//! 4. **Atomic-ish.** Content goes to a sibling temp file and is then renamed
//!    over the target, matching `recovery.rs`: a crash mid-write leaves the
//!    previous notes intact rather than a half-written file.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{codes, AppError, AppResult};

/// Appended to the PDF's own file name.
pub const MEMORY_SUFFIX: &str = ".paperai-notes.md";

/// First line of every file we write. Its absence means "not ours".
pub const MARKER: &str = "<!-- paperai-memory v1 -->";

/// Hard cap. A memory file is notes, not a copy of the paper.
pub const MAX_MEMORY_BYTES: usize = 2 * 1024 * 1024;

/// What the UI needs to show about a memory file.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    /// Absolute path of the sidecar (whether or not it exists yet).
    pub path: String,
    pub exists: bool,
    pub bytes: usize,
    /// `YYYY-MM-DD HH:MM` of the file's last write, when it exists.
    pub updated_at: Option<String>,
    /// The note body, without the marker line. Empty when absent.
    pub content: String,
    /// Pages the notes claim to cover, when the app wrote that line.
    pub covered_pages: Option<String>,
}

/// `论文.pdf` -> `论文.pdf.paperai-notes.md`, in the same directory.
pub fn memory_path_for(pdf: &Path) -> AppResult<PathBuf> {
    let name = pdf
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::new(codes::AI_BAD_CONFIG, "无法确定文档文件名"))?;
    if name.trim().is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "文档文件名无效"));
    }
    let mut parent = pdf.parent().map(Path::to_path_buf).unwrap_or_default();
    parent.push(format!("{name}{MEMORY_SUFFIX}"));
    Ok(parent)
}

/// Read the sidecar, or `None` when the document has no memory yet.
///
/// A file that exists but carries no [`MARKER`] is an **error**, not an empty
/// memory: silently treating someone's own notes as "no memory" would invite
/// the next write to replace them.
pub fn read_memory(pdf: &Path) -> AppResult<Option<MemoryFile>> {
    let path = memory_path_for(pdf)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("读取阅读笔记失败：{e}")))?;
    if !raw.starts_with(MARKER) {
        return Err(AppError::new(
            codes::AI_BAD_CONFIG,
            format!(
                "{} 已存在，但不是 PaperAI 生成的笔记文件，已拒绝读写以免覆盖你的内容。",
                path.display()
            ),
        ));
    }
    let rest = raw.trim_start_matches(MARKER).trim_start_matches('\n');
    Ok(Some(MemoryFile {
        path: path.display().to_string(),
        exists: true,
        bytes: raw.len(),
        updated_at: fs_time(&path),
        covered_pages: covered_pages_of(rest),
        content: rest.to_string(),
    }))
}

/// Replace the memory file with `body`.
///
/// The caller composes the whole document (notes + Q&A log); this function only
/// owns the marker, the size cap and the write itself.
pub fn write_memory(pdf: &Path, body: &str) -> AppResult<MemoryFile> {
    let path = memory_path_for(pdf)?;
    guard_not_foreign(&path)?;

    let text = format!("{MARKER}\n{body}");
    if text.len() > MAX_MEMORY_BYTES {
        return Err(AppError::new(
            codes::AI_CONTEXT_TOO_LARGE,
            format!(
                "阅读笔记超过上限（{} 字节 > {} 字节），请先精简后再保存。",
                text.len(),
                MAX_MEMORY_BYTES
            ),
        ));
    }

    atomic_write(&path, text.as_bytes())?;
    Ok(MemoryFile {
        path: path.display().to_string(),
        exists: true,
        bytes: text.len(),
        updated_at: fs_time(&path),
        covered_pages: covered_pages_of(&text),
        content: body.to_string(),
    })
}

/// Append one `## 问答记录` entry, keeping the file under the cap.
///
/// Used after a whole-document answer, so the notes accumulate across a
/// reading session without the app having to re-summarise the paper.
pub fn append_entry(pdf: &Path, heading: &str, entry: &str) -> AppResult<MemoryFile> {
    let existing = read_memory(pdf)?;
    let section = format!("\n### {heading}\n\n{entry}\n");
    match existing {
        None => write_memory(pdf, &format!("# 阅读笔记\n{section}")),
        Some(m) => {
            let mut body = m.content;
            body.push_str(&section);
            // Trim the oldest Q&A entries rather than refuse to write once the
            // cap is hit: a stale note is worse than a shorter history.
            let mut candidate = body.clone();
            while candidate.len() > MAX_MEMORY_BYTES && candidate.contains("\n### ") {
                let idx = candidate.find("\n### ").unwrap();
                let next = candidate[idx + 1..].find("\n### ").map(|i| idx + 1 + i);
                match next {
                    Some(n) => candidate = candidate[..n].to_string(),
                    None => break,
                }
            }
            if candidate.len() > MAX_MEMORY_BYTES {
                return Err(AppError::new(
                    codes::AI_CONTEXT_TOO_LARGE,
                    "阅读笔记已达上限，请先删除部分内容或重新生成。",
                ));
            }
            write_memory(pdf, &candidate)
        }
    }
}

/// Refuse to touch a file that is not ours.
fn guard_not_foreign(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let head = fs::read_to_string(path)
        .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("无法读取已存在的笔记文件：{e}")))?;
    if !head.starts_with(MARKER) {
        return Err(AppError::new(
            codes::AI_BAD_CONFIG,
            format!(
                "{} 已存在但不是 PaperAI 生成的笔记文件，已拒绝写入，以免覆盖你的内容。",
                path.display()
            ),
        ));
    }
    Ok(())
}

/// Write to a sibling temp file, then rename over the target.
fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default()
    ));
    fs::write(&tmp, bytes)
        .map_err(|e| AppError::new(codes::AI_INTERNAL, format!("写入阅读笔记失败：{e}")))?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(AppError::new(codes::AI_INTERNAL, format!("保存阅读笔记失败：{e}")))
        }
    }
}

/// `覆盖页数：1–120（共 150 页）` -> `1–120（共 150 页）`
fn covered_pages_of(text: &str) -> Option<String> {
    for line in text.lines().take(20) {
        if let Some(rest) = line.trim().strip_prefix("- 覆盖页数：") {
            return Some(rest.trim().to_string());
        }
        if let Some(rest) = line.trim().strip_prefix("- 覆盖页数: ") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// Best-effort local timestamp. No chrono dependency for one line of UI text.
fn fs_time(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let secs = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    Some(format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        tod / 3600,
        (tod % 3600) / 60
    ))
}

/// Howard Hinnant's days-from-epoch -> civil date. Avoids pulling in a date crate
/// for a single formatted string.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "paperai-memtest-{tag}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).unwrap();
            TempDir(base)
        }
        fn pdf(&self) -> PathBuf {
            self.0.join("论文.pdf")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn path_sits_next_to_the_pdf_with_the_suffix() {
        let t = TempDir::new("path");
        let p = memory_path_for(&t.pdf()).unwrap();
        assert_eq!(p.parent(), Some(t.0.as_path()));
        assert!(p.to_string_lossy().ends_with("论文.pdf.paperai-notes.md"));
    }

    #[test]
    fn no_memory_yields_none_not_an_error() {
        let t = TempDir::new("none");
        assert!(read_memory(&t.pdf()).unwrap().is_none());
    }

    #[test]
    fn round_trip_keeps_the_body_and_hides_the_marker() {
        let t = TempDir::new("roundtrip");
        let w = write_memory(&t.pdf(), "# 阅读笔记\n\n- 覆盖页数：1–10（共 10 页）\n\n要点…").unwrap();
        assert!(w.exists);
        assert_eq!(w.covered_pages.as_deref(), Some("1–10（共 10 页）"));
        let r = read_memory(&t.pdf()).unwrap().expect("must exist");
        assert!(!r.content.contains(MARKER), "the marker is ours, not the user's");
        assert!(r.content.contains("要点"));
    }

    /// The important one: never destroy a file we did not write.
    #[test]
    fn refuses_to_write_over_a_foreign_file() {
        let t = TempDir::new("foreign");
        let target = memory_path_for(&t.pdf()).unwrap();
        fs::write(&target, "# 我自己写的笔记\n").unwrap();

        let e = write_memory(&t.pdf(), "generated").unwrap_err();
        assert_eq!(e.code, codes::AI_BAD_CONFIG);
        // And the user's bytes are untouched.
        let after = fs::read_to_string(&target).unwrap();
        assert_eq!(after, "# 我自己写的笔记\n");
    }

    #[test]
    fn refuses_to_read_a_foreign_file_as_ours() {
        let t = TempDir::new("foreign-read");
        fs::write(memory_path_for(&t.pdf()).unwrap(), "not ours").unwrap();
        let e = read_memory(&t.pdf()).unwrap_err();
        assert_eq!(e.code, codes::AI_BAD_CONFIG);
    }

    #[test]
    fn size_cap_is_enforced() {
        let t = TempDir::new("cap");
        let huge = "x".repeat(MAX_MEMORY_BYTES + 1);
        let e = write_memory(&t.pdf(), &huge).unwrap_err();
        assert_eq!(e.code, codes::AI_CONTEXT_TOO_LARGE);
        assert!(!memory_path_for(&t.pdf()).unwrap().exists(), "nothing written on refusal");
    }

    #[test]
    fn append_creates_then_grows() {
        let t = TempDir::new("append");
        let a = append_entry(&t.pdf(), "2026-10-16 16:30 · 概述", "第一问的回答").unwrap();
        assert!(a.content.contains("第一问的回答"));
        let b = append_entry(&t.pdf(), "2026-10-16 16:35 · 方法", "第二问的回答").unwrap();
        assert!(b.content.contains("第一问的回答"), "history must survive");
        assert!(b.content.contains("第二问的回答"));
        assert_eq!(b.bytes, memory_path_for(&t.pdf()).unwrap().metadata().unwrap().len() as usize);
    }

    #[test]
    fn append_trims_oldest_entries_instead_of_refusing() {
        let t = TempDir::new("trim");
        write_memory(&t.pdf(), &"a".repeat(MAX_MEMORY_BYTES - 200)).unwrap();
        let r = append_entry(&t.pdf(), "新问题", "b").unwrap();
        assert!(r.bytes <= MAX_MEMORY_BYTES, "must stay under the cap, got {}", r.bytes);
    }

    #[test]
    fn temp_file_does_not_survive_a_successful_write() {
        let t = TempDir::new("tmp");
        write_memory(&t.pdf(), "x").unwrap();
        let leftovers: Vec<_> = fs::read_dir(&t.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("tmp"))
            .collect();
        assert!(leftovers.is_empty(), "stray temp files: {leftovers:?}");
    }

    #[test]
    fn timestamp_formats_as_a_local_date() {
        let t = TempDir::new("time");
        let w = write_memory(&t.pdf(), "x").unwrap();
        let s = w.updated_at.expect("must have a timestamp");
        assert_eq!(s.len(), 16, "expected YYYY-MM-DD HH:MM, got {s}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], " ");
    }

    #[test]
    fn civil_conversion_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }
}