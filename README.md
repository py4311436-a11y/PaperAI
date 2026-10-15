# PaperAI

A minimal Windows PDF reader for academic papers — **Read · Annotate · Ask**.

Built with **Tauri 2 + PDF.js 6.4.299**. Real PDF annotations (highlight, ink)
are written back into the file; the original is protected by a temp-file +
verify + backup + safe-replace save pipeline in Rust.

> Status: Phase 2, version 0.2.0. See
> `reports/FINAL_TECHNICAL_VALIDATION.md` for what is proven and what is not.
> Phase-1 documents (`TECHNICAL_VALIDATION.md`, `TEST_RESULTS.md`) are kept for
> history; where they disagree, the `reports/` folder wins.

---

## Requirements

* Windows 10 / 11 (tested on Windows 11 build 26300)
* WebView2 Runtime (preinstalled on Windows 11)
* To build from source: Rust (MSVC toolchain), Node 20+, Visual Studio Build
  Tools with the Windows 11 SDK

## Install

```powershell
# 1. run the installer
.\dist\installer\PaperAI_0.2.0_x64-setup.exe
# silently:  Start-Process .\dist\installer\PaperAI_0.2.0_x64-setup.exe -ArgumentList /S -Wait

# 2. register as a .pdf "Open with" candidate
#    (required — see reports/KNOWN_ISSUES_UPDATED.md K-01)
powershell -ExecutionPolicy Bypass -File .\scripts\register-file-association.ps1
```

The installer is unsigned, so Windows shows "unknown publisher". Nothing is
bypassed — use *More info → Run anyway* if you accept that.

To remove: Settings → Apps → PaperAI → Uninstall, then optionally
`scripts/register-file-association.ps1 -Unregister`.

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
| Pages | the `n / m` indicator in the toolbar |

Uncommitted ink is flushed before every save. Closing the window or opening
another file while there are unsaved notes prompts
**保存 / 不保存 / 取消**.

## Development

```bash
source scripts/env.sh          # Git Bash. On Windows the same three variables
                               # (CARGO_HOME / RUSTUP_HOME / CARGO_TARGET_DIR)
                               # are already set at user scope.

npm ci
npm run dev                    # Vite only, browser at http://localhost:5180
npm run tauri:dev              # real Tauri WebView2 window
npx vite build                 # frontend
npx tauri build                # release + NSIS installer
```

> If `npm run tauri:build` hangs in a nested-npm environment, build the frontend
> first and run
> `npx tauri build --config '{"build":{"beforeBuildCommand":""}}'`.
> See `reports/STAGE_A_ENVIRONMENT.md` §A.3.

## Tests

```bash
node tests/desktop-verify.mjs --exe "<…\PaperAI.exe>"            # real WebView2
node tests/save-safety.mjs    --exe "<…\PaperAI.exe>"            # save failures
node tests/windows-integration.mjs --installer "<…-setup.exe>"   # install / CLI
node tests/edge-gui-check.mjs --pdf "output\annotated-desktop.pdf"
python tools/inspect_pdf.py output/annotated-desktop.pdf         # byte-level check
```

`tests/final-verify.mjs` is the Phase-1 browser suite; keep it as the quick
inner loop. Manual checks that need an interactive desktop are listed in
`reports/STAGE_D_SAVE_COMPATIBILITY.md` §3.

## Known limitations

Full list with severities in `reports/KNOWN_ISSUES_UPDATED.md`:

* The `.pdf` association must be registered with
  `scripts/register-file-association.ps1`; Tauri's declarative config does not
  write it on this machine (K-01).
* Cross-reader display could not be verified here — the session has no
  interactive compositor (K-02).
* The `__paperai` automation API is compiled into the release build (K-03).
* Saving is two renames, not an atomic overwrite; a crash mid-save leaves a
  recoverable `.paperai.old` (K-07).
* Erase requires an editing mode first — PDF.js otherwise makes new annotations
  unselectable (K-11).
* PDF.js is pinned exactly to `6.4.299`; read
  `reports/PDFJS_COMPATIBILITY.md` before changing that version.

## Layout

```
src/                 frontend shell + pdf/pdfjs-adapter.ts (all PDF.js coupling)
src-tauri/           Rust: paths, save service, single instance, audit log
tests/               four verification suites + the Phase-1 browser suite
test-fixtures/       writable COPIES used by destructive tests (MANIFEST.json)
scripts/             env inventory, fixtures, icons, association registration
reports/             stage reports, compatibility notes, final validation
evidence/            raw logs and screenshots per stage
dist/installer/      the generated NSIS setup.exe
```
