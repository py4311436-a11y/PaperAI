//! Crash-recovery integration tests for the save pipeline (K-07).
//!
//! These drive the *real* `save_pdf` with fault injection enabled, which leaves
//! the same on-disk state a power loss would, then run the real `recovery::scan`
//! and `recovery::apply` over it. Nothing is mocked.
//!
//! Fault injection is opt-in via `PAPERAI_ALLOW_FAULT_INJECTION=1`; the tests
//! set it themselves because they are the only legitimate user of it.
//!
//! Every test runs on a COPY under the OS temp directory. The user's own PDFs
//! are never touched (the task requires this explicitly).

use std::fs;
use std::path::PathBuf;

use base64::Engine;
use paperai_lib::recovery::{self, RecoveryAction};
use paperai_lib::save_service::{save_pdf, SaveRequest};

mod support;
use support::serial;

fn fake_pdf(tag: &str) -> Vec<u8> {
    let mut v = b"%PDF-1.6\n".to_vec();
    v.extend_from_slice(tag.as_bytes());
    // Pad so the file is comfortably over the 32-byte minimum.
    v.extend_from_slice(b"\n% ----------------------------------------------------------\n%%EOF\n");
    v
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

struct Sandbox(PathBuf);

impl Sandbox {
    fn new(name: &str) -> Self {
        let d = std::env::temp_dir().join(format!(
            "paperai-save-crash-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        Sandbox(d)
    }
    fn file(&self) -> PathBuf {
        self.0.join("paper.pdf")
    }
    /// Write an initial document.
    fn seed(&self, tag: &str) -> PathBuf {
        let p = self.file();
        fs::write(&p, fake_pdf(tag)).unwrap();
        p
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Enable fault injection for the duration of the process.
fn allow_injection() {
    std::env::set_var("PAPERAI_ALLOW_FAULT_INJECTION", "1");
}

fn save(target: &PathBuf, data: &[u8], inject: Option<&str>) {
    let _ = save_pdf(SaveRequest {
        target_path: target.to_string_lossy().to_string(),
        data_base64: b64(data),
        make_backup: true,
        inject_failure: inject.map(str::to_string),
    });
}

/// Every user-visible artefact next to the document.
fn sidecars(target: &PathBuf) -> Vec<String> {
    let dir = target.parent().unwrap();
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    v.sort();
    v
}

// --------------------------------------------------------------- baseline ---

#[test]
fn a_clean_save_leaves_no_sidecars() {
    let _g = serial();
    let sb = Sandbox::new("clean");
    let target = sb.seed("V1");
    save(&target, &fake_pdf("V2"), None);

    let files = sidecars(&target);
    assert!(!files.iter().any(|f| f.contains("paperai.old")), "{files:?}");
    assert!(!files.iter().any(|f| f.starts_with(".paperai-tmp-")), "{files:?}");
    assert!(String::from_utf8_lossy(&fs::read(&target).unwrap()).contains("V2"));

    let r = recovery::scan(&target.to_string_lossy());
    assert!(!r.needs_recovery);
    assert!(r.target_exists);
}

// ------------------------------------------------- crash before the stage ---

#[test]
fn crash_before_staging_keeps_the_original_and_recovers_cleanly() {
    let _g = serial();
    allow_injection();
    let sb = Sandbox::new("crash-before");
    let target = sb.seed("ORIGINAL");
    let before = fs::read(&target).unwrap();

    save(&target, &fake_pdf("NEW"), Some("crash_before_stage"));

    assert_eq!(fs::read(&target).unwrap(), before, "the original must be byte-identical");

    let r = recovery::scan(&target.to_string_lossy());
    assert!(r.target_exists);
    assert!(!r.needs_recovery, "nothing was lost, so nothing to recover");
    assert!(r.leftover_temps.is_empty(), "the temp was cleaned up");
}

// --------------------------------------- crash AFTER the stage (worst case) --

#[test]
fn crash_after_staging_loses_the_target_but_recovery_restores_it() {
    let _g = serial();
    allow_injection();
    let sb = Sandbox::new("crash-after");
    let target = sb.seed("ORIGINAL");
    let original = fs::read(&target).unwrap();

    save(&target, &fake_pdf("NEW"), Some("crash_after_stage"));

    // The document is now MISSING — this is the data-loss window.
    assert!(!target.exists(), "the crash window must be reproducible");

    let r = recovery::scan(&target.to_string_lossy());
    assert!(r.needs_recovery, "summary={}", r.summary);
    assert!(!r.target_exists);
    let old = r.candidates.iter().find(|c| c.kind == "old").expect("a .old candidate");
    assert!(old.valid_pdf, "reason={:?}", old.invalid_reason);

    // Restore, and confirm the user gets their bytes back exactly.
    let res = recovery::apply(&target.to_string_lossy(), RecoveryAction::RestoreOld).unwrap();
    assert_eq!(res.code, "restored");
    assert_eq!(fs::read(&target).unwrap(), original, "byte-identical restore");

    // And it is idempotent: scanning again reports nothing to do.
    let after = recovery::scan(&target.to_string_lossy());
    assert!(!after.needs_recovery);
    assert!(after.target_exists);
    let again = recovery::apply(&target.to_string_lossy(), RecoveryAction::RestoreOld).unwrap();
    assert_eq!(again.code, "recover_none");
    assert_eq!(fs::read(&target).unwrap(), original);
}

#[test]
fn crash_after_staging_refuses_to_discard_the_only_copy() {
    let _g = serial();
    allow_injection();
    let sb = Sandbox::new("crash-after-keepnew");
    let target = sb.seed("ORIGINAL");
    save(&target, &fake_pdf("NEW"), Some("crash_after_stage"));
    assert!(!target.exists());

    // "Keep current" would delete the only surviving copy; recovery must refuse.
    let err = recovery::apply(&target.to_string_lossy(), RecoveryAction::KeepNew).unwrap_err();
    assert_eq!(err.code, "recover_invalid");
    assert!(
        sidecars(&target).iter().any(|f| f.contains("paperai.old")),
        "the copy must still be there"
    );
}

// ------------------------------------------- crash after a successful swap --

#[test]
fn crash_after_replacing_keeps_the_new_content_and_needs_no_rescue() {
    let _g = serial();
    allow_injection();
    let sb = Sandbox::new("crash-replaced");
    let target = sb.seed("ORIGINAL");

    save(&target, &fake_pdf("NEW"), Some("crash_after_replace"));

    // The new content is in place; only cleanup was skipped.
    assert!(target.exists());
    assert!(String::from_utf8_lossy(&fs::read(&target).unwrap()).contains("NEW"));

    let r = recovery::scan(&target.to_string_lossy());
    assert!(r.target_exists);
    assert!(!r.needs_recovery, "the document is fine; nothing was lost");
    assert!(!r.target_invalid_reason.is_some());
    // A .old is present but the target is healthy, so the UI offers a choice
    // rather than a rescue.
    assert!(r.candidates.iter().any(|c| c.kind == "old" && c.valid_pdf));

    // Keeping the new content must not delete the old one destructively in a
    // way that loses data: it deletes `.old`, which is the point of "keep new".
    let res = recovery::apply(&target.to_string_lossy(), RecoveryAction::KeepNew).unwrap();
    assert_eq!(res.code, "kept_new");
    assert!(String::from_utf8_lossy(&fs::read(&target).unwrap()).contains("NEW"));
}

// ------------------------------------------------------------- idempotence --

#[test]
fn repeated_saves_never_accumulate_sidecars() {
    let _g = serial();
    allow_injection();
    let sb = Sandbox::new("repeat");
    let target = sb.seed("V0");
    for i in 1..=4 {
        save(&target, &fake_pdf(&format!("V{i}")), None);
    }
    let files = sidecars(&target);
    let olds = files.iter().filter(|f| f.contains("paperai.old")).count();
    let temps = files.iter().filter(|f| f.starts_with(".paperai-tmp-")).count();
    assert_eq!(olds, 0, "{files:?}");
    assert_eq!(temps, 0, "{files:?}");
    assert!(String::from_utf8_lossy(&fs::read(&target).unwrap()).contains("V4"));

    let r = recovery::scan(&target.to_string_lossy());
    assert!(!r.needs_recovery);
    assert!(
        !r.candidates.iter().any(|c| c.kind == "old"),
        "a single-generation .bak is fine, a leftover .old is not: {:?}",
        r.candidates.iter().map(|c| &c.kind).collect::<Vec<_>>()
    );
}

#[test]
fn the_backup_is_single_generation_and_holds_the_previous_revision() {
    let _g = serial();
    allow_injection();
    let sb = Sandbox::new("bak");
    let target = sb.seed("V1");
    save(&target, &fake_pdf("V2"), None);

    let bak = target.with_extension("pdf.paperai.bak");
    assert!(bak.exists());
    assert!(
        String::from_utf8_lossy(&fs::read(&bak).unwrap()).contains("V1"),
        "the backup must be the revision being replaced"
    );
    assert!(String::from_utf8_lossy(&fs::read(&target).unwrap()).contains("V2"));
}

// --------------------------------------------------------- injection gating --

#[test]
fn the_crash_hooks_are_unreachable_without_the_env_gate() {
    let _g = serial();
    std::env::remove_var("PAPERAI_ALLOW_FAULT_INJECTION");
    let sb = Sandbox::new("gated");
    let target = sb.seed("ORIGINAL");
    let before = fs::read(&target).unwrap();

    let res = save_pdf(SaveRequest {
        target_path: target.to_string_lossy().to_string(),
        data_base64: b64(&fake_pdf("NEW")),
        make_backup: true,
        inject_failure: Some("crash_after_stage".into()),
    });

    assert!(!res.ok);
    assert_eq!(res.code, "save_injection_disabled");
    assert_eq!(fs::read(&target).unwrap(), before, "the document must be untouched");
    assert!(target.exists());
}
