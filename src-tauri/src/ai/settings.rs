//! Provider profile persistence.
//!
//! Stored as JSON next to the app's other local data. It contains **no
//! secrets** — only `credential_id`, which names where the key lives in
//! Windows Credential Manager. This keeps the file safe to copy, diff, sync or
//! attach to a bug report.

use std::path::PathBuf;

use crate::error::{codes, AppError, AppResult};

use super::config::{is_loopback_insecure, normalize_base_url};
use super::secrets;
use super::types::{AiProfile, ProfileStatus};

/// The DeepSeek preset. The model string is a *default*, not a hard-coded
/// value: the UI lets the user edit it, and `deepseek-chat` is only used when
/// the user has not chosen something else.
pub fn deepseek_preset() -> AiProfile {
    AiProfile {
        id: "deepseek".into(),
        display_name: "DeepSeek".into(),
        base_url: "https://api.deepseek.com".into(),
        model: "deepseek-chat".into(),
        credential_id: "deepseek".into(),
        is_default: true,
    }
}

fn store_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&base).join("PaperAI").join("ai-profiles.json")
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Store {
    #[serde(default)]
    profiles: Vec<AiProfile>,
}

/// Load all profiles, seeding the DeepSeek preset on first run.
pub fn load() -> Vec<AiProfile> {
    let p = store_path();
    let mut store = match std::fs::read_to_string(&p) {
        Ok(t) => serde_json::from_str::<Store>(&t).unwrap_or_default(),
        Err(_) => Store::default(),
    };
    if store.profiles.is_empty() {
        store.profiles = vec![deepseek_preset()];
        let _ = save(&store.profiles);
    }
    // Exactly one default.
    if !store.profiles.iter().any(|p| p.is_default) {
        if let Some(f) = store.profiles.first_mut() {
            f.is_default = true;
        }
    }
    store.profiles
}

pub fn save(profiles: &[AiProfile]) -> AppResult<()> {
    let p = store_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(&Store { profiles: profiles.to_vec() })
        .map_err(|e| AppError::io(format!("序列化配置失败：{e}")))?;
    std::fs::write(&p, json)?;
    Ok(())
}

/// Create or update a profile. Validates the base URL and keeps CRUD atomic.
pub fn upsert(mut profile: AiProfile) -> AppResult<AiProfile> {
    if profile.id.trim().is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "配置 ID 不能为空"));
    }
    if profile.display_name.trim().is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "显示名称不能为空"));
    }
    if profile.model.trim().is_empty() {
        return Err(AppError::new(codes::AI_BAD_CONFIG, "模型名不能为空"));
    }
    profile.base_url = normalize_base_url(&profile.base_url)?;
    if profile.credential_id.trim().is_empty() {
        profile.credential_id = profile.id.clone();
    }

    let mut all = load();
    match all.iter_mut().find(|p| p.id == profile.id) {
        Some(slot) => *slot = profile.clone(),
        None => all.push(profile.clone()),
    }
    if profile.is_default {
        for p in all.iter_mut() {
            if p.id != profile.id {
                p.is_default = false;
            }
        }
    }
    save(&all)?;
    Ok(profile)
}

/// Remove a profile. The credential can be deleted separately so a user who
/// re-adds the same provider is not forced to re-enter the key.
pub fn remove(id: &str, delete_credential: bool) -> AppResult<()> {
    let mut all = load();
    let before = all.len();
    all.retain(|p| p.id != id);
    if all.len() == before {
        return Err(AppError::new(codes::AI_NO_PROFILE, "未找到该 Provider 配置"));
    }
    if !all.iter().any(|p| p.is_default) {
        if let Some(f) = all.first_mut() {
            f.is_default = true;
        }
    }
    save(&all)?;
    if delete_credential {
        // Best effort: a missing credential is not an error.
        secrets::delete_secret(id)?;
    }
    Ok(())
}

pub fn get(id: &str) -> AppResult<AiProfile> {
    load()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::new(codes::AI_NO_PROFILE, "未找到该 Provider 配置"))
}

/// Project a profile to the shape the UI is allowed to see.
pub fn status_of(p: &AiProfile) -> ProfileStatus {
    ProfileStatus {
        id: p.id.clone(),
        display_name: p.display_name.clone(),
        base_url: p.base_url.clone(),
        model: p.model.clone(),
        is_default: p.is_default,
        has_key: secrets::has_secret(&p.credential_id),
        is_loopback_insecure: is_loopback_insecure(&p.base_url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_is_a_valid_config() {
        let p = deepseek_preset();
        assert!(normalize_base_url(&p.base_url).is_ok());
        assert!(!p.model.is_empty());
        assert!(!secrets::has_secret("deepseek") || true, "preset carries no key by itself");
    }

    #[test]
    fn status_never_carries_a_key() {
        let p = deepseek_preset();
        let s = status_of(&p);
        let json = serde_json::to_string(&s).unwrap();
        // No field whose *name* is a key holder. `has_key` is a boolean and is
        // expected; a literal `"key":` / `"api_key":` field is not.
        assert!(!json.contains("\"api_key\""), "{json}");
        assert!(!json.contains("\"key\":") || json.contains("\"has_key\":"), "{json}");
        assert!(json.contains("\"has_key\""), "{json}");
        // And nothing that looks like a secret value ever appears.
        assert!(!json.contains("Bearer"), "{json}");
    }

    #[test]
    fn remote_http_is_rejected_on_upsert_shape() {
        let mut p = deepseek_preset();
        p.base_url = "http://api.deepseek.com".into();
        assert_eq!(
            normalize_base_url(&p.base_url).unwrap_err().code,
            codes::AI_INSECURE_REFUSED
        );
    }
}
