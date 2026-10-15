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
