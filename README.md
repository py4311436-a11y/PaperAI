# PaperAI

A minimal Windows PDF reader for academic papers — **Read · Annotate · Ask**.

Built with **Tauri 2 + PDF.js 6.4.299**. Real PDF annotations (highlight, ink)
are written back into the file; select a passage and ask an AI to explain or
translate it, with the answer streamed into a side panel.

> Status: **0.3.0**. See `reports/PHASE3_FINAL_VALIDATION.md` for what is proven
> and what is not — in particular, the AI loop has not yet been exercised by a
> human on a real desktop, and no live provider has been contacted.
> Earlier documents (`FINAL_TECHNICAL_VALIDATION.md`, `TEST_RESULTS.md`) are kept
> for history; where they disagree, the newer file wins.

---

## Requirements

* Windows 10 / 11 (tested on Windows 11 build 26300)
* WebView2 Runtime (preinstalled on Windows 11)
* To build from source: Rust (MSVC toolchain), Node 20+, Visual Studio Build
  Tools with the Windows 11 SDK

## Install

```powershell
# 1. run the installer
.\dist\installer\PaperAI_0.3.0_x64-setup.exe
# silently:  Start-Process .\dist\installer\PaperAI_0.3.0_x64-setup.exe -ArgumentList /S -Wait

# 2. nothing else needed — the installer registers PaperAI as a .pdf
#    "Open with" candidate, and the uninstaller removes it again.
```

The installer is unsigned, so Windows shows "unknown publisher". Nothing is
bypassed — use *More info → Run anyway* if you accept that.

To remove: Settings → Apps → PaperAI → Uninstall. Uninstalling does **not**
touch other applications' stored credentials.

---

## Using it

| Action | How |
|---|---|
| Open a PDF | **Open**, or double-click / right-click → *Open with* → PaperAI |
| Select text | **Select**, then drag with the mouse |
| Highlight | select the text first, then **Highlight** |
| Draw | **Draw**, then drag |
| Erase a note | **Erase** → click the annotation → **Erase** again |
| Save | **Save** or `Ctrl+S` (same file; a `.paperai.bak` is kept) |
| Save a copy | **Save As** |
| Zoom / fit | `Zoom -` / `Zoom +` / **Fit Width** / **Fit Page** |
| AI panel | the **AI** button in the toolbar |
| Ask about a selection | select text, then **解释** / **翻译** in the small bar |
| Ask something else | type in the panel; pick the context scope above the input |

Uncommitted ink is flushed before every save. Closing the window or opening
another file while there are unsaved notes prompts
**保存 / 不保存 / 取消**.

---

## Setting up the AI

Toolbar **AI** → 设置.

| Field | Notes |
|---|---|
| 类型 | DeepSeek preset, or any OpenAI-compatible endpoint |
| Base URL | e.g. `https://api.deepseek.com` — a trailing `/v1` is fine, and the path is joined correctly either way |
| Model | fully editable; nothing is hard-coded |
| API Key | stored in **Windows Credential Manager**, never in a config file |
| 测试连接 | a separate button that sends one 1-token request — it may cost a small amount, and the dialog says so |

The key is written to Credential Manager under `PaperAI/AIProvider/<id>`. There
is no way to read it back out through the app, and it never enters the page.

**Local models work too**: point Base URL at `http://127.0.0.1:11434/v1` (Ollama)
or any local gateway. Plain HTTP is allowed **only** for loopback, and the
dialog shows 本地非加密连接 when you use it.

---

## Privacy

PaperAI sends nothing until you ask a question.

| You do | Network |
|---|---|
| open a PDF, select, highlight, draw, save | nothing |
| click 高亮 / 复制 | nothing |
| click 解释 / 翻译 | that selection, its page numbers and the document's display name |
| type a question | the context scope shown in the selector |

Never sent: the file path, your user name, other open file names, the PDF
itself, or page images. Passing 不发送文献 sends only your question. Chat
history is in memory and disappears when the app closes.

