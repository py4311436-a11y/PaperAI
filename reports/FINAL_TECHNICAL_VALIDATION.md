# PaperAI Phase 2 — Final Technical Validation

Date: 2026-10-15 · Project: `D:\AIreader\PaperAI-PoC` · Version: 0.2.0

---

## 1. Executive Summary

**LOCK — Tauri 2 + PDF.js 6.4.299.** Both Phase-2 blockers are closed:

| | |
|---|---|
| K-01 `.pdf` file association | **FIXED** — registered by the installer itself, cleaned up by the uninstaller, user's default reader untouched |
| K-02 cross-reader display | **RESOLVED** — WPS (independent engine) renders the annotations; highlight confirmed by the user on a real desktop, ink strokes visible in the capture |

| Stage | Outcome |
|---|---|
| A — Windows native build environment | **PASS** |
| B — real Tauri WebView2 (read / annotate / save) | **PASS 19/19** |
| C — NSIS install, CLI paths, single instance | **PASS 17/17** |
| D — save safety | **PASS 12/12** |
| D — cross-reader display | **PASS (WPS)** / **PARTIAL (Edge)** / **BLOCKED (Acrobat, not installed)** |

48 automated assertions, all green. Stage B found and fixed **six real product
bugs** that headless-browser testing had missed — including two that produced a
completely blank window with no visible error. That is the strongest argument in
this report for having tested the packaged app rather than the dev server.

**Open, non-blocking:** the automated CDP route stopped working on this machine
part-way through Stage D (remote debugging is now ignored, cause unknown — see
K-13). The suites cannot be re-run automatically here until that is diagnosed;
the app itself is unaffected.

---

## 2. Environment (measured, not assumed)

| Item | Value |
|---|---|
| OS | Windows 11 专业版, 10.0.26300, AMD64 |
| Rust | rustc 1.99.0 / cargo 1.99.0 / rustup 1.29.1, `D:\.rustup`, `D:\.cargo` |
| MSVC | v143 `cl.exe` 19.44.35229, `D:\PaperAI-Build\VS2022BT` |
| Windows SDK | 10.0.26100.0 — `C:\Program Files (x86)\Windows Kits\10` (cannot be relocated) |
| Node / npm | v22.22.2 / 10.9.7 |
| Tauri CLI / tauri / tauri-build | 2.12.2 / 2.12.3 / 2.7.2 |
| Plugins | single-instance 2.5.3, dialog 2.8.2 |
| **PDF.js** | **6.4.299, exact pin** (no `^`, no `~`) |
| WebView2 Runtime | 155.0.4283.45 |
| Edge | installed (`…\Edge\Application\msedge.exe`) |
| WPS Office | `D:\Program Files\WPS Office\12.1.0.28505\office6\wps.exe` |
| Acrobat Reader | **not installed** |
| `.pdf` default handler (before & after) | `MSEdgePDF`, unchanged |

Inventory script: `scripts/check-windows-env.ps1` → `evidence/stage-a/env.txt`.

---

## 3. Results

| ID | Item | Result | Evidence |
|---|---|---|---|
| A1 | Rust / MSVC / SDK usable | **PASS** | `STAGE_A_ENVIRONMENT.md` §A.2 |
| A2 | `cargo check` | **PASS** (0 errors) | `evidence/stage-a/` |
| A3 | Release build + NSIS installer | **PASS** | `dist/installer/` |
| B0 | Real WebView2 session | **PASS** | `evidence/stage-b/01-webview2-startup.png` |
| B1 | PDF core | **PASS** | `evidence/stage-b/RESULTS.md` B1.1–B1.6 |
| B2 | Annotation | **PASS** | B2.1–B2.4 |
| B3 | Save | **PASS** | B3.1–B3.3 |
| B4 | Render | **PASS** | B4.1 ratio 2.500 |
| C1 | Installer | **PASS** | C1.1–C1.5, C5.x |
| C2 | `.pdf` association | **PASS** | registered by the installer, C2.1 |
| C3 | CLI paths | **PASS** | C3.1, C4.2 |
| C4 | Single instance | **PASS** | C4.1–C4.3 |
| C5 | Uninstall cleanup | **PASS** | C5.2–C5.5 |
| D1 | Edge GUI re-open | **PARTIAL** | `edge-printwindow.png`; annotation layer not painted by default |
| D2 | Acrobat GUI re-open | **BLOCKED** | not installed |
| D3 | Save failures never damage the original | **PASS** | `save-safety-RESULTS.md` |
| D4 | Uncommitted ink + close protection | **PASS** | B/D4.1, D3.10 |
| D5 | Full automated regression | **PASS** | 48 assertions |

---

## 4. What changed

