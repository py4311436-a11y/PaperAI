# PaperAI

A minimal Windows PDF reader for academic papers — **Read · Annotate · Ask**.

Built with **Tauri 2 + PDF.js 6.4.299**. Real PDF annotations (highlight, ink)
are written back into the file; select a passage and ask an AI to explain or
translate it, with the answer streamed into a side panel.

> Status: **0.5.0**. See `reports/PHASE3_FINAL_VALIDATION.md` for what is proven
> and what is not — in particular, the AI loop has not yet been exercised by a
> human on a real desktop, and no live provider has been contacted.
> Earlier documents (`FINAL_TECHNICAL_VALIDATION.md`, `TEST_RESULTS.md`) are kept
> for history; where they disagree, the newer file wins.

---

## Building from source (for collaborators)

```powershell
git clone <your-remote-url> PaperAI
cd PaperAI
npm ci                      # lockfile is committed; use ci, not install
npm run fixtures            # generates the test PDFs (see below)
npm run build:release       # bundles the frontend into dist/
npx tauri build             # produces release/bundle/nsis/PaperAI_<ver>_x64-setup.exe
```

### Test PDFs are generated, not committed

`test-pdfs/` and `test-fixtures/` are **not in the repository**. `npm run fixtures`
creates both; `npm run verify:fixtures` proves the result is usable (page count,
a non-empty text layer, the awkward filename, no third-party authorship) in about
a second.

They were real IEEE papers until 2026-10-16. That was fine privately and not fine
publicly: IEEE licences its papers to the individual subscriber, so committing one
to a public repository redistributes material the licence does not grant. The
fixtures in `scripts/make-test-pdfs.mjs` are generated instead and their content
was written for this purpose. The suites only ever asserted on structure — page
count, text layer, two-column layout, a Unicode+space path — never on content.

The desktop and PoC suites (`desktop-verify`, `save-safety`, `run-poc`) need
these files, so run `npm run fixtures` once after cloning. `npm run test:ai` and
`npm run test:ui` do not.

Prerequisites, all of them:

