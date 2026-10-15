# PaperAI 0.4.0 — final validation

Date: 2026-10-15 · Branch `ai-integration` · Version **0.3.0**

---

## 1. Executive summary

**The round's goal is met: PaperAI now opens a PDF, lets you select text, and
answers questions about it through any OpenAI-compatible endpoint, with the
answer streamed into a side panel — while keeping every Phase-2 behaviour
intact.**

**The verification is Mock-only.** No real API key was available, so the online
path is `BLOCKED: NO_USER_KEY` and is not claimed as verified. Every protocol
behaviour was exercised against a **real local SSE server over a real socket**
(`tests/ai-mock/server.mjs`, 16 scenarios), not a stub.

The AI interaction loop in a real window — 框选→解释→流式→复制→追问→停止 — is
**BLOCKED** by this machine's inability to drive the WebView2 (K-13). The
manual click-through is in §8.

| Stage | Outcome |
|---|---|
| S0 environment / baseline | **PASS** — `AI_S0_BASELINE.md` |
| S1 provider + streaming + cancel | **PASS** — 20 e2e assertions against Mock SSE |
| S2 credentials + settings | **PASS** (Logic+Rust) / **BLOCKED** (GUI visuals) |
| S3 selection + context | **PASS** — 20 unit assertions |
| S4 chat panel + safe rendering | **PASS** (logic) / **BLOCKED** (visuals) |
| S5 K-03 / K-07 / K-13 | **FIXED / MITIGATED / ROOT-CAUSED** |
| S6 test matrix | 119 assertions green, 4 BLOCKED, 5 PARTIAL |
| S7 installer + upgrade + uninstall | **PASS** — 17/17 and 13/13 |
| **0.3.1 patch** (A-12 + A-13) | **PASS** — 164 assertions green; see §11 |

### 0.3.1 — what the user found, and what it turned up

The user installed 0.3.0 and reported one bug: **the AI settings dialog's 关闭
button did nothing.** Root cause and fix in §11. Chasing it surfaced two more
 defects that had shipped — three overlays that could not be hidden at all, and
 an installer that was nesting every previous installer inside itself. All three
 are fixed and covered by new automated tests. The user's own configuration and
 stored key were verified intact, byte for byte, afterwards.

---

## 2. Deliverable

