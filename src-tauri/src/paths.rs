//! Path handling for file-open requests coming from:
//!   * the OS shell (right-click -> Open with -> PaperAI)
//!   * `PaperAI.exe "path.pdf"` on the command line
//!   * the in-app file picker
//!
//! Rules applied (see task D3/C4):
//!   * arguments are taken as `OsString` and never fed to a shell
//!   * relative paths are resolved against the process CWD
//!   * the result must exist, be a file, and start with the `%PDF-` magic
//!   * no path is ever used to *write* unless it is an explicit save target

use std::path::{Path, PathBuf};

use crate::error::{codes, AppError, AppResult};

/// Largest PDF we are willing to read into memory / write back (bytes).
pub const MAX_PDF_BYTES: u64 = 512 * 1024 * 1024;

/// Strip surrounding quotes that Explorer sometimes leaves on argv entries,
/// then normalise `..`/`.` lexically without touching the filesystem.
pub fn clean_arg(raw: &str) -> String {
    let t = raw.trim();
    let t = t.trim_matches('"').trim();
    let t = t.replace('/', "\\");
    // `canonicalize` on Windows returns the \\?\ verbatim form; strip it so the
    // path we hand back to the UI / save layer is a normal path.
    t.strip_prefix(r"\\?\UNC\").map(|_| t.to_string()).unwrap_or_else(|| {
        t.strip_prefix(r"\\?\").unwrap_or(&t).to_string()
    })
}

/// Resolve `raw` into an absolute, existing, PDF file path.
///
/// `cwd` is used to resolve relative paths (the OS gives us the launching
/// process' working directory for shell invocations).
pub fn resolve_pdf_path(raw: &str, cwd: Option<&Path>) -> AppResult<PathBuf> {
    let cleaned = clean_arg(raw);
    if cleaned.is_empty() {
        return Err(AppError::new(codes::PATH_EMPTY, "路径为空"));
    }

    let candidate = Path::new(&cleaned);
    let joined: PathBuf;
    let absolute: &Path = if candidate.is_absolute() {
        candidate
    } else {
        match cwd {
            Some(base) => {
                joined = base.join(candidate);
                &joined
            }
            None => {
                joined = std::env::current_dir()
                    .map_err(|e| AppError::new(codes::PATH_INVALID, e.to_string()))?
                    .join(candidate);
                &joined
            }
        }
    };

    // Canonicalise (also resolves symlinks / 8.3 short names).
    let canonical = absolute
        .canonicalize()
        .map_err(|_| AppError::new(codes::PATH_NOT_FOUND, format!("文件不存在: {}", cleaned)))?;
    let canonical = PathBuf::from(clean_arg(&canonical.to_string_lossy()));

    if !canonical.is_file() {
        return Err(AppError::new(codes::PATH_NOT_FILE, format!("不是文件: {}", cleaned)));
    }

    let meta = std::fs::metadata(&canonical)?;
    if meta.len() > MAX_PDF_BYTES {
        return Err(AppError::new(
            codes::TOO_LARGE,
            format!("文件过大 ({} MB > {} MB)", meta.len() / 1024 / 1024, MAX_PDF_BYTES / 1024 / 1024),
        ));
    }

    // Content check rather than trusting the extension: a `.pdf` that is not a
    // PDF must fail loudly instead of rendering an empty viewer.
    let mut probe = [0u8; 8];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&canonical)?;
        let n = f.read(&mut probe)?;
        if n < 5 || &probe[..5] != b"%PDF-" {
            return Err(AppError::new(codes::PATH_NOT_PDF, format!("不是有效的 PDF 文件: {}", cleaned)));
        }
    }

    Ok(canonical)
}

/// Metadata about a candidate path, used by the UI before attempting a save.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PathInfo {
    pub exists: bool,
    pub is_file: bool,
    pub size: u64,
    pub readonly: bool,
    pub is_pdf: bool,
}

pub fn inspect_path(raw: &str) -> PathInfo {
    let cleaned = clean_arg(raw);
    let p = Path::new(&cleaned);
    match std::fs::metadata(p) {
        Ok(m) => {
            let is_pdf = std::fs::File::open(p)
                .and_then(|mut f| {
                    use std::io::Read;
                    let mut b = [0u8; 5];
                    f.read_exact(&mut b)?;
                    Ok(b == *b"%PDF-")
                })
                .unwrap_or(false);
            PathInfo {
                exists: true,
                is_file: m.is_file(),
                size: m.len(),
                readonly: m.permissions().readonly(),
                is_pdf,
            }
        }
        Err(_) => PathInfo { exists: false, is_file: false, size: 0, readonly: false, is_pdf: false },
    }
}

/// True when `p` exists and cannot be written (read-only attribute or ACL).
pub fn is_writable_target(p: &Path) -> AppResult<bool> {
    if !p.exists() {
        // A fresh file: the parent directory must be writable.
        let parent = p.parent().ok_or_else(|| AppError::new(codes::SAVE_NO_DIR, "无法确定目标目录"))?;
        if !parent.is_dir() {
            return Err(AppError::new(codes::SAVE_NO_DIR, format!("目标目录不存在: {}", parent.display())));
        }
        return Ok(true);
    }
    let m = std::fs::metadata(p)?;
    if m.permissions().readonly() {
        return Ok(false);
    }
    // Practical probe: opening for append fails when another process holds the
    // file with no sharing, and succeeds otherwise. We close immediately.
    match std::fs::OpenOptions::new().append(true).open(p) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}
