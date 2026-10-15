//! API key storage backed by Windows Credential Manager.
//!
//! Design rules that the rest of the app depends on:
//!
//! * There is **no `get_api_key` command**. The frontend can set, query
//!   existence, use (implicitly, by starting a chat) and delete — never read
//!   the value back. `read_secret` is `pub(crate)` and only the HTTP client
//!   calls it, to build the `Authorization` header.
//! * Credentials are `CRED_TYPE_GENERIC` and namespaced
//!   `PaperAI/AIProvider/<profile-id>`, so uninstalling PaperAI or removing a
//!   profile never touches another application's stored credentials.
//! * The key is never logged. Errors carry only the credential *name*.

use crate::error::{codes, AppError, AppResult};

/// Namespace for every credential this app creates.
const NS: &str = "PaperAI/AIProvider";

/// Full Credential Manager target name for a profile.
pub fn credential_name(profile_id: &str) -> String {
    format!("{NS}/{profile_id}")
}

/// A short, safe-to-log description of where a secret lives (no secret).
pub fn describe(profile_id: &str) -> String {
    credential_name(profile_id)
}

// ---------------------------------------------------------------- Windows ---

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    /// The Credential Manager reports a Win32 error; `windows` hands it back as
    /// an `HRESULT` (`0x8007_0000 | win32`). Comparing the raw i32 against
    /// `ERROR_NOT_FOUND.0` (1168) therefore never matched, which made "no key
    /// stored" surface as a generic credential-store failure instead of
    /// `ai_no_key`. Compare the Win32 code instead.
    fn is_not_found(e: &windows::core::Error) -> bool {
        let raw = e.code().0 as u32;
        let win32 = raw & 0xFFFF;
        win32 == ERROR_NOT_FOUND.0
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Store (or replace) the secret for a profile.
    pub fn write_secret(profile_id: &str, secret: &str) -> AppResult<()> {
        if secret.trim().is_empty() {
            return Err(AppError::new(codes::AI_BAD_CONFIG, "API Key 不能为空"));
        }
        let mut target = to_wide(&credential_name(profile_id));
        let mut user = to_wide("PaperAI");
        // CredentialBlob is not NUL-terminated; the length is explicit.
        let mut blob: Vec<u8> = secret.as_bytes().to_vec();

        let cred = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            Comment: PWSTR::null(),
            LastWritten: Default::default(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: PWSTR::null(),
            UserName: PWSTR(user.as_mut_ptr()),
        };

        // Delete first: overwriting is the intended semantic, and CredWriteW
        // fails with ERROR_ALREADY_EXISTS in some cases otherwise.
        unsafe {
            let _ = CredDeleteW(PWSTR(target.as_mut_ptr()), CRED_TYPE_GENERIC, None);
            CredWriteW(&cred, 0).map_err(|e| {
                AppError::new(
                    codes::AI_SECRET_STORE,
                    format!("写入系统凭据失败（{}）：{}", describe(profile_id), e.code().0),
                )
            })?;
        }
        // Scrub our copies of the plaintext.
        for b in blob.iter_mut() {
            *b = 0;
        }
        Ok(())
    }

    /// Read the secret. Deliberately crate-private: only the HTTP client uses it.
    pub(crate) fn read_secret(profile_id: &str) -> AppResult<String> {
        let mut target = to_wide(&credential_name(profile_id));
        let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            CredReadW(PWSTR(target.as_mut_ptr()), CRED_TYPE_GENERIC, None, &mut pcred).map_err(
                |e| {
                    if is_not_found(&e) {
                        AppError::new(codes::AI_NO_KEY, "尚未配置 API Key")
                    } else {
                        AppError::new(
                            codes::AI_SECRET_STORE,
                            format!("读取系统凭据失败：{}", e.code().0),
                        )
                    }
                },
            )?;

            let cred = &*pcred;
            let slice =
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
            let s = String::from_utf8_lossy(slice).to_string();
            CredFree(pcred as *const _);
            if s.trim().is_empty() {
                return Err(AppError::new(codes::AI_NO_KEY, "尚未配置 API Key"));
            }
            Ok(s)
        }
    }

    /// Does a secret exist? Never returns the value.
    pub fn has_secret(profile_id: &str) -> bool {
        read_secret(profile_id).is_ok()
    }

    /// Remove the secret. Idempotent: missing is success.
    pub fn delete_secret(profile_id: &str) -> AppResult<()> {
        let mut target = to_wide(&credential_name(profile_id));
        unsafe {
            match CredDeleteW(PWSTR(target.as_mut_ptr()), CRED_TYPE_GENERIC, None) {
                Ok(()) => Ok(()),
                Err(e) if is_not_found(&e) => Ok(()),
                Err(e) => Err(AppError::new(
                    codes::AI_SECRET_STORE,
                    format!("删除系统凭据失败：{}", e.code().0),
                )),
            }
        }
    }
}

