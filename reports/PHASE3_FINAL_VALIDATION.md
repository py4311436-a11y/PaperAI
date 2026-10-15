# PaperAI 0.3.0 — final validation

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
| S7 installer + upgrade + uninstall | **PASS** — 17/17 and 11/11 |

---

## 2. Deliverable

| | |
|---|---|
| Path | `D:\AIreader\PaperAI-PoC\dist\installer\PaperAI_0.3.0_x64-setup.exe` |
| Size | 5,726,436 bytes (5.46 MiB) |
| SHA-256 | `cfabb1750fa2bcdfa94e26a3d0a9b25a4489545827b51a5cfb0443c04fc98186` |
| Built | 2026-10-15 20:17 |
| Signature | **unsigned** — Windows will show "unknown publisher". Nothing bypasses SmartScreen. |
| Installs to | `%LOCALAPPDATA%\PaperAI\` (current user, no elevation) |
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
     --installer dist/installer/PaperAI_0.3.0_x64-setup.exe   # 17
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