Full detail, including what a third-party gateway would see, is in
`reports/AI_CONTEXT_AND_PRIVACY.md`.

---

## Development

```bash
source scripts/env.sh          # Git Bash. On Windows the same three variables
                               # (CARGO_HOME / RUSTUP_HOME / CARGO_TARGET_DIR)
                               # are already set at user scope.

npm ci
npm run dev                    # Vite only, browser at http://localhost:5180
npm run tauri:dev              # real Tauri WebView2 window

npm run build:release          # frontend without the test bridge
npm run build:automation       # frontend WITH it, for the automated suites
npm run verify:bundle          # asserts the release bundle has no test bridge
npx tauri build                # release + NSIS installer
```

> If `npm run tauri:build` hangs in a nested-npm environment, build the frontend
> first and run
> `npx tauri build --config '{"build":{"beforeBuildCommand":""}}'`.
> See `reports/STAGE_A_ENVIRONMENT.md` §A.3.

## Tests

```bash
source scripts/env.sh

# AI: no API key required anywhere below
cd src-tauri && cargo test --lib && cargo test --test save_crash_recovery && cd ..
node scripts/run-ai-rust-tests.mjs      # provider vs a real local Mock SSE server
node scripts/run-ai-unit-tests.mjs      # context, state machine, markdown safety

# Windows: install / CLI / single instance / uninstall / file association
node tests/windows-integration.mjs --installer dist/installer/PaperAI_0.3.0_x64-setup.exe
node tests/windows-upgrade.mjs          # 0.2.0 -> 0.3.0

# Need a real GUI session (blocked by K-13 on machines without CDP)
node tests/desktop-verify.mjs --exe "<…\PaperAI.exe>"
node tests/save-safety.mjs    --exe "<…\PaperAI.exe>"
```

To try a provider without a key, start the mock and point the app at it:

```bash
node tests/ai-mock/server.mjs --scenario slow --port 8788
# settings: Base URL http://127.0.0.1:8788, Model mock-model,
#           API Key anything (the mock ignores it, Rust requires one to exist)
```

## Known limitations

Short version — full list in `reports/KNOWN_ISSUES_AI.md` and
`reports/KNOWN_ISSUES_UPDATED.md`:

* **The AI click-through has not been verified by a person.** CDP against the
  real WebView2 is unavailable on the build machine (K-13), so the visual half
  of the AI loop is BLOCKED. `PHASE3_FINAL_VALIDATION.md` §8 has the ten-minute
  checklist.
* **No live provider has been contacted.** Everything was verified against a
  local Mock SSE server. Marked `BLOCKED: NO_USER_KEY`, not PASS.
* The `.pdf` association is registered by the installer itself (candidate only,
  never the default handler).
* Saving is two renames, not an atomic overwrite; a crash mid-save leaves a
  **recoverable** `.paperai.old`, and the app offers to restore it on next open.
* Chat history is not persisted — closing the app discards it.
* Erase requires an editing mode first: PDF.js otherwise makes new annotations
  unselectable.
* PDF.js is pinned exactly to `6.4.299`; read
  `reports/PDFJS_COMPATIBILITY.md` before changing that version.
* The test bridge is compiled out of release builds; `npm run verify:bundle`
  checks this by scanning the emitted JavaScript.

## Layout

```
src/                 frontend shell
src/ai/              context building, chat, markdown, selection, settings
src/pdf/             pdfjs-adapter.ts — all PDF.js coupling, one file
src-tauri/src/       Rust: paths, save service, recovery, single instance, ai/
src-tauri/tests/     Rust integration suites (provider, crash recovery)
tests/               desktop suites + ai-mock server + ai-unit suites
test-fixtures/       writable COPIES used by destructive tests (MANIFEST.json)
scripts/             env inventory, fixtures, icons, build flavours, runners
reports/             stage reports, security/privacy notes, final validation
evidence/            raw logs, request logs and screenshots per stage
dist/installer/      the generated NSIS setup.exe
```
