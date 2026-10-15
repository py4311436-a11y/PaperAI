// Serialise the crash-recovery tests.
//
// They mutate a process-wide environment variable (`PAPERAI_ALLOW_FAULT_INJECTION`)
// and cargo runs `#[test]` functions on parallel threads by default. Without a
// lock, `the_crash_hooks_are_unreachable_without_the_env_gate` observed the flag
// set by a sibling test and failed — a test-isolation bug, not a product bug.
//
// The lock also keeps the sandbox paths from interleaving.

use std::sync::{Mutex, MutexGuard, OnceLock};

fn lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

/// Hold this for the duration of a test that touches fault injection.
pub struct Guard(#[allow(dead_code)] MutexGuard<'static, ()>);

pub fn serial() -> Guard {
    Guard(lock().lock().unwrap_or_else(|e| e.into_inner()))
}
