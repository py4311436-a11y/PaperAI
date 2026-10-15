# Phase 3 execution log — AI integration

Chronological record of what was run, what it returned, and why the next step
followed. Timestamps are session time; evidence lives under `evidence/`.

Branches: `phase2` (frozen at `de3e62d`) → **`ai-integration`**.

---

## S0 — baseline and the K-13 investigation

| Step | Result |
|---|---|
| `git status` | clean at `de3e62d`; nothing to stash, no user work at risk |
| `npm ci` / `tsc --noEmit` / `vite build` / `cargo check` | all **PASS** before any edit |
| `pdfjs-dist` | **6.4.299** exact, confirmed from `node_modules`, not just `package.json` |
| Branch `ai-integration` created | `5c199a7` |

### K-13: four experiments

Previous rounds recorded "`--remote-debugging-port` stopped working, cause
unknown". Four experiments settled it:

| # | Experiment | Result |
|---|---|---|
| A | Edge + **fresh** `--user-data-dir` | debug port **up in 1.5 s** |
| A' | Edge + **default** profile | **never up** |
| B | WebView2 + port + fresh dir + anti-throttle | still **down** |
| C | `Win32_Process.CommandLine` for all 24 `msedgewebview2.exe` | `--remote-debugging-port` **stripped**, `--user-data-dir` **overridden** to `com.paperai.desktop\EBWebView`, anti-throttle flags also stripped |
| D | `--remote-debugging-pipe` | stripped; no devtools pipe among 464 |

**Conclusion:** WebView2 does not expose CDP through
`additionalBrowserArguments`. The earlier attempts were not failing for the
reasons assumed (not throttling, not leaked processes, not policy — the policy
keys are empty). Recorded in `AI_S0_BASELINE.md` §4 with the raw output.

Consequence: automation against the real WebView2 is `BLOCKED`, and the round
uses OS-level evidence plus pure-function tests instead.

---

## S1 — provider layer

Built `src-tauri/src/ai/` in one pass, then let the tests find the problems.

| Step | Result |
|---|---|
| `cargo check` | 10 errors on first try: `pub use types::*` missing from `mod.rs`; `CRED_FLAGS`/`HRESULT` type mismatches against the `windows` crate |
| `cargo test --lib` | 30/32 → two failures, both my own assertions (f32→f64 precision; `has_key` matching a naive `key"` substring) |
| Mock SSE server written | `tests/ai-mock/server.mjs`, 16 scenarios, redacts `Authorization` before recording |
| First e2e run | **3/20**, mock saw **0 requests** |
| Diagnosis | the runner used `spawnSync`, which **blocks the Node event loop** — and the mock lives in that same process, so it could never accept a connection. 17 of the failures were manufactured by the harness. |
| Fixed to async `spawn` | **19/20** |
| Last failure | `ai_no_key` surfaced as `ai_secret_store`: `secrets.rs` compared an `HRESULT` against a raw Win32 code (`ERROR_NOT_FOUND` = 1168). The `windows` crate encodes it as `0x8007_0468`. |
| Fixed the comparison | **20/20 PASS** |

Committed as `34bbd20`.

---

## S2 — credentials and settings

Rust side done with S1: `secrets.rs` (Credential Manager, no read-back command),
`settings.rs` (JSON profiles with no secrets, DeepSeek preset). The settings UI
is `provider-settings.ts`, written with S4.

The upgrade test later proved the credential survives a reinstall, reading it
back with the raw Win32 `CredRead`.

---

## S3 + S4 — frontend and safe rendering

| Step | Result |
|---|---|
| `tsc --noEmit` | 12 errors on first run (unused constants, `has_key` on the wrong type, missing `vite/client` types, a missing re-export, a sync/async mismatch) |
| Test harness | Started as a plain `.mjs`, but TypeScript annotations in it are not valid JS. Converting to `.ts` and compiling alongside the sources was cleaner than stripping them — and it means the tests import the **real** sources, so they cannot drift |
| First unit run | **24/27** |
| Failure 1 | markdown: `![alt](url)` was rendered as a **clickable link**, which is not what the model wrote. Now an explicit inert placeholder |
| Failure 2 | wrapping: `2 !== 1` closing tags. Cause: my trailing instruction sentence repeated the tag name in angle brackets, breaking the "exactly one wrapper" invariant the test asserts. Reworded without brackets |
| Failure 3 | **real isolation bug** — switching documents let a queued delta land in the *previous* document's transcript, because `openDocument` cancelled the request but never invalidated the generation counter. Fixed |
| Also fixed | URLs with balanced parentheses were truncated at the first `)` |
| Re-run | **28/28** |
| Markdown suite | **17/19** → two failures, both genuine findings (the image one above, plus the paren truncation). **20/20** after the fixes |

