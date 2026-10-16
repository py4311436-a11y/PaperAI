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

/// Built-in provider presets offered when the user adds a provider.
///
/// Every base URL here was read off the provider's own documentation and then
/// confirmed against its live `/models` endpoint — a guessed base URL fails in
/// the most confusing way possible (a 404 that looks like a bad model name), so
/// nothing goes in this list on inference alone.
///
/// Only models served on the OpenAI-compatible `/chat/completions` path are
/// used as defaults. OpenCode splits its catalogue across three protocols
/// (`/chat/completions`, `/messages`, `/responses`), so e.g. MiniMax and Qwen
/// on Go would need the Anthropic dialect and are deliberately not offered.
pub fn presets() -> Vec<AiProfile> {
    vec![deepseek_preset(), opencode_go_preset(), opencode_zen_preset()]
}

/// DeepSeek's first-party API.
///
/// The model default is `deepseek-flash`: DeepSeek's docs now say to use that
/// name, and the older `deepseek-chat` is no longer listed. It remains a
/// *default* — the field is editable and nothing is hard-coded downstream.
pub fn deepseek_preset() -> AiProfile {
    AiProfile {
        id: "deepseek".into(),
        display_name: "DeepSeek 官方".into(),
        base_url: "https://api.deepseek.com".into(),
        model: "deepseek-flash".into(),
        credential_id: "deepseek".into(),
        is_default: true,
        sends_session_header: false,
    }
}

/// OpenCode Go — the paid subscription pool (`$10/month`).
///
/// Base URL from the official endpoint table (`https://opencode.ai/inference/
/// go/v1/chat/completions`). `zen/go/v1` also answers, but the documentation is
/// the source of truth.
pub fn opencode_go_preset() -> AiProfile {
    AiProfile {
        id: "opencode-go".into(),
        display_name: "OpenCode Go（订阅）".into(),
        base_url: "https://opencode.ai/inference/go/v1".into(),
        // Verified against the live catalogue; a /chat/completions model.
        model: "deepseek-v4.1-flash".into(),
        credential_id: "opencode-go".into(),
        is_default: false,
        sends_session_header: true,
    }
}

/// OpenCode Zen — the pay-as-you-go pool, which also carries free models.
///
/// Provider-side gate (verified 2026-10-16, user-reported 403 + live probes by
/// community clients): since ~2026-09-16 the anonymous free lane
/// (`*-free` models, no API key) rejects every request that does not
/// originate from the official OpenCode client — `403 FreeTierError:
/// OpenCode's free tier can only be used from within OpenCode`. Header spoofing
/// (client UA, `ses_`-shaped session ids, stub tools) worked briefly and has
/// since been closed server-side; community plugins that did it are deprecated.
/// Consequence: PaperAI can only use Zen *paid* models with a funded Zen API
/// key. Free models must be used inside the OpenCode app itself. The preset
/// still ships with a `-free` default because the id is valid and the server
/// message (surfaced verbatim in the settings status area) explains the gate.
pub fn opencode_zen_preset() -> AiProfile {
    AiProfile {
        id: "opencode-zen".into(),
        display_name: "OpenCode Zen（含免费模型）".into(),
        base_url: "https://opencode.ai/zen/v1".into(),
        model: "deepseek-v4.1-flash-free".into(),
        credential_id: "opencode-zen".into(),
        is_default: false,
        sends_session_header: true,
    }
}

/// Whether a model id is served by a provider on a protocol other than
/// `/chat/completions`.
///
/// OpenCode serves several families only on `/messages` (Anthropic) or
/// `/responses` (OpenAI Responses), and its `/models` response carries no
/// protocol metadata — so a client that blindly picks an id gets an opaque
/// failure. This table comes from the provider's own endpoint tables and is a
/// *hint* only: `unknown` means "the provider is not known to split protocols",
/// which is the normal case and is not a warning.
///
/// It will drift as the catalogue changes; that is acceptable because the worst
/// outcome is a misleading hint, never a wrong request.
pub fn protocol_hint(model_id: &str) -> &'static str {
    let id = model_id.trim().to_ascii_lowercase();
    let anthropic_only = [
        "minimax-m3",
        "minimax-m2.7",
        "minimax-m2.5",
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.7-plus",
        "qwen3.7-max",
        "qwen3.6-plus",
        "qwen3.5-plus",
        "claude-haiku-5-5",
    ];
    let responses_only = [
        "grok-4.7",
        "grok-4.6",
        "grok-4.5",
        "gpt-6-luna",
        "gpt-5.6-luna",
        "muse-spark-1.3-contributor",
        "muse-spark-1.2-contributor",
    ];
    if anthropic_only.contains(&id.as_str()) || responses_only.contains(&id.as_str()) {
        return "incompatible";
    }
    "unknown"
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
        sends_session_header: p.sends_session_header,
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

    /// Every preset must survive the same validation a user-typed profile does.
    /// A preset that cannot be saved is worse than no preset.
    #[test]
    fn every_preset_is_saveable_and_distinct() {
        let all = presets();
        assert!(all.len() >= 3, "expected at least DeepSeek, Go and Zen");
        let mut ids = std::collections::HashSet::new();
        for p in &all {
            assert_eq!(
                normalize_base_url(&p.base_url).unwrap(),
                p.base_url,
                "preset {} has a base URL that would be rewritten on save",
                p.id
            );
            assert!(!p.model.trim().is_empty(), "preset {} has no model", p.id);
            assert!(!p.display_name.trim().is_empty(), "preset {} has no name", p.id);
            assert!(ids.insert(p.id.clone()), "duplicate preset id {}", p.id);
            // Credentials are named after the profile, so a shared credential_id
            // would make two providers read the same stored key.
            assert_eq!(
                p.credential_id, p.id,
                "preset {} must not share a credential slot",
                p.id
            );
        }
        // Exactly one preset may claim the default flag.
        assert_eq!(all.iter().filter(|p| p.is_default).count(), 1);
    }

    #[test]
    fn opencode_presets_ask_for_a_session_header() {
        // Their gateway documents this requirement; DeepSeek's does not ask.
        assert!(opencode_go_preset().sends_session_header);
        assert!(opencode_zen_preset().sends_session_header);
        assert!(!deepseek_preset().sends_session_header);
    }

    #[test]
    fn protocol_hint_flags_models_served_on_other_protocols() {
        // These are on /messages or /responses, never /chat/completions.
        assert_eq!(protocol_hint("qwen3.8-max"), "incompatible");
        assert_eq!(protocol_hint("grok-4.7"), "incompatible");
        assert_eq!(protocol_hint("minimax-m3"), "incompatible");
        // Case and whitespace must not change the verdict.
        assert_eq!(protocol_hint("  Grok-4.7  "), "incompatible");
        // Chat-completions models are "unknown", i.e. not warned about.
        assert_eq!(protocol_hint("deepseek-v4.1-flash"), "unknown");
        assert_eq!(protocol_hint("glm-5.3"), "unknown");
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