| Tool | Why | Notes |
|---|---|---|
| Node 20+ (22 used) | Vite build, test runners | `npm ci` installs the rest |
| Rust, MSVC toolchain | the Tauri binary | `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio Build Tools + Windows 11 SDK | linker for Rust | only needed to *build*; running the installer needs nothing |
| WebView2 Runtime | runs the app | preinstalled on Windows 11 |

### Do not copy `scripts/env.sh`

It is **this machine's** local setup and contains absolute paths that will not
exist on yours:

```sh
export CARGO_HOME='D:/.cargo'                    # ← this machine
export CARGO_TARGET_DIR='D:/PaperAI-Build/target' # ← this machine
_MSVC="D:/PaperAI-Build/VS2022BT/.../14.44.35207" # ← this machine, exact build
_SDKVER="10.0.26100.0"                            # ← this machine, exact SDK
```

It exists only because the toolchain was installed on D: here. A plain
`cargo build` / `npx tauri build` works **without** it once rustup and the Build
Tools are installed — that is the normal path. If you keep the file for your own
machine, do not commit your edits to it.

### Tests you can run without a PDF or a desktop

```bash
npm run test:ai          # frontend units + Rust provider suite against a local mock
npm run test:ui          # real Chromium over CDP: toolbar, panel pickers, overlays
npm run typecheck        # tsc --noEmit
cd src-tauri && cargo test --lib
```

`npm run verify:no-profiles` is a guard, not a test: it fails if browser profile
data or credential files ever reappear in the tree. Run it before committing.

**`node scripts/verify-publishable.mjs` is the one to run before making the
repository public.** Flipping visibility is one-way, and the dangerous material
is rarely in the working tree — a deleted file is still retrievable from history,
and a screenshot taken with the app open on a real paper reproduces that paper
verbatim. The audit therefore checks the working tree, *every commit*, machine
identity, and key-shaped strings; key patterns fail loudly rather than being
masked, because a key in a tracked file was live and has to be rotated.

Two supporting scripts, both re-runnable:

* `node scripts/scrub-evidence.mjs` replaces the Windows account name, user
  paths and email addresses in `evidence/` and `reports/` — identity is replaced
  rather than the logs deleted, because those logs are the proof trail behind the
  claims in `reports/KNOWN_ISSUES_AI.md`. `--check` reports without writing.
* `npm run fixtures` / `npm run verify:fixtures` regenerate the test PDFs and
  prove they are usable.

Screenshots and annotated PDFs under `evidence/` are **not** committed. They were
captured with the app open on a real paper, so they contain that paper's title,
authors and body text; what documents each claim is the `RESULTS.md` beside them,
which is kept.

Two suites are deliberately **not** in `npm test`: `tests/windows-integration.mjs`
installs and uninstalls the app, and `tests/save-safety.mjs` /
`tests/desktop-verify.mjs` need a real desktop session.

### Conventions worth knowing before you change something

* **`dist/` is not a delivery folder.** `tauri.conf.json` sets `frontendDist` to
  `../dist`, so everything in it is embedded into the binary. Deliverables live
  in `release/` (git-ignored), and `scripts/build.mjs` *fails the build* if
  `dist/` contains anything but `assets/`, `index.html`, `cmaps/` or
  `standard_fonts/`. This is not pedantry: an earlier release shipped 22 MiB
  because the previous installer sat inside the next one.
* **A new test must be able to fail.** Every regression suite here is
  negative-controlled — the fix is reverted, the test is run, and it must go
  red. A test that passes against the broken code proves nothing. The reasoning
  is recorded next to each one.
* **Rendering bugs need a browser.** Several defects here (a `<datalist>` that
  could not be picked from, a highlighted toolbar button, math that rendered as
  raw LaTeX) were invisible to logic tests. `npm run test:ui` is real Chromium
  over CDP for that reason.
* **`pdfjs-dist` is pinned** at 6.4.299. The annotation editor is a PDF.js
  *internal* API; read `reports/PDFJS_COMPATIBILITY.md` before bumping it, and
  re-run `tests/final-verify.mjs`.
* Nothing in this repository may contain an API key. Keys live in the Windows
  Credential Manager under `PaperAI/AIProvider/<id>` and are never read back by
  the UI.

---

## Requirements

* Windows 10 / 11 (tested on Windows 11 build 26300)
* WebView2 Runtime (preinstalled on Windows 11)
* To build from source: Rust (MSVC toolchain), Node 20+, Visual Studio Build
  Tools with the Windows 11 SDK

## Install

```powershell
# 1. run the installer
.\release\PaperAI_0.4.0_x64-setup.exe
# silently:  Start-Process .\release\PaperAI_0.4.0_x64-setup.exe -ArgumentList /S -Wait

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
| 类型 | DeepSeek 官方 / OpenCode Go / OpenCode Zen 预设，或任意 OpenAI 兼容端点 |
| Base URL | e.g. `https://api.deepseek.com` — a trailing `/v1` is fine, and the path is joined correctly either way |
| Model | fully editable; nothing is hard-coded |
| API Key | stored in **Windows Credential Manager**, never in a config file |
| 测试连接 | a separate button that sends one 1-token request — it may cost a small amount, and the dialog says so |

The key is written to Credential Manager under `PaperAI/AIProvider/<id>`. There
is no way to read it back out through the app, and it never enters the page.

### Built-in presets

| 预设 | Base URL | 默认模型 | 说明 |
|---|---|---|---|
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-flash` | 按量计费 |
| OpenCode Go | `https://opencode.ai/inference/go/v1` | `deepseek-v4.1-flash` | 订阅制（$10/月）；另有 3 个 `-free` 模型 |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `deepseek-v4.1-flash-free` | 按量计费，含多个免费模型 |

Every base URL above was read off the provider's own documentation and then
confirmed against its live `/models` endpoint — a guessed base URL fails as a
404 that looks like a bad model name, so nothing goes in this table on inference
alone. `presets()` in `src-tauri/src/ai/settings.rs` is the single source.

**Two OpenCode pools, two catalogues.** They are separate services with separate
subscriptions and different model sets:

* **Go** carries 37 models. Its DeepSeek entries are `deepseek-v4.1-flash` and
  `deepseek-v4-pro`; the free ones are `longcat-2.5-preview-free`,
  `step-5-preview-free` and `cat-jam-free`.