### K-03 in the same pass

| Step | Result |
|---|---|
| First `build:release` + verify | **FAIL** — 3 markers found |
| Inspection | the bridge block *was* tree-shaken; the hits were `__paperaiReady` (a boolean) and `__paperaiPickFile` (the browser fallback) |
| Fixes | the browser fallback is now automation-only; `getSpanRects` moved out of the adapter into the automation block so it is truly absent, not merely unreachable; the verifier tightened to `window.__paperai` with a word boundary |
| Re-verify | release **0 markers**, automation **markers present** — both PASS |

Committed as `c423598`.

---

## S5 — K-07 crash recovery

| Step | Result |
|---|---|
| `recovery.rs` written | read-only `scan`, idempotent `apply` with three actions |
| Crash hooks added to `save_service.rs` | `crash_before_stage`, `crash_after_stage`, `crash_after_replace` |
| `cargo test --lib` | **43/43** |
| `cargo test --test save_crash_recovery` | **5/8** |
| Failure 1 | I placed `crash_before_stage` **after** the staging rename, so it reproduced the wrong state. Moved |
| Failure 2 | tests mutate a process-wide env var while cargo runs them in parallel → `tests/support` serialisation |
| Failure 3 | assertion error of mine: `.bak` is a legitimate candidate; only `.old` is a leftover |
| Re-run | **8/8 PASS**, including the real data-loss window: target gone → restore → byte-identical → second restore is a no-op |

Committed as `6cd27db`.

---

## S7 — release build and upgrade

| Step | Result |
|---|---|
| Version → `0.3.0` in `package.json`, `tauri.conf.json`, `Cargo.toml` | done |
| `build.mjs --release` + verify | **PASS**, 0 bridge markers |
| `tauri build` | `PaperAI_0.3.0_x64-setup.exe`, 5,726,436 bytes |
| Installer hook check | `!include installer-hooks.nsh` present in the generated script — the K-01 fix survived |
| `tests/windows-upgrade.mjs` | **10/11** |
| Failure | U2.2 reported mojibake. Cause: PowerShell `Get-Content` decodes UTF-8 with the system ANSI codepage (GBK here), so the Chinese `display_name` was mangled **in the test's view only**. The file was fine. Fixed by reading with `[IO.File]::ReadAllText(..., UTF8)` and asserting on ASCII markers plus the Chinese |
| Re-run | **11/11 PASS** |
| `tests/windows-integration.mjs` on 0.3.0 | **17/17 PASS** |

---

## Totals

| Suite | Count |
|---|---|
| `cargo test --lib` | 43 |
| `cargo test --test save_crash_recovery` | 8 |
| `run-ai-rust-tests.mjs` (vs Mock SSE) | 20 |
| `run-ai-unit-tests.mjs` | 48 |
| `windows-integration.mjs` | 17 |
| `windows-upgrade.mjs` | 11 |
| **Total** | **119** |

Blocked: `desktop-verify.mjs` (19), `save-safety.mjs` (12) — CDP, K-13.
Their Rust-level equivalents pass.

## Bugs found by the tests, and fixed

| # | Bug | Where |
|---|---|---|
| 1 | A document switch let a queued delta land in the previous document's transcript | `chat-controller.ts` |
| 2 | `![alt](url)` rendered as a clickable link | `markdown-renderer.ts` |
| 3 | URLs with balanced parentheses truncated | `markdown-renderer.ts` |
| 4 | Wrapper invariant broken by my own instruction sentence | `context-builder.ts` |
| 5 | `HRESULT` vs Win32 code → wrong error for a missing key | `secrets.rs` |
| 6 | `crash_before_stage` hook placed after the staging rename | `save_service.rs` |
| 7 | Harness: `spawnSync` froze the in-process Mock server | `run-ai-rust-tests.mjs` |
| 8 | Harness: parallel tests sharing an env var | `tests/support` |
| 9 | Harness: `Get-Content` encoding produced a false failure | `windows-upgrade.mjs` |

Bugs 7–9 are test-harness defects, not product defects. They are recorded
because a harness bug that manufactures a red result is exactly as misleading as
one that manufactures a green one.