| Module | Why |
|---|---|
| `src/pdf/pdfjs-adapter.ts` **(new)** | every version-fragile PDF.js call lives here |
| `src/bridge.ts` **(new)** | the only place that talks to Rust; least-privilege file access |
| `src/main.ts` | rewritten as a thin shell: toolbar, dirty policy, guarded open/save |
| `src-tauri/src/save_service.rs` **(new)** | the only writer: temp → verify → backup → safe replace → sha256, with fault injection |
| `src-tauri/src/paths.rs` **(new)** | argv validation (`%PDF-` magic, size cap, canonicalisation) |
| `src-tauri/src/lib.rs` **(new)** | single-instance queue, pending-file hand-off, audit log |
| `src-tauri/installer-hooks.nsh` **(new)** | NSIS hooks: `SetShellVarContext` + candidate-only `.pdf` registration |
| `src-tauri/` (whole) | first Tauri shell for this project |
| `tests/*.mjs` **(new)** | four verification suites + the Phase-1 browser suite |
| `scripts/*` **(new)** | env inventory, asset sync, icon generation, fixtures, download helper, diagnostics |
| `index.html` | **Erase** and **Save As** added; `#viewer` regained `class="pdfViewer"` |

---

## 5. Installer

| | |
|---|---|
| Path | `D:\AIreader\PaperAI-PoC\dist\installer\PaperAI_0.2.0_x64-setup.exe` |
| Size | 11,681,450 bytes (11.14 MiB) |
| SHA-256 | `3f5a840984c851603b9d87232f0f9b77312a62b88a6174133961ccdd26e69635` |
| Installed to | `%LOCALAPPDATA%\PaperAI\` (currentUser, no elevation) |
| File association | registered by the installer, removed by the uninstaller |
| Uninstall verified | exe removed, registry cleaned, default PDF reader untouched |
| Signature | **unsigned**. Windows shows "unknown publisher"; nothing was bypassed |

---

## 6. PDF artefacts

| File | Bytes | SHA-256 |
|---|---|---|
| `output/annotated-desktop.pdf` (Highlight 1 · Ink 3) | 497,510 | `2a99ff81e57ef4298d6402f4bebc95d63815709d10f95510563a4398422dbbde` |
| `test-fixtures/dual/IEEE 双栏 论文 副本.pdf` (source) | 490,608 | `e90453ad008664496bf957a600a37aded935bff5a31d0c7310570e5af2b22559` |

Structure verified without PDF.js: `/Type /Annot`, `/Subtype /Highlight`,
`/Subtype /Ink`, `QuadPoints: 1`, `InkList: 3`, `AP_streams: 4`.

---

## 7. Architecture decision

**LOCK — Tauri 2 + PDF.js 6.4.299.**

Rationale: the whole product hinges on three things and all three are now
demonstrated on real Windows with real evidence — PDF.js writes genuine PDF
annotations and writes them **reliably** through a hardened save path; Tauri
delivers a working installer, file association, file hand-off and
single-instance behaviour; and the frontend needed six fixes that only a real
WebView2 run surfaced, which means browser-only testing is not sufficient for
this product.

Open, non-blocking: K-13 (CDP disabled on this machine) prevents automated
re-verification here. K-03 (test API in the release binary) must be stripped
before V0.1.

---

## 8. Regression commands

```bash
source scripts/env.sh                      # or rely on the persisted user env vars

npm ci
npx vite build                             # frontend only (see K-08)
npx tauri build --config '{"build":{"beforeBuildCommand":""}}'

node tests/desktop-verify.mjs --exe "D:\PaperAI-Build\target\release\PaperAI.exe" --port 9400
node tests/save-safety.mjs    --exe "D:\PaperAI-Build\target\release\PaperAI.exe" --port 9700
node tests/windows-integration.mjs --installer "D:\AIreader\PaperAI-PoC\dist\installer\PaperAI_0.2.0_x64-setup.exe"
node tests/wps-capture.mjs output/annotated-desktop.pdf
node tests/edge-gui-check.mjs --pdf output/annotated-desktop.pdf
python tools/inspect_pdf.py output/annotated-desktop.pdf
```

> If `npm run tauri build` hangs in a nested-npm environment, build the frontend
> first and use the `--config` override above. See `STAGE_A_ENVIRONMENT.md` §A.3.
> If CDP endpoints stop appearing, check for leaked `msedgewebview2.exe`
> processes (K-14).

`tests/final-verify.mjs` (the Phase-1 browser suite) still runs against
`npm run dev` and is kept as the quick inner loop.

Manual items that automation cannot cover here are listed in
`reports/STAGE_D_SAVE_COMPATIBILITY.md` §3.

---

## 9. Next development scope

Do **not** extend the product in this round. The agreed next increment is a
single provider abstraction plus "send the current selection to the AI":

1. a `Provider` interface with one DeepSeek/OpenAI-compatible implementation,
2. an "Ask about selection" action that uses the already-proven
   `window.getSelection()` path,
3. the dirty/save guards extended to any new state.

Everything else stays as it is.