| | |
|---|---|
| Path | `D:\AIreader\PaperAI-PoC\release\PaperAI_0.4.0_x64-setup.exe` |
| Size | 5,000,040 bytes (4.77 MiB) |
| SHA-256 | `b4cbd6a4004eb1c9649813d2408f752bc5750a4bf6bf02dbf6af95cef7cfab0c` |
| Built | 2026-10-15 22:33 |
| Signature | **unsigned** — Windows will show "unknown publisher". Nothing bypasses SmartScreen. |
| Installs to | the directory chosen at first install (NSIS remembers it and reuses it). On this machine: `D:\Program Files\PaperAI\`. Current user, no elevation. |
| Settings live in | `%LOCALAPPDATA%\PaperAI\` — a separate directory from the binary. |
| Flavour | release — test bridge verified absent |

Previous build kept for the upgrade test:
`PaperAI_0.2.0_x64-setup.exe`, 11,681,450 bytes,
`3f5a840984c851603b9d87232f0f9b77312a62b88a6174133961ccdd26e69635`.

The 0.3.0 bundle being much smaller is expected: it is built without the
instrumented NSIS run that produced the 0.2.0 artefact.

---

## 3. What changed

Fifteen new source files, no removals from the PDF core.

**Rust** (`src-tauri/src/`) — new `ai/` module: `mod.rs` (11 IPC commands),
`provider.rs`, `stream.rs`, `client.rs`, `secrets.rs`, `settings.rs`,
`config.rs`, `session.rs`, `types.rs`; new `recovery.rs`; crash hooks added to
`save_service.rs`; commands registered in `lib.rs`.

**Frontend** (`src/`) — new `ai/` module: `types.ts`, `selection-snapshot.ts`,
`selection-bar.ts`, `context-builder.ts`, `chat-controller.ts`, `chat-panel.ts`,
`markdown-renderer.ts`, `provider-settings.ts`, `style.css`; `bridge.ts` gained
the AI and recovery calls; `main.ts` rewired; `index.html` gained the split
layout and the AI toggle; `pdfjs-adapter.ts` gained read-only `getPageText`
and `currentPage`, and lost `getSpanRects` (moved into the automation bridge).

**Tests / scripts** — `tests/ai-mock/server.mjs`, `tests/ai-unit/*`,
`src-tauri/tests/{ai_provider,save_crash_recovery}.rs`,
`tests/windows-upgrade.mjs`, `scripts/run-ai-rust-tests.mjs`,
`run-ai-unit-tests.mjs`, `build.mjs`, `verify-release-bundle.mjs`,
`probe-cdp-*` diagnostics.

Dependencies added: `reqwest` (rustls), `tokio`, `futures-util`, `uuid`,
`windows` (Credential Manager), `katex@0.16.25` (MIT, bundled locally).

**`pdfjs-dist` is still pinned at exactly `6.4.299`.** Every Phase-2 PDF
behaviour is unchanged.

---

## 4. Does the key ever reach the frontend?

**No.** There is no command that returns it:

```
ai_set_key / ai_has_key / ai_delete_key      (no get_api_key)
```

`secrets::read_secret` is `pub(crate)` with one caller — the HTTP client
building `Authorization`. The UI can show 已配置 / 未配置 and nothing else.
Full analysis: `AI_PROVIDER_SECURITY.md` §1.

---

## 5. Test results

| Suite | Command | Result |
|---|---|---|
| Rust unit | `cargo test --lib` | **43/43 PASS** |
| Rust crash recovery | `cargo test --test save_crash_recovery` | **8/8 PASS** |
| Provider vs Mock SSE | `node scripts/run-ai-rust-tests.mjs` | **20/20 PASS** |
| Frontend logic | `node scripts/run-ai-unit-tests.mjs` | **48/48 PASS** |
| Windows integration | `node tests/windows-integration.mjs` | **17/17 PASS** |
| Upgrade 0.2.0 → 0.3.0 | `node tests/windows-upgrade.mjs` | **11/11 PASS** |
| K-03 release bundle | `verify-release-bundle.mjs dist` | **PASS** (0 markers) |
| K-03 automation bundle | `verify-release-bundle.mjs dist --expect-present` | **PASS** |

The AI-specific matrix (AI-01 … AI-28) is in `AI_TEST_MATRIX.md`.

### Blocked, and why

| Item | Blocker |
|---|---|
| `desktop-verify.mjs` (19), `save-safety.mjs` (12) | Need CDP against the real WebView2; K-13. Their Rust-level equivalents pass. |
| AI-21, AI-22 (UI responsiveness, full click loop) | Same |
| AI-05 / AI-09 / AI-20 visuals | Same |
| AI-16 real scanned page | No fixture prepared |
| AI-28 online call | `BLOCKED: NO_USER_KEY` |

---

## 6. K-03 / K-07 / K-13

### K-03 — test bridge in release builds: **FIXED**

The bridge is now compiled only when `VITE_PAPERAI_AUTOMATION=1`, a statically
known constant, so Rollup removes the whole block. Verified by scanning the
emitted JavaScript with `scripts/verify-release-bundle.mjs`:

* `build:release` → **0** markers found
* `build:automation` → markers present, so the automated suites still work

One subtlety worth recording: `getSpanRects` used to live on the adapter, and a
class method survives tree-shaking even when unreachable. It was moved into the
automation block so it is genuinely absent rather than merely not exposed.
The browser file-picker fallback was gated the same way. `window.__paperai_ready`
(a read-only boolean used as a boot signal) is retained — see `KNOWN_ISSUES_AI.md`
A-03.

### K-07 — save crash recovery: **MITIGATED, not atomic**

The save is still two renames. This round makes the failure state detectable and
recoverable instead of pretending otherwise:

* `recovery::scan()` is read-only and validates a candidate (header, trailer,
  minimum size) **before offering it**; a truncated `.old` is reported as
  `recover_invalid`, never presented as a rescue.
* `recovery::apply()` is idempotent. `restore_old` displaces a healthy target to
  `.superseded` rather than deleting it; `keep_new` **refuses** when the target
  is missing or corrupt, because that would destroy the only surviving copy.
* Fault injection now covers all three rename boundaries. The
  `crash_after_stage` test reproduces the data-loss window for real: the target
  is genuinely gone, the restore returns it byte-identical, and a second restore
  is a no-op.

Eight tests, all on copies in the temp directory. No user PDF is touched.

### K-13 — CDP not reproducible: **ROOT-CAUSED, alternative path in use**

Four experiments (`AI_S0_BASELINE.md` §4) established the cause:

* Edge with a **fresh** `--user-data-dir` opens a debug port in 1.5 s; with the
  **default** profile it never does (Chromium 136+ hardening).
* WebView2 still fails with a fresh directory.
* **Decisive:** all 24 `msedgewebview2.exe` children have
  `--remote-debugging-port` **stripped** and `--user-data-dir` **overridden** to
  `com.paperai.desktop\EBWebView`. `--remote-debugging-pipe` is stripped too,
  and no devtools pipe exists among 464.
* No Edge/Chromium policy is involved.

So CDP against the real WebView2 is not achievable on this machine. The
replacement evidence is OS-level and re-runnable: the native window title, the
`PrintWindow` capture, the pure-Node annotation read-back, and byte/pixel
checks. In-process logic is covered by the 48 unit assertions that need no
browser at all.

### K-14 — test process leakage: **FIXED**

Every probe now kills the process tree it started, in `finally`, by PID. No more
blanket `Stop-Process msedgewebview2`.

---

## 7. Installer behaviour

| Check | Result |
|---|---|
| Silent install (`/S`), exit 0 | **PASS** |
| Installs to `%LOCALAPPDATA%\PaperAI\` | **PASS** |
| Start-menu shortcut, uninstall entry | **PASS** |
| `.pdf` "Open with" candidate registered **by the installer** | **PASS** |
| Default PDF reader unchanged (`MSEdgePDF` before and after) | **PASS** |
| CJK + space paths via CLI | **PASS** |
| Single instance; second launch hands the file over | **PASS** |
| Uninstall: exe gone, entries gone, association removed | **PASS** |
| Uninstall does **not** touch other apps' credentials | **PASS** |

Upgrade 0.2.0 → 0.3.0 (11/11):

| Check | Result |
|---|---|
| Version really changes | **PASS** |
| `ai-profiles.json` survives | **PASS** |
| Credential survives (verified with raw `CredRead`) | **PASS** |
| `.pdf` association still present | **PASS** |
| Default reader unchanged | **PASS** |
| User PDFs byte-identical (11 files, sample SHA-256) | **PASS** |
| Upgraded app opens a PDF | **PASS** (native title `PaperAI — IEEE 双栏 论文 副本.pdf`) |

---

## 8. Manual acceptance (needs a real desktop)

Everything below is the part automation could not cover. Ten minutes.

1. Install `PaperAI_0.3.0_x64-setup.exe`, launch from the Start menu.
2. Open an IEEE two-column paper. Confirm pages render and both columns select
   independently.
3. **Settings** (toolbar `AI` → 设置): type `API Key` is at least one real key.
   Click **测试连接**. Expect 连接正常 with a round-trip time. This is the only
   step that needs the network.
4. Select a sentence. A small bar appears: 高亮 解释 翻译 复制.
   * Click **解释** — the right panel opens, shows `第 N 页 · 选中文字 …`, and
     an answer streams in. **The selection must survive the click** (that is the
     A-01 scenario).
   * Click **停止** mid-answer. Generation stops and the turn is marked 已停止.
   * Click **复制** on the answer and paste into Notepad — Chinese and formulas
     must survive.
5. Ask a follow-up in the input box. The answer must use the new question while
   the paper stays scrolled where you left it. Zoom and draw **while** it
   streams — the PDF must not stutter.
6. Switch 上下文 to 当前页 and back to 选中文字. Each answer must be based on the
   mode shown, and the label on the turn must say which.
7. Open a **second** PDF (double-click it) with unsaved annotations. Expect the
   保存/不保存/取消 prompt. Switch — the new document's chat must be empty, and
   the first document's chat must still be there when you switch back.
8. Turn off the network and ask again. Expect a clear 网络错误, no hang.
9. Close the app. Reopen it: the chat is gone (by design), the annotations are
   still in the saved PDF.

Report anything that fails, with the error code shown in the panel — the codes
are stable and map to the table in `AI_PROVIDER_SECURITY.md` §2.

---

## 9. Reproduce without any API key

```bash
source scripts/env.sh
npm ci
node scripts/build.mjs --release
node scripts/verify-release-bundle.mjs dist          # K-03

cd src-tauri
cargo test --lib                                      # 43
cargo test --test save_crash_recovery                 # 8
cd ..

node scripts/run-ai-rust-tests.mjs                    # 20 (starts its own mock)
node scripts/run-ai-unit-tests.mjs                    # 48

node tests/windows-upgrade.mjs                        # 11
node tests/windows-integration.mjs \
     --installer release/PaperAI_0.4.0_x64-setup.exe   # 17
```

To try a provider by hand, start the mock and point the app at it:

```bash
node tests/ai-mock/server.mjs --scenario slow --port 8788
# in PaperAI settings: Base URL http://127.0.0.1:8788 , Model mock-model ,
# API Key anything (the mock ignores it but Rust requires one to be stored)
```

Nothing in any of these steps requires a real key, and none of them writes to a
file outside the project or the OS temp directory.

---

## 10. Remaining issues

Ordered; full list in `KNOWN_ISSUES_AI.md`.

| ID | Sev | Item | Blocks daily use? | Blocks public release? |
|---|---|---|---|---|
| A-01 | P1 | AI loop not automatically verified (K-13) | no | yes — needs one manual pass |
| A-02 | P1 | No real-API verification | no | yes — one 测试连接 by the user |
| A-03 | P1 | `__paperai_ready` boolean in release | no | no (deliberate) |
| A-04 | P1 | Model rendering unverified visually | no | yes — part of the manual pass |
| A-05 | P1 | No scanned-page fixture | no | no |
| A-06 | P1 | Chat history not persisted | no (by design) | no |
| A-07…A-10 | P2 | Model field prefill, panel width, single default profile, link opens a tab | no | no |
| K-05/K-06/K-08/K-11 | P2 | Carried over from Phase 2, unchanged | no | no |

**Verdict: fit for daily personal use after the §8 pass. Not yet fit for public
release** — the AI loop has not been exercised by a human, and no real provider
has been contacted.

---

## 11. The 0.3.1 patch

0.3.0 was installed and used by the user. One bug was reported; investigating it
found two more shipped defects. All three are fixed here.

### A-12 — the reported bug: 关闭 did nothing

`element.hidden = true` does not hide anything on its own — it relies on the
user-agent stylesheet's `[hidden] { display: none }`. That rule is in the
**user-agent origin**, so every author declaration beats it and **specificity is
never consulted**. The author rule `#ai-settings { display: flex }` therefore
won. The attribute was set correctly the whole time; the dialog simply stayed on
screen.

The same held for `#ai-panel` and `#selection-bar`, and all three are created at
module load with `hidden = true` — so the chat panel's toggle button and the
selection bar's `hide()` had also been no-ops since launch. Fixed by one rule:

```css
[hidden] { display: none !important; }
```

`!important` is load-bearing: it has to outrank ID selectors. Escape now also
closes the settings dialog; previously there was no keyboard path at all.

**Why the existing 119 assertions missed it:** they test logic, not rendering.
The DOM was correct and the screen was wrong. This needed a real layout engine.

New test `tests/overlay-visibility.mjs` (`npm run test:ui-overlay`) drives
**headless Edge over CDP** and asserts `getComputedStyle().display` for every
overlay in three states (hidden → `none`, shown → visible, hidden again →
`none`). Run against the **pre-fix** build it fails 4/12 with all four overlays
stuck at `display: flex`; against the fixed build it passes 15/15. A
`control/ai-stop` case pins the trigger to "an author `display` rule", since that
button never had one and always worked.

Note this is the same CDP path that K-13 blocks for the app: CDP works fine for
an **independent** Edge launched with a fresh `--user-data-dir`. K-13 is specific
to the WebView2 host, which strips the flag.

### A-13 — the installer contained the previous installers

Found while sanity-checking the new build's size: 22.25 MiB instead of ~5 MiB.

`tauri.conf.json` sets `frontendDist: "../dist"`, so **everything** in `dist/`
is embedded into the setup.exe. The A-11 fix had moved shipped setup files to
`dist/installer/` to protect them from `vite build` — straight into the next
bundler's input. 0.3.1 shipped with 0.2.0 and 0.3.0 nested inside it, and each
release would have swallowed all the previous ones.

Also found: `vite.config.ts` had `sourcemap: true` unconditionally, so 3.3 MiB
of `*.map` — and the original TypeScript with it — went into every installer.

| | before | after |
|---|---|---|
| `dist/` | 25.97 MiB | 6.14 MiB |
| installer | 22.25 MiB | **4.76 MiB** |

Deliverables moved to `release/`, outside everything the bundler reads.
`scripts/build.mjs` now **fails the build** if `dist/` holds anything but
frontend assets — that guard is the real fix, because all three of these
mistakes were silent. Verified by planting a stray `public/installer/` and
confirming the build refuses.

### Test-harness defects, also fixed

Both were capable of damaging the user's machine; neither was a product bug.

* `tests/windows-upgrade.mjs` wrote a credential to
  `PaperAI/AIProvider/deepseek` — **the user's real key slot** — and never
  deleted it. One run would have permanently replaced a working API key with a
  marker string. It now uses its own profile id, cleans up after itself, backs up
  and restores `ai-profiles.json` via `process.on("exit")`, and reports both.
* `src-tauri/tests/ai_provider.rs` left `PaperAI/AIProvider/rust-test-profile`
  behind on every run; a leftover was found in the real credential store. Now
  removed by a `Drop` guard, which also covers a panicking test.
* Both test suites assumed the install directory was `%LOCALAPPDATA%\PaperAI`.
  NSIS remembers the directory chosen at first install, and on this machine that
  is `D:/Program Files\PaperAI` — so C1.3 and U1.1 read "(none)" from a
  perfectly good install. Both now resolve it from the uninstall registry entry.

### Verification after the patch

| Suite | Result |
|---|---|
| `cargo test --lib` | 43/43 |
| `cargo test --test save_crash_recovery` | 8/8 |
| `scripts/run-ai-rust-tests.mjs` (Mock SSE, real socket) | 20/20 |
| `scripts/run-ai-unit-tests.mjs` | 48/48 |
| `tests/overlay-visibility.mjs` (headless Chromium) | **15/15** |
| `tests/windows-integration.mjs` on 0.3.1 | 17/17 |
| `tests/windows-upgrade.mjs` 0.2.0 → 0.3.1 | **13/13** |
| `scripts/verify-release-bundle.mjs` | release has no test bridge |
| **total** | **164 assertions** |

C1.3 is now also a version check: the installed `PaperAI.exe` must report the
same version as the setup file's name, which would catch an installer that
deployed a stale binary.

The user's machine was checked independently afterwards: `ai-profiles.json`
SHA-256 identical before and after, and the only `PaperAI` credential in the
Windows Credential Manager is the user's own `deepseek` — the test junk is gone.

---

## 12. The 0.4.0 features

Two requests from the user: a whole-article context option, and the free models
on OpenCode.

### 12.1 整篇文章 (whole-document context mode)

"简要概述这篇文章" is a normal question, and none of the four existing modes can
answer it: 选中文字 / 当前页 / 相邻三页 are all deliberately narrow, and
不发送文献 sends nothing.

The mode walks every page, joins the text with `[第 N 页]` markers so answers can
cite pages, and uses a much larger budget than the single-page modes
(120,000 characters ≈ 37k tokens, against 26,000) — comfortably inside every
current model's window.

**The part that needed care is truncation.** A long paper exceeds any budget, and
the obvious implementation — cut the text, send the prefix — fails in a way that
is invisible in the output: asked to summarise "the article", the model produces a
fluent, confident summary of pages 1–6 and calls it the whole paper. Nothing in
the answer reveals that two thirds of it was never sent.

So the mode is built to be honest about its own coverage:

| Mechanism | Effect |
|---|---|
| The walk stops on a **page boundary**, never mid-page | the range reported is exact, not an estimate |
| `label` becomes `仅发送第 1–6 页 / 共 22 页` | the user sees it before reading the answer |
| The payload carries an explicit note naming the range and the real total | the model is told, not left to guess |
| `SYSTEM_PROMPT` rule 7 requires the answer to state the range it used | the transcript says it too |
| `describeStats()` marks the turn with the same coverage | it survives into the history |

Four tests cover this, including one that would have passed against a broken
implementation: the first version searched the whole payload for the coverage
sentence, but the system prompt contains that phrase as well, so the assertion
could not fail. It now checks the **user turn** specifically.

Page walking is capped at 300 so a 900-page scan cannot become 900 fetches; when
the cap bites it is reported for the same reason as a budget overflow. Blank and
scanned pages are skipped without being counted as truncation — otherwise a
document with two image-only pages would always look incomplete.

### 12.2 OpenCode presets and the live model list

Three presets now ship: DeepSeek 官方, OpenCode Go, OpenCode Zen.

Every base URL was taken from the provider's own documentation and then
**confirmed against its live `/models` endpoint**. This mattered: the third-party
sources disagreed with the official docs about whether Go lives at
`inference/go/v1` or `zen/go/v1`. Both answer, but the documentation is the source
of truth, so that is what shipped. A guessed base URL fails as a 404 that looks
like a bad model name, which is the most confusing failure available.

**A factual correction the user's request contained.** They asked for
`deepseek-v4.1-flash-free` as the Go default. That model is not in the Go
catalogue — it is a **Zen** model. The two pools are separate services:

| Pool | Models | DeepSeek | Free models |
|---|---|---|---|
| Go (`inference/go/v1`) | 37 | `deepseek-v4.1-flash`, `deepseek-v4-pro` | `longcat-2.5-preview-free`, `step-5-preview-free`, `cat-jam-free` |
| Zen (`zen/v1`) | 87 | `deepseek-v4.1-flash-free` | several |

So the Go preset defaults to `deepseek-v4.1-flash` and the Zen preset defaults to
`deepseek-v4.1-flash-free` — the model they asked for, on the provider that
actually serves it. Both catalogues are one click away in the picker.

### 12.3 拉取可用模型

Rather than embedding a model list in the build, the settings dialog fetches the
provider's live catalogue (`GET {base}/models`) into the Model field's dropdown.
These catalogues change weekly — a baked-in list is wrong within a release or two
— and the call works **before a key is stored**, so the free models can be browsed
first.

Two things the UI states plainly instead of hiding:

* OpenCode serves several families on `/messages` or `/responses` rather than
  `/chat/completions`. PaperAI speaks only the last one, so those ids are
  labelled 使用其它接口协议 and warned about before anything is sent. The
  catalogue returns no protocol metadata (only `id/object/created/owned_by`), so
  this comes from a small table whose worst case is a misleading hint rather than
  a wrong request — the model still has to be accepted by the provider.
* 「可能免费」 is inferred from a `-free` suffix for the same reason: there is no
  price field to read. It sorts free models to the top and is labelled a guess.

**Key-scoping rule.** `ai_list_models` takes an optional `profile_id`, and a
stored credential is only ever read for a profile that exists. Passing no profile
means an unauthenticated request, not "use some key". So the stored key cannot be
aimed at a host the user never configured.

### 12.4 OpenCode session header

OpenCode's docs make two client requirements, and both are now met:
a client-specific User-Agent (the app already sent `PaperAI/<version>`) and
**a stable per-conversation `x-opencode-session`** — "so we can optimize routing
and prompt caching", with a warning that requests without it may start failing.

It is a per-profile flag (`sends_session_header`), not host sniffing, so what gets
sent is visible and switchable. The value is a random conversation id regenerated
by 「新对话」; it is not a credential and is never logged.

Verified end-to-end rather than by inspection: the Mock SSE server records the
headers it receives, and the runner asserts the header is present with the
expected value for an OpenCode-style profile **and absent** for an ordinary one.
22/22 including both.

### 12.5 Also corrected

The DeepSeek preset's default model was `deepseek-chat`, which DeepSeek's current
docs no longer list — they say to use `deepseek-flash`. A preset that configures a
retired model name is worse than no preset, so it was updated. It remains a
*default*: the field is editable and nothing downstream hard-codes it.

### 12.6 Verification

| Suite | 0.3.1 | 0.4.0 |
|---|---|---|
| `cargo test --lib` | 43 | **49** |
| `cargo test --test save_crash_recovery` | 8 | 8 |
| `run-ai-rust-tests.mjs` (Mock SSE, real socket) | 20 | **22** |
| `run-ai-unit-tests.mjs` | 48 | **53** |
| `tests/overlay-visibility.mjs` (headless Chromium) | 15 | 15 |
| `windows-integration.mjs` | 17 | 17 |
| `windows-upgrade.mjs` | 13 | 13 |
| **total** | **164** | **177** |

New tests worth naming: partial-coverage honesty (4), `models_url` joining (2),
preset validity — every preset must survive the same validation a typed profile
does, and no two may share a credential slot (3), and the session header present
/ absent pair (2 e2e, asserted from the recorded request).

`pdfjs-dist` still pinned at 6.4.299.
