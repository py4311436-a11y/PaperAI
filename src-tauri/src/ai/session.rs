//! In-flight request registry and cancellation.
//!
//! Cancellation is deliberately *not* a boolean flag polled between chunks: a
//! provider that stalls would never be interrupted. Each request registers a
//! `watch` channel, and the streaming loop `select!`s on it together with the
//! network read, so a cancel takes effect immediately and drops the HTTP body
//! (closing the connection) rather than waiting for the next byte.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::watch;

/// Registry of running chat requests.
#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<HashMap<String, watch::Sender<bool>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new request. Returns the receiver the stream loop watches.
    pub fn register(&self, request_id: &str) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        if let Ok(mut g) = self.inner.lock() {
            // A reused id would otherwise leave the old sender alive; replacing
            // it means the previous stream sees no cancel and will be dropped
            // when its own future is dropped.
            g.insert(request_id.to_string(), tx);
        }
        rx
    }

    /// Cancel one request. Returns true if it was running.
    pub fn cancel(&self, request_id: &str) -> bool {
        let g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match g.get(request_id) {
            Some(tx) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }

    /// Remove a finished request so the registry does not grow without bound.
    pub fn unregister(&self, request_id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.remove(request_id);
        }
    }

    /// Cancel everything. Used when the window closes or the document changes.
    pub fn cancel_all(&self) -> usize {
        let g = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        for tx in g.values() {
            let _ = tx.send(true);
        }
        g.len()
    }

    pub fn active_count(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_cancel() {
        let r = SessionRegistry::new();
        let mut rx = r.register("req-1");
        assert!(!*rx.borrow_and_update());
        assert!(r.cancel("req-1"));
        assert!(*rx.borrow_and_update());
    }

    #[test]
    fn cancel_unknown_returns_false() {
        let r = SessionRegistry::new();
        assert!(!r.cancel("nope"));
    }

    #[test]
    fn unregister_removes() {
        let r = SessionRegistry::new();
        let _rx = r.register("a");
        assert_eq!(r.active_count(), 1);
        r.unregister("a");
        assert_eq!(r.active_count(), 0);
        assert!(!r.cancel("a"));
    }

    #[test]
    fn cancel_all_hits_every_request() {
        let r = SessionRegistry::new();
        let mut a = r.register("a");
        let mut b = r.register("b");
        assert_eq!(r.cancel_all(), 2);
        assert!(*a.borrow_and_update());
        assert!(*b.borrow_and_update());
    }
}
