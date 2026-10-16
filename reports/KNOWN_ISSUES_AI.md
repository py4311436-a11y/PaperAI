# Known issues — PaperAI 0.3.1 (AI round)

Severity: **P0** blocks release · **P1** serious · **P2** cosmetic.

Phase-2 issues are carried in `KNOWN_ISSUES_UPDATED.md`; this file covers what
changed or was found in the AI round.

0.3.1 is a single-bug patch over the shipped 0.3.0: **A-12**, reported by the
user against the installed build. Everything else here is unchanged from 0.3.0.

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
* **Superseded by A-13**: this kept the files alive, but keeping them in `dist/`
  at all meant the bundler picked them up. Deliverables now live in `release/`
  and the stash is gone. The lesson is the same one twice — protecting a file
  from one process is not enough if another process reads that directory.
* Why it earns an entry despite being fixed: a build step that silently deletes
  an artefact is more dangerous than one that fails, because failure is noticed
  and deletion is not.

### A-12 — FIXED in 0.3.1: `hidden` did nothing on three overlays (user-reported)

**Reported by the user against the shipped 0.3.0 build:** the AI settings dialog's
关闭 button was clicked and the dialog stayed on screen.

Root cause is a CSS cascade rule that is easy to get wrong and hard to see:

* `element.hidden = true` does not hide anything by itself. It relies on the
  user-agent stylesheet's `[hidden] { display: none }`.
* That rule lives in the **user-agent origin**, so *every* author declaration
  beats it — **specificity is never even consulted**. The author rule
  `#ai-settings { display: flex }` therefore won, and the "hidden" overlay
  rendered at `display: flex`.
* The same held for `#ai-panel` and `#selection-bar`. All three are constructed
  at module load with `hidden = true`, so all three were **visible from launch
  and could not be dismissed** — the chat panel's toggle button and the
  selection bar's hide() were both no-ops on screen.

Fixed by one global rule in `src/style.css`:

```css
[hidden] { display: none !important; }
```

`!important` is load-bearing here: it has to outrank ID selectors. `#recovery-modal`
is covered too, though it currently dismisses itself with `.remove()` rather than
`hidden` — it is listed as *latent* rather than *live* in the test for that reason.

Regression test: `tests/overlay-visibility.mjs` (`npm run test:ui-overlay`).
A DOM shim cannot catch this class of bug, because cascade and computed style are
exactly what a shim does not implement. So it drives a **real headless Chromium**
(`getComputedStyle` over CDP) and asserts, for every overlay, that hidden→`none`,
unhidden→visible again, and hidden→`none` once more. It was confirmed to FAIL
(4/12, all four stuck at `display: flex`) before the fix and PASS (15/15) after.

Why it reached a shipped build: all 119 prior assertions tested logic, not
rendering. The `hidden` attribute was set correctly — the DOM was right and the
screen was wrong. Nothing short of a real layout engine could have caught it.

Also in this fix: Escape now closes the settings dialog. It previously had only
the backdrop-click and the button, and the Escape path was missing entirely.

### A-13 — FIXED in 0.3.1: the installer was nesting previous installers

`tauri.conf.json` sets `frontendDist: "../dist"`, so **everything** in `dist/`
is embedded into the binary and then into the setup.exe. The A-11 fix (below)
had moved the shipped setup files to `dist/installer/` to protect them from
`vite build` — which put them straight into the next bundler's input.

Consequence: `PaperAI_0.3.1_x64-setup.exe` came out at **22.25 MiB**, containing
`PaperAI_0.3.0_x64-setup.exe` and `PaperAI_0.2.0_x64-setup.exe` nested inside it.
Each release would have swallowed all the previous ones.

Two further things fell out of the size investigation:

* **Source maps were in the release bundle.** `vite.config.ts` had
  `build.sourcemap: true` unconditionally — 3.3 MiB of `*.map` shipped inside
  the installer, and with them the original TypeScript. Maps are now produced
  only when `VITE_PAPERAI_AUTOMATION=1`, i.e. for test builds that are never
  distributed.
* `dist/` was 25.97 MiB of which only ~6 MiB was ever frontend.

Fixes:

* Deliverables moved to `release/`, outside every directory the bundler reads.
* `scripts/collect-release.mjs` copies the built setup there and prints size +
  SHA-256, refusing to pass a file above a 12 MiB sanity bound.
* `scripts/build.mjs` now **fails the build** if `dist/` contains anything other
  than `assets/`, `index.html`, `cmaps/` or `standard_fonts/`. This is the part
  that actually prevents recurrence: the previous mistakes were all silent.
* `scripts/size-report.mjs` breaks down `dist/` by top-level entry.

Net effect: `dist/` 25.97 → 6.14 MiB; installer 22.25 → 5.46 MiB.

