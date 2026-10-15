# Known issues — PaperAI 0.3.0 (AI round)

Severity: **P0** blocks release · **P1** serious · **P2** cosmetic.

Phase-2 issues are carried in `KNOWN_ISSUES_UPDATED.md`; this file covers what
changed or was found in the AI round.

---

## P0

*(none open)*

The three P0-class risks the task named are all closed:

| Risk | Status |
|---|---|
| Key leaking to the frontend or logs | **closed** — no read-back command exists; see `AI_PROVIDER_SECURITY.md` §1 |
| User PDF damaged by a failed save | **closed** — 7 injected failure paths + 8 crash-recovery tests; see `AI_TEST_MATRIX.md` |
| Installer stealing the `.pdf` default | **closed** — candidate-only registration, asserted by Stage C C2.2/C5.4 |

---

## P1

### A-01 — The full AI interaction loop is not automatically verified

`框选 → 解释 → 流式 → 复制 → 追问 → 停止` needs a real mouse in a real window.
CDP against the real WebView2 is unavailable on this machine (K-13), so
`AI-21`, `AI-22` and the visual half of `AI-05`/`AI-09`/`AI-20` are **BLOCKED**,
not PASS.

* What *is* verified: the logic behind every step (48 unit assertions), the
  provider behaviour over a real socket (20 assertions), and that the installed
  app boots and opens a document (upgrade test U2.7).
* Mitigation: `PHASE3_FINAL_VALIDATION.md` §Manual acceptance gives the exact
  click-through for a person to run.
* Blocks: claiming "verified end to end". Does not block daily personal use.

### A-02 — No real-API verification was possible

No DeepSeek key was available, so the online path is **BLOCKED: NO_USER_KEY**.
Everything was verified against the local Mock SSE server, which speaks the same
protocol over a real socket.

* Not a defect: the task explicitly says to mark this BLOCKED rather than fake a
  pass.
* The user can confirm in two minutes: configure a key, click 测试连接, ask a
  question about a selection.

### A-03 — `window.__paperai_ready` still exists in release builds

A read-only boolean, set once at boot so the automated desktop suites can tell
"frontend booted" from "blank window". It exposes no callable surface, and
`scripts/verify-release-bundle.mjs` asserts that nothing *else* survives.

* Accepted deliberately rather than removed: without it, a blank window is
  indistinguishable from a slow one, which is exactly the failure mode that cost
  the most time in Phase 2.
* If a release must have zero observable surface, gate it behind the automation
  flag too and find another readiness signal (the window title works).

### A-04 — Model output rendering is unverified visually

The renderer's *structure* is tested (no forbidden element is ever constructed).
Whether a KaTeX matrix looks right, or whether a long table overflows, needs
eyes. GUI-only; same blocker as A-01.

### A-05 — Empty / scanned pages: no real fixture

`pageHasText()` and the "当前页没有可提取的文字（可能是扫描页）" path exist and
are unit-tested for the empty case, but no actual scanned PDF was prepared. The
claim "handles scanned pages" would be stronger with one.

### A-06 — Chat history is not persisted

By design for this round: closing the app discards the conversation. A user who
expects to reopen a paper and find yesterday's questions will be surprised.

* Mitigation: the panel says 仅本次会话 at the top of an empty transcript.
* If persistence is added, it must be opt-in and must not write paper text to
  disk without saying so.

---

## P2

### A-07 — Model field starts empty for a custom provider

Adding "OpenAI-compatible Custom" pre-fills `https://` and an empty model, so
the first save fails validation with `ai_bad_config`. Correct but abrupt.

### A-08 — Panel width is not remembered

Resizing the AI panel resets on restart.

### A-09 — Only one provider can be default

The schema allows several profiles but the UI always uses the default. Multiple
profiles exist for switching, not for simultaneous use.

### A-10 — Link clicks use `window.open`

Safe (the renderer strips `href` and only an explicit click reaches
`onOpenLink`), but it opens a browser tab rather than the system default browser
via a Tauri shell API. Cosmetically inconsistent on machines where the default
browser is not Edge.

### A-11 — A frontend-only rebuild used to delete the shipped installer

`vite build` empties `dist/`, and the deliverable lives in `dist/installer/`.
Running `npm run build:release` therefore removed
`PaperAI_0.3.0_x64-setup.exe` with no error at all.

* Fixed: `scripts/build.mjs` moves `dist/installer` to `.installer-stash/`
  (outside `dist/`) before bundling and restores it afterwards, reporting how
  many files it preserved. A first attempt stashed inside `dist/.installer-stash`
  and Vite deleted that too.
* Why it earns an entry despite being fixed: a build step that silently deletes
  an artefact is more dangerous than one that fails, because failure is noticed
  and deletion is not.

---

## Carried over from Phase 2, still open

| ID | Item | Status |
|---|---|---|
| K-05 | Windows focus stealing is best-effort | open, untested here |
| K-06 | PDF.js version coupling | open, `pdfjs-dist` pinned at 6.4.299 |
| K-08 | `cargo build` vs `tauri build` exe | open (documentation) |
| K-11 | Erase needs an editing mode first | open, unchanged |
| K-13 | CDP automation unavailable | **root-caused**, alternative path in use |
| K-14 | Test process leakage | **fixed** |
| — | Non-atomic save (two renames) | **mitigated**: recoverable, not atomic |

## Fixed in this round

| ID | Item |
|---|---|
| K-03 | Test bridge removed from release builds (verified by bundle scan) |
| K-07 | `.old` / `.bak` / temp detection, validation, idempotent restore |
| K-14 | Every probe kills the process tree it started |
| — | A document switch let a queued delta land in the *previous* document's transcript |
| — | `![alt](url)` rendered as a clickable link instead of an inert placeholder |
| — | URLs with balanced parentheses were truncated at the first `)` |
| — | `secrets.rs` compared an `HRESULT` against a raw Win32 code, so a missing key surfaced as `ai_secret_store` instead of `ai_no_key` |
