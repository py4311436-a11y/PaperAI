# Execution log — PaperAI Phase 2

Chronological record of what was run, what it returned, and why the next step
was chosen. Timestamps are the session clock; all evidence lives under
`evidence/`.

---

## 0. Takeover

| When | What | Result |
|---|---|---|
| 23:26 | Read `PaperAI_Phase2_ABCD_Agent_Task.md` | 4 stages, strict truthfulness rules |
| 23:30 | Inventory `PaperAI-PoC` | no Git, no `src-tauri/`; `pdfjs-dist` pinned `6.4.299` |
| 23:33 | Environment probe | **no Rust, no MSVC, no Windows SDK**; WebView2 155.0.4283.45 present |
| 23:35 | `git init` + baseline commit | `5333c26` on branch `phase2` (see the caveat below) |

**Caveat, stated honestly:** the first commit attempt silently failed and the
successful commit landed *after* `index.html` / `main.ts` / `package.json` had
already been edited, so `5333c26` is **not** a pristine Phase-1 tree for those
files. Everything else from Phase 1 is intact there. The Phase-1 originals that
were overwritten are described in `reports/STAGE_B_WEBVIEW2.md` §"real product
bugs" and `reports/PDFJS_COMPATIBILITY.md`.

## Stage A — toolchain

| When | What | Result |
|---|---|---|
| 23:35 | `curl -o` blocked by sandbox | wrote `scripts/download.mjs` (Node fetch) |
| 23:36 | `rustup-init.exe` fails at the `rust-analyzer` proxy (os error 183) | ran `rustup toolchain install` directly, created `cargo.exe`/`rustc.exe` with `fs.linkSync` |
| 23:37 | rustc **1.99.0** | verified |
| 23:40 | VS Build Tools install (UAC, user authorised) | bootstrapper exits `0xC0000409` **after** writing everything; `cl.exe` 19.44 compiles + runs |
| 23:45 | `cl.exe` smoke test | printed `paperai-ok 8` |
| 23:50 | Rust hello-world `cargo build --release` | linked, printed `paperai-rust-link-ok` |
| 01:00 | persisted `CARGO_HOME` / `RUSTUP_HOME` / `CARGO_TARGET_DIR` + user `Path` (checked nothing existed first) | `evidence/stage-a/env-vars-*.txt` |
| 01:15 | `npm ci`, `pdfjs-dist@6.4.299` confirmed | — |
| 01:20 | `cargo check` on the new `src-tauri` | 3 errors fixed (`Emitter` trait, closure lifetime, `cleanup()` vs `destroy()`) |

## Stage B — real WebView2

| When | What | Result |
|---|---|---|
| 01:30 | `probe/export-check.mjs` | resolves the Phase-1 export contradiction — see `PDFJS_COMPATIBILITY.md` §2 |
| 02:10 | first `tauri build` | hangs: `sync:assets` was killed mid-copy |
| 02:20 | rewrote `sync-pdfjs-assets.mjs` to top up instead of delete-then-copy | 169/169 cMaps |
| 02:27 | `tauri build` again | hangs again, this time in the nested `npm run build` |
| 02:30 | **split the build**: `npx vite build` (2 s) then `tauri build --config '{"build":{"beforeBuildCommand":""}}'` | installer produced |
| 02:45 | `desktop-verify` against the release exe | CDP connects, but `Runtime.evaluate` hangs forever |
| 03:10 | control experiment: Edge + CDP on a trivial page | **works** → the blocker is ours, not the environment |
| 03:25 | `Page.startScreencast` / `Network.enable` on the Tauri page | every asset 200; `plugin:event\|listen` IPC issued → JS *is* running, then the renderer stops answering |
| 03:40 | `probe/cdp-throttle.mjs` with `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion` | **renderer responsive** — WebView2 occlusion suspension |
| 04:10 | pages render 0×0, no canvas | two real bugs found: missing `class="pdfViewer"`, and `currentScaleValue` presets early-return while `_currentPageNumber` is 0 |
| 04:30 | `currentPageNumber = 1` throws `_setCurrentPageNumber` | switched to a purely numeric fit scale |
| 05:00 | text selection returned empty | CDP `mouseMoved` needs `buttons: 1` |
| 05:30 | ink only worked at one zoom | strokes were being drawn outside the viewport; coordinates are now clamped |
| 06:00 | Erase reported success but deleted nothing | new annotations are unselectable while the editor layer is disabled — Erase now enters Draw mode first |
| 06:40 | **Stage B: 19/19 PASS** | `evidence/stage-b/RESULTS.md` |

Six real product bugs came out of this stage; they are listed in
`reports/STAGE_B_WEBVIEW2.md`.

## Stage C — installer / Windows integration

| When | What | Result |
|---|---|---|
| 07:00 | `tauri build` with `mainBinaryName: "PaperAI"` | exe is now `PaperAI.exe` |
| 07:20 | `windows-integration` first run | install/start-menu/uninstall PASS; exe lookup failed on the old lowercase name |
| 07:40 | CLI open silently failed | added `%LOCALAPPDATA%\PaperAI\paperai.log` audit log → argv was received, the frontend threw on `currentPageNumber` (fixed in Stage B) |
| 08:00 | Chinese + spaces paths, single instance | PASS, verified through the **native window title** |
| 08:20 | `.pdf` association | **never registered** by the bundler; `role` is macOS-only; `nsis.hooks` rejected by the schema; `installerHooks` accepted but inert |
| 08:40 | `scripts/register-file-association.ps1` (+ `-Unregister`) | registered and verified; default reader untouched |
| 09:00 | **Stage C: 17/17 PASS** | `evidence/stage-c/RESULTS.md` |

## Stage D — save safety + cross reader

| When | What | Result |
|---|---|---|
| 09:20 | `save-safety` first run | 8/12 — three failures were wrong test assertions (round-trip byte stability, a missing read-only flag, non-PDF *data* vs non-PDF *target*), one was a **real bug**: `dirty` never became true after ink |
| 09:40 | adapter owns the dirty flag (`markDirty`, `onDirtyChange`) | fixed |
| 10:00 | **save safety: 12/12 PASS** | `evidence/stage-d/save-safety-RESULTS.md` |
| 10:20 | byte-level inspection of the exported PDF | `Highlight 1 · Ink 3 · QuadPoints 1 · InkList 3 · AP_streams 4` |
| 10:40 | Edge GUI launch + CDP | window opens, CDP connects, **screenshot is blank** |
| 10:50 | GDI window capture of Edge | returns the desktop wallpaper → the session has no compositor |
| 11:00 | Acrobat Reader | not installed |

Both cross-reader items are recorded as **BLOCKED**, with manual steps.

## Final regression

`desktop-verify` 19/19 · `save-safety` 12/12 · `windows-integration` 17/17 ·
byte inspection PASS. 48 automated assertions, all green.

---

## Decisions and their evidence

| Decision | Evidence |
|---|---|
| Numeric fit scale instead of `currentScaleValue` presets | `pdf_viewer.mjs` `#setScale` early-returns while `_currentPageNumber` is 0 |
| Adapter owns the dirty flag | `save-safety` D3.10 caught `dirty=false` after real ink |
| Association via companion script | registry dumps showed nothing written by the bundler |
| Native window title as the observation point | `Get-Process … MainWindowTitle` is readable from outside the process |
| Audit log file in Rust | release builds are GUI-subsystem, so `println!` is invisible |