* **Zen** carries 87 models, including `deepseek-v4.1-flash-free`.

So `deepseek-v4.1-flash-free` exists on **Zen, not Go**. A Go key will not unlock
it; pick a Go model instead, or use a Zen key.

### Picking a model

Click **拉取可用模型** to fetch the provider's live catalogue into the Model
field's dropdown. This is a network call rather than a list shipped in the app
because these catalogues change weekly — anything baked in goes stale within a
release or two. The call works **before** a key is stored (OpenCode's catalogue
endpoints answer unauthenticated), so you can look at the free models first.

Two caveats the UI shows explicitly rather than hiding:

* OpenCode serves several families on `/messages` (Anthropic) or `/responses`
  (OpenAI Responses) instead of `/chat/completions`. PaperAI only speaks the
  last one, so those ids are labelled 使用其它接口协议 and warned about before
  you send anything. The catalogue carries no protocol metadata, so this comes
  from a small table in `protocol_hint()` — it can drift, and the worst case is
  a misleading hint, never a wrong request.
* "可能免费" is inferred from a `-free` suffix, because the catalogue has no
  price field. It is used only to sort free models to the top and is labelled as
  a guess.

**OpenCode requires a session header.** Both OpenCode presets set
`sends_session_header`, and Rust then sends a stable per-conversation
`x-opencode-session` alongside a `PaperAI/<version>` User-Agent — both are
documented client requirements ("Send a stable session ID in `x-opencode-session`
for each conversation so we can optimize routing and prompt caching"), and the
docs warn that requests without it may start failing. The value is a random
conversation id, regenerated by 「新对话」; it is not a credential. It is a
per-profile flag, not host sniffing, so what gets sent is visible and switchable.

**Local models work too**: point Base URL at `http://127.0.0.1:11434/v1` (Ollama)
or any local gateway. Plain HTTP is allowed **only** for loopback, and the
dialog shows 本地非加密连接 when you use it.

---

## Context modes

The 上下文 dropdown decides how much of the paper is sent. **Nothing is sent
until you ask a question**, and `不发送文献` sends only your question.

| 模式 | 发送内容 |
|---|---|
| 不发送文献 | 只有你的问题与对话历史 |
| 选中文字 | 你在 PDF 中选中的文字及页码 |
| 当前页 | 当前页的可提取文字 |
| 相邻三页 | 当前页、上一页、下一页 |
| **整篇文章** | 全篇可提取文字，带 `[第 N 页]` 标记 |

整篇文章 exists because 「简要概述这篇文章」 is a normal thing to ask and no
per-page mode can answer it honestly.

**It is honest about what it sent.** A long paper can exceed the request budget.
When that happens PaperAI does *not* silently summarise a prefix and call it the
whole paper — that failure is invisible in the answer:

* the walk stops on a **page boundary**, so the range is exact;
* the label says `仅发送第 1–6 页 / 共 22 页`;
* the payload carries an explicit note telling the model it is looking at part
  of the paper, to name the pages it saw and not to call it 全文;
* the system prompt has a matching rule, so the answer opens by stating the
  range it is based on.

Budget: 120,000 characters (~37k tokens) for this mode, against 26,000 for the
single-page modes — comfortably inside every current model's window. The walk is
also capped at 300 pages so a 900-page scan cannot turn into 900 fetches; when
that cap bites it is reported for the same reason.

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
node tests/windows-integration.mjs --installer release/PaperAI_0.4.0_x64-setup.exe
node tests/windows-upgrade.mjs          # oldest -> newest in release/

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
release/            the shipped NSIS setup.exe (NOT dist/ — see below)
```

**`dist/` is not a delivery folder.** `tauri.conf.json` sets `frontendDist` to
`../dist`, so every file in there is embedded into the binary and into the
setup.exe. Keeping an installer in `dist/installer/` once produced a 0.3.1 build
that contained the 0.2.0 and 0.3.0 installers inside it (22.25 MiB instead of
5.46 MiB, and growing each release). `scripts/build.mjs` now fails the build if
anything other than frontend assets shows up in `dist/` — the mistakes here were
all silent, so the guard matters more than the fix. Use `npm run size:report` to
see the breakdown and `npm run release:collect` to copy a built setup into
`release/`.