// ------------------------------------------------------------- non-Windows ---
// The product targets Windows, but `cargo test` on another host (and the CI
// unit tests) must still link. Memory-only storage keeps the parity and makes
// the failure obvious: nothing persists across processes.

#[cfg(not(windows))]
mod imp {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    static STORE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    fn with<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> T {
        let mut g = STORE.lock().unwrap();
        let m = g.get_or_insert_with(HashMap::new);
        f(m)
    }

    pub fn write_secret(profile_id: &str, secret: &str) -> AppResult<()> {
        if secret.trim().is_empty() {
            return Err(AppError::new(codes::AI_BAD_CONFIG, "API Key 不能为空"));
        }
        with(|m| m.insert(credential_name(profile_id), secret.to_string()));
        Ok(())
    }
    pub(crate) fn read_secret(profile_id: &str) -> AppResult<String> {
        with(|m| m.get(&credential_name(profile_id)).cloned())
            .ok_or_else(|| AppError::new(codes::AI_NO_KEY, "尚未配置 API Key"))
    }
    pub fn has_secret(profile_id: &str) -> bool {
        with(|m| m.contains_key(&credential_name(profile_id)))
    }
    pub fn delete_secret(profile_id: &str) -> AppResult<()> {
        with(|m| m.remove(&credential_name(profile_id)));
        Ok(())
    }
}

pub use imp::{delete_secret, has_secret, write_secret};

/// Read a secret. `pub(crate)` on purpose — see the module docs.
pub(crate) fn read_secret(profile_id: &str) -> AppResult<String> {
    imp::read_secret(profile_id)
}

/// Redact anything that looks like a key, for defensive logging.
pub fn redact(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    // Show at most the first 3 characters, never the tail.
    let head: String = t.chars().take(3).collect();
    format!("{head}***（已隐藏，共 {} 字符）", t.chars().count())
}

// ---------------------------------------------------------------------------
// "Is it safe to hand this build to someone else?"
// ---------------------------------------------------------------------------