The A-11 stash workaround is gone. It only existed because the deliverable was
inside `dist/`; now that it is not, `vite build` emptying `dist/` is harmless
and the right behaviour.

---

### A-18 — FIXED in 0.5.0: Highlight could not be armed on its own; Erase deleted the wrong thing

User-reported 2026-10-16: "highlight 还是没法直接点亮和选择，我用了下发现只有先选中文件再选 highlight 才有用";
"擦除不是我理解的擦除，这个怎么是直接擦除上一笔，并不是我想要的擦除某一个位置".

**Highlight.** The button ran `doHighlight()`, which only acted when a DOM text
selection already existed and otherwise warned. It was an *action*, not a mode,
so it could not be pressed on its own. Now it always enters HIGHLIGHT mode
first — the button lights, the editor is in highlight mode, and dragging over
text highlights it — and if there happens to be a selection it highlights that
too, exactly as before. `highlightSelection()` also had a related defect: it
returned the document's *total* annotation count, so a failed highlight on a
document that already had highlights looked like a success. It now returns what
this call created.

**Erase.** The handler checked for a selection and deleted immediately. PDF.js
keeps a freshly drawn ink editor selected, so pressing Erase after drawing
removed *that stroke* — which reads as "it undid my last action" rather than "it
erases what I point at". PDF.js has no eraser editor and no public per-annotation
hit test, so the fix is a two-step contract:

1. pressing Erase **arms** it and deletes nothing, ever;
2. a click inside the page deletes only if it landed on an annotation — decided
   by `tools/erase-policy.ts`, a pure function whose whole rule set is "armed
   AND hit an annotation AND PDF.js selected something";
3. the hit test is a DOM check for `data-editor-rotation`, which every editor's
   root div carries. It deliberately does not touch `AnnotationEditorUIManager`'s
   private `#editors` map: if a future pdfjs-dist renames it, erasing degrades
   to "no hit" instead of throwing or deleting the wrong annotation;
4. it stays armed after a delete (removing several in a row is the common case),
   and `Escape` leaves the armed state.

Tests: 6 pure-function assertions including the full truth table (only
`armed ∧ hit ∧ selected` deletes) and a guard against a future "simplification"
to `armed && selected`, which is exactly the bug. The real-Chromium suite grew
to 12 assertions covering "pressing Erase deletes nothing", "a click on empty
paper deletes nothing (the leftover selection survives)", "clicking annotations
deletes them, repeatedly", and "after Escape, clicking deletes nothing".

### A-19 — NEW in 0.5.0: per-document reading memory (chunked summarisation)

Requested 2026-10-16: read a paper too long for one request by sending it in
chunks, keep the notes in a file beside the PDF, and load them next time so the
memory survives. The user chose: sidecar next to the PDF; both a manual button
and automatic appends after whole-document answers; raise the single-shot limit
first and chunk only what still does not fit.

* `whole-document` budget raised 120k → 160k characters (~50k tokens), still
  inside a 64k window. Deliberately not higher: past ~64k a gateway with a 64k
  window rejects the request outright, and a hard 400 is worse than a labelled
  truncation plus the chunked path.
* `src/ai/memory.ts` plans chunks (pure), asks per chunk for structured notes
  rather than prose, merges **only the notes** (never re-sending the paper) into
  one overview, and assembles the sidecar body reproducibly.
* `src-tauri/src/ai/memory.rs` owns the disk: a marker line identifies files we
  wrote, and **a target without the marker is refused** so a user's own
  hand-written `*.paperai-notes.md` is never overwritten. 2 MiB cap; temp-file +
  rename; oldest Q&A entries are trimmed rather than the write being refused.
* `ai_ask_once` collects a whole reply in Rust — reusing the streaming provider
  unchanged — because the pipeline must not store a half-received note as if it
  were complete.
* Notes come back as a `<reading_memory>` block framed as *prior background*
  with "以原文为准", capped at 20k characters, and **structurally escaped**: the
  note body goes through the same marker-neutralising as document text. The first
  version did not, and the test caught it — a note containing `</reading_memory>`
  could have closed the block early and the rest read as instructions.
* The panel shows a "阅读笔记" row: absent / enabled with size, coverage and
  time, and a busy state that disables the button so a long run cannot be
  started twice.

Tests: 11 Rust (path derivation, round trip, foreign-file refusal both ways, size
cap, append/trim, no stray temp file, timestamp, date conversion), 19 frontend
(chunk packing: every page exactly once, budget respected, oversized page kept,
blank pages free, empty document, reproducible document body, context escaping),
4 panel assertions for the memory row, and 2 real-socket tests that a collected
answer contains every delta.

### A-17 — FIXED in 0.4.4: formulas showed raw LaTeX; toolbar lit the wrong tool

User-reported 2026-10-16, two symptoms in one round.

**(a) The transcript showed raw LaTeX.** A whole-document answer came out with
`\[`, `\]`, `\varepsilon`, `\sum_i` visible as literal text, and formulas such
as `T_j^(k+1)` sat in the prose untypeset. Root cause: the renderer understood
`$$...$$` and `\(...\)` but **not `\[...\]`**, which is what models trained on
LaTeX documents actually emit for display math. A second, smaller defect: a
`$$...$$` pair *inside a line* fell through to the single-`$` inline rule, so it
rendered as a literal `$x$` — a display formula silently demoted to inline text
with two orphan `$` characters.

Fixes: `\[...\]` is now recognised both as a block (own line) and inline;
`$$...$$` inside a paragraph produces one `md-math-display` span and leaves no
stray dollar text; `$$` is matched before the single-`$` rule for exactly that
reason. Verified in a real browser with KaTeX enabled — the reported formula
now renders as `∣Tj(k+1)−Tj(k)∣<ε` with no raw marker.

**(b) The toolbar lied about the active tool.** Three defects, one cause —
the lit button was written in more than one place, or not at all:
* `Highlight` ran `doHighlight()` and never touched the indicator, so the user
  kept looking at a lit **Select** while the editor was in HIGHLIGHT mode;
* `Erase` had **no `tool` class** in `index.html`, so `setTool`'s
  `querySelectorAll(".tool")` sweep skipped it and it could never be lit —
  literally zero buttons active;
* `Erase` armed itself by entering ink mode, which lit **Draw**: pressing
  Erase appeared to activate a different tool.

Fixes: one `setToolbarState()` owns the indicator; `erase` is modelled as its
own toolbar state (it is an action, not a `ToolMode` — PDF.js has no eraser
editor, deleting needs a selected annotation) and is lit on its own button with
an extra `armed` style; `doHighlight` reports the mode the editor is actually
in; `Escape` leaves the armed state, and it stays armed after a delete so
several annotations can be removed in a row.

Tests: 7 new markdown assertions (delimiters and structure — with KaTeX off the
renderer *deliberately* prints the formula source, so the tests assert markers
and element structure, never "no LaTeX commands") and a real-Chromium suite
(`tests/toolbar-state.mjs`, 8 assertions) that reads the **real** toolbar markup
out of `index.html` rather than a hand-typed copy.

Negative controls: removing the `\[...\]` support fails 3 markdown assertions
with exactly the reported symptom (`收敛判据 \[|T_j^{(k+1)}...`); removing the
`tool` class from Erase and the indicator update from `doHighlight` fails 5 of
8 browser assertions, with `btn-erase->[]` (no button lights at all).

### A-16 — FIXED in 0.4.3: long answers were cut off at exactly 15 s (user-reported)

User-reported 2026-10-16: a whole-document question on DeepSeek produced visible
thinking/reasoning output and was then interrupted with `ai_timeout`
("连接超时。请检查网络、代理或 Base URL。") — while the network was fine.

Root cause: `run_chat` put `.timeout(CONNECT_TIMEOUT)` on the **streaming**
request. In `reqwest`, `RequestBuilder::timeout()` is a *total* deadline —
"applied from when the request starts connecting until the response body has
finished" — and it overrides the client-level setting. `CONNECT_TIMEOUT` is 15 s,
so **every completion longer than 15 seconds was truncated mid-answer** and
reported as a transport timeout. The client had the same mistake at a larger
scale (`.timeout(IDLE_TIMEOUT)` = a 120 s total, not an idle, timeout).

This is inherent to total deadlines on streams: a reasoning model spends its
first phase emitting `reasoning_content`, and a whole-document summary is slow
by nature. A total deadline does not protect a stream, it truncates it.

Fixes:

* `client::build_client` no longer sets any total timeout. It uses
  `connect_timeout` for the TCP/TLS phase and `read_timeout` for each
  individual read (which resets after every successful read), so a live but
  slow stream is never cut off.