#[cfg(test)]
mod sharing_audit {
    use super::*;
    use std::path::{Path, PathBuf};

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .to_path_buf()
    }

    /// Every file a recipient could plausibly end up with.
    ///
    /// Deliberately includes the INSTALLED binary and the app's own log: a log
    /// is the classic accidental leak, and users attach logs to bug reports.
    fn artifacts_to_scan() -> Vec<PathBuf> {
        let root = repo_root();
        let mut out = Vec::new();

        let mut push_dir = |dir: &Path, out: &mut Vec<PathBuf>| {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_file() {
                    out.push(p);
                } else if p.is_dir() {
                    if let Ok(inner) = std::fs::read_dir(&p) {
                        for e2 in inner.flatten() {
                            if e2.path().is_file() {
                                out.push(e2.path());
                            }
                        }
                    }
                }
            }
        };

        push_dir(&root.join("release"), &mut out);
        push_dir(&root.join("dist"), &mut out);
        push_dir(&root.join("dist").join("assets"), &mut out);

        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let app = Path::new(&local).join("PaperAI");
            push_dir(&app, &mut out);
            // A very large log is still worth scanning; cap defensively.
            out.retain(|p| p.metadata().map(|m| m.len() < 512 * 1024 * 1024).unwrap_or(false));
            // The installed copy lives elsewhere (NSIS remembers the first
            // install directory), so ask the registry-independent place too.
            let installed = Path::new("D://Program Files//PaperAI").join("PaperAI.exe");
            if installed.is_file() {
                out.push(installed);
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// Profile ids from `ai-profiles.json`. That file holds no secret — only
    /// ids and endpoints — so reading it here leaks nothing.
    fn profile_ids() -> Vec<String> {
        let Ok(local) = std::env::var("LOCALAPPDATA") else {
            return Vec::new();
        };
        let p = Path::new(&local).join("PaperAI").join("ai-profiles.json");
        let Ok(text) = std::fs::read_to_string(&p) else {
            return Vec::new();
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            return Vec::new();
        };
        v["profiles"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        p["credential_id"]
                            .as_str()
                            .or_else(|| p["id"].as_str())
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        if needle.is_empty() || needle.len() > haystack.len() {
            return false;
        }
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    /// Scan `files` for `keys`. Returns (files scanned, bytes scanned, leaks).
    ///
    /// Split out from the audit below so a control test can prove the scanner
    /// actually finds a needle it is handed. Without that control, "PASS" from
    /// a scanner that silently examines nothing is indistinguishable from a
    /// clean result.
    fn scan_for(files: &[PathBuf], keys: &[(String, String)]) -> (usize, u64, Vec<String>) {
        let mut leaks = Vec::new();
        let mut scanned = 0usize;
        let mut bytes_total: u64 = 0;
        for f in files {
            let Ok(bytes) = std::fs::read(f) else { continue };
            scanned += 1;
            bytes_total += bytes.len() as u64;
            for (id, k) in keys {
                if contains(&bytes, k.as_bytes()) {
                    leaks.push(format!("{} in {}", id, f.display()));
                }
            }
        }
        (scanned, bytes_total, leaks)
    }

    /// Negative control: the scanner must find a secret that IS present.
    /// A detector that cannot fail is not evidence.
    #[test]
    fn the_scanner_detects_a_planted_key() {
        let secret = "sk-plAnted-control-value-0123456789";
        let dir = std::env::temp_dir().join("paperai-secret-audit-control");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let planted = dir.join("planted.bin");
        std::fs::write(&planted, format!("junk before\n{secret}\njunk after")).expect("write");

        let keys = vec![("control".to_string(), secret.to_string())];
        let (n, bytes, leaks) = scan_for(std::slice::from_ref(&planted), &keys);

        assert_eq!(n, 1, "scanner did not read the file it was given");
        assert!(bytes > 0, "scanner read 0 bytes");
        assert_eq!(
            leaks.len(),
            1,
            "the scanner failed to find a value it was explicitly handed — \
             any PASS it reports would be meaningless"
        );

        let _ = std::fs::remove_file(&planted);
        let _ = std::fs::remove_dir(&dir);
    }

    /// **Run this before handing a build to anyone.**
    ///
    ///     cd src-tauri
    ///     cargo test --lib -- --ignored --nocapture shipped_artifacts
    ///
    /// It reads the *real* stored credential and searches every file a
    /// recipient could receive for those exact bytes. It never prints the key
    /// (only its length and where it lives), and it never writes it anywhere.
    ///
    /// Ignored by default: it needs a genuine credential and a built installer,
    /// neither of which exists in a clean checkout.
    #[test]
    #[ignore = "manual audit; needs a stored credential and a built installer"]
    fn shipped_artifacts_do_not_contain_a_stored_key() {
        let ids = profile_ids();
        let mut keys: Vec<(String, String)> = Vec::new();
        for id in &ids {
            if let Ok(k) = read_secret(id) {
                keys.push((id.clone(), k));
            }
        }

        if keys.is_empty() {
            eprintln!(
                "SKIPPED: no readable credential for {:?}. Nothing to audit.",
                ids
            );
            return;
        }
        for (id, k) in &keys {
            eprintln!(
                "auditing {} secret(s); {} -> {} bytes, target {}",
                keys.len(),
                id,
                k.len(),
                credential_name(id)
            );
        }

        let files = artifacts_to_scan();
        assert!(!files.is_empty(), "found nothing to scan — wrong working dir?");

        // Show the biggest targets so the coverage is visible, not just asserted.
        let mut by_size: Vec<(u64, String)> = files
            .iter()
            .filter_map(|f| f.metadata().ok().map(|m| (m.len(), f.display().to_string())))
            .collect();
        by_size.sort_by(|a, b| b.0.cmp(&a.0));
        eprintln!("\nlargest files in the scan set:");
        for (size, path) in by_size.iter().take(5) {
            eprintln!("  {:>12}  {}", size, path);
        }

        let (scanned, bytes_total, leaks) = scan_for(&files, &keys);
        eprintln!(
            "\nscanned {} file(s), {} bytes total ({:.1} MiB)",
            scanned,
            bytes_total,
            bytes_total as f64 / 1024.0 / 1024.0
        );

        assert!(
            leaks.is_empty(),
            "A STORED KEY APPEARS IN A SHIPPED FILE — do not distribute:\n{}",
            leaks.join("\n")
        );
        eprintln!(
            "PASS: none of the {scanned} file(s) contain any stored key.\n  \
             (the key itself was never printed and never written to disk)"
        );
    }
}