* The per-request `.timeout(CONNECT_TIMEOUT)` is gone from `run_chat`. Stall
  protection lives in the event loop, where it can tell the two failure modes
  apart: nothing received at all (`ai_first_token_timeout`, "check the Base URL
  and model") versus output that stopped half-way (`ai_timeout`, "interrupted
  during generation, retry or use a smaller context"). Before, both said
  "waiting for the model timed out", which is false in the second case.
* The exchange as a whole is deliberately unbounded — the user can press stop,
  and any cap here would be a silent truncation. Documented in the module
  comment so the next reader does not "fix" it back.
* `probe_connection` / `list_models` **keep** a total budget (`PROBE_TIMEOUT`):
  those are small non-streaming requests where a whole-exchange deadline is
  correct. They now carry a comment saying which case they are, because the
  distinction is what caused this bug.
* The frontend no longer discards a partial answer: text that arrived before
  the failure stays on screen above the error box, marked "以上是中断前已生成的
  内容". `humanError` now prefers the backend's specific wording for the two
  timeout codes instead of flattening both into "check your network".

Tests: `a_long_stream_is_not_truncated_mid_answer` drives a real socket against
a mock that streams 24 chunks at 900 ms (~21 s, never idle for more than a
second) and asserts all 24 arrive; `a_stream_that_stops_mid_answer_is_reported_
as_interrupted` asserts the opposite case — content then silence — is reported
as an interruption and keeps its text. Plus 7 frontend assertions for the
partial-content and error-wording behaviour.

Negative control: restoring `.timeout(Duration::from_secs(15))` makes the long
stream test fail **at 15.02 s**, reproducing the user's failure exactly; the
panel-side control (removing the partial-content block) fails the two frontend
assertions that cover it.

### A-15 — FIXED in 0.4.2: the panel could not switch provider or model (user-reported)

User-reported 2026-10-16: the AI panel header showed `DeepSeek（升级前配置）· dee…`
as static text with no way to change it, so the app always answered with whichever
profile happened to be the default.

Root cause: `ChatPanel` had a `setModelLabel(text)` that wrote a `<span>`. The
pickers lived only in the settings dialog, and `main.ts` always resolved the
active profile as `current ?? is_default ?? first`.

Fix:

* The header now carries two real `<select>` elements — `ai-profile-select` and
  `ai-model-select` — and `setModelLabel` is gone.
* Switching provider re-points the chat session at that profile; switching model
  is **persisted through `ai_save_profile`**, because the request path reads the
  model from the saved profile and an in-memory choice would revert on restart.
* The model box always keeps the model currently in use, even when the live
  catalogue omits it (marked `当前（不在列表中）`), filters `incompatible` models,
  shows a loading/failure note instead of an empty box, and both controls freeze
  while a request is in flight.
* `main.ts` caches one catalogue per provider (keyed by base URL, so editing the
  URL in settings invalidates it) and drops a late reply that lost a provider race.

Tests: 12 DOM-shim unit assertions (`tests/ai-unit/panel-picker.test.mjs`) and 9
real-Chromium assertions (`tests/panel-model-switch.mjs`, real stylesheet inlined,
geometry asserted — two pickers plus three buttons must fit the 380px panel).
Both suites were negative-controlled: removing the change handlers fails 2 of 12,
and putting the old `<span>` back fails Q1/Q2 in the browser suite.

### A-14 — OPEN (provider-side, not fixable here): Zen free models reject PaperAI with 403 FreeTierError

User-reported 2026-10-16: the `opencode-zen` preset (default model
`deepseek-v4.1-flash-free`, no API key configured) fails the connection test
with `403 FreeTierError — OpenCode's free tier can only be used from within
OpenCode` (`ai_unauthorized`).

This is an **OpenCode server-side policy**, not a PaperAI defect:

* Since ~2026-09-16 the anonymous free lane on `https://opencode.ai/zen/v1`
  rejects every request that does not originate from the official OpenCode
  client. Probed gates included client User-Agent, `ses_`-shaped session ids,
  required `bash`/`read` tool stubs in the body, and caller IP reputation.
* Third-party clients that spoofed all of those (pi-opencode-zen,
  dsh-opencode-zen, …) worked briefly; the lane was fully closed to
  non-official clients by ~2026-09-23 and those plugins are now
  deprecated/archived by their own maintainers.
* The paid Zen lane (`zen/v1` with a funded API key) and the OpenCode Go
  subscription lane (`inference/go/v1`) remain open to external clients —
  both already work in PaperAI.

Decision: no workaround is implemented. Spoofing a third party's client
identity to consume its free tier is both against the provider's intent and
fragile (already proven dead upstream). Users who want free models use them
inside the OpenCode app; users who want in-app AI use DeepSeek official,
OpenCode Go (subscription), or a funded Zen key on paid models. The server's
own message is surfaced verbatim in the settings status area, which is the
honest explanation. Documented in the `opencode_zen_preset` doc comment.

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
| A-12 | `[hidden]` beat by author `display:` rules — three overlays could not be hidden (real-Chromium test added) |
| A-13 | Installer nested the previous installers; source maps shipped. Deliverables moved to `release/`, `dist/` guarded |
| — | A document switch let a queued delta land in the *previous* document's transcript |
| — | `![alt](url)` rendered as a clickable link instead of an inert placeholder |
| — | URLs with balanced parentheses were truncated at the first `)` |
| — | `secrets.rs` compared an `HRESULT` against a raw Win32 code, so a missing key surfaced as `ai_secret_store` instead of `ai_no_key` |
