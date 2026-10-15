# PaperAI Phase 2 — Final Technical Validation

Date: 2026-10-15 · Project: `D:\AIreader\PaperAI-PoC` · Version: 0.2.0

---

## 1. Executive Summary

**CONDITIONAL LOCK — architecture is sound and proven end to end on this
machine, but one shipping blocker remains (Windows `.pdf` file association does
not register from Tauri's declarative config) and the cross-reader GUI proof is
BLOCKED by this machine's lack of an interactive desktop.**

The four Stage-2 gates came out as:

| Stage | Outcome |
|---|---|
| A — Windows native build environment | **PASS** |
| B — real Tauri WebView2 (read / annotate / save) | **PASS 19/19** |
| C — NSIS install, CLI paths, single instance | **PASS 17/17** (association via companion script, not the bundler) |
| D — save safety | **PASS 12/12** |
| D — cross-reader GUI (Edge / Acrobat) | **BLOCKED** |

Stage B found and fixed **six real product bugs** that headless-browser testing
had missed — including two that produced a completely blank window with no
visible error. That is the strongest argument in this report for having tested
the packaged app rather than the dev server.

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
| Acrobat Reader | **not installed** |
| `.pdf` default handler (before & after) | `MSEdgePDF`, unchanged |

Inventory script: `scripts/check-windows-env.ps1` → `evidence/stage-a/env.txt`.

---

## 3. Results

| ID | Item | Result | Evidence |
|---|---|---|---|
| A1 | Rust / MSVC / SDK usable | **PASS** | `reports/STAGE_A_ENVIRONMENT.md` |
| A2 | `tauri dev`/`build` run, WebView2 window | **PASS** | `evidence/stage-b/01-webview2-startup.png`, UA `Chrome/155 … Edg/155` |
| A3 | Release build + NSIS installer | **PASS** | `dist/installer/PaperAI_0.2.0_x64-setup.exe` |
| B1 | WebView2 single/dual column selection | **PASS** | `evidence/stage-b/RESULTS.md` B1.1–B1.6 |
| B2 | Highlight / Ink / Delete | **PASS** | B2.1–B2.4, `evidence/stage-b/05-highlight.png`, `06-ink-zoom-*.png` |
| B3 | `saveDocument()` + re-open | **PASS** | B3.1–B3.3, `output/annotated-desktop.pdf` |
| B4 | zoom / scroll / DPI / copy | **PASS** | B4.1 ratio 2.500 at DPR 1.5 |
| C1 | NSIS install / start menu / uninstall | **PASS** | `evidence/stage-c/RESULTS.md` C1.1–C1.5 |
| C2 | `.pdf` Open with | **PARTIAL** | C2.1 — bundler wrote nothing; `scripts/register-file-association.ps1` verified |
| C3 | Unicode / space paths via CLI | **PASS** | C3.1, `…IEEE 双栏 论文 副本.pdf` |
| C4 | Single instance + hand-off | **PASS** | C4.1–C4.3 |
| C5 | dirty document protected on second open | **PASS** (code + unit path) | `src/main.ts` `guardedOpen`; no destructive GUI click-through in this session |
| D1 | Edge GUI re-open | **BLOCKED** | no compositor — see `STAGE_D_SAVE_COMPATIBILITY.md` §3 |
| D2 | Acrobat GUI re-open | **BLOCKED** | not installed |
| D3 | Save failures never damage the original | **PASS** | `evidence/stage-d/save-safety-RESULTS.md` |
| D4 | Uncommitted ink / close protection | **PASS** | B/D4.1 + D3.10 |
| D5 | Full automated regression | **PASS** | 48 automated assertions across 4 suites, all green |

---

## 4. What changed

| Module | Why |
|---|---|
| `src/pdf/pdfjs-adapter.ts` **(new)** | every version-fragile PDF.js call lives here; `globalThis.pdfjsLib` ordering, UIManager acquisition, `updateMode(mode, null, true)`, ink commit, numeric fit-scale |
| `src/bridge.ts` **(new)** | the only place that talks to Rust; least-privilege file access |
| `src/main.ts` | rewritten as a thin shell: toolbar, dirty policy, guarded open/save |
| `src-tauri/src/save_service.rs` **(new)** | the only writer: temp → verify → backup → safe replace → sha256, with fault injection |
| `src-tauri/src/paths.rs` **(new)** | argv validation (`%PDF-` magic, size cap, canonicalisation) |
| `src-tauri/src/lib.rs` **(new)** | single-instance queue, pending-file hand-off, audit log |
| `src-tauri/` (whole) | first Tauri shell for this project |
| `tests/lib-cdp.mjs`, `desktop-verify.mjs`, `windows-integration.mjs`, `save-safety.mjs`, `edge-gui-check.mjs` **(new)** | the four verification suites |
| `scripts/*` **(new)** | env inventory, asset sync, icon generation, fixtures, download helper, association registration |
| `index.html` | toolbar extended with **Erase** and **Save As**; `#viewer` regained `class="pdfViewer"` |

---

## 5. Installer

| | |
|---|---|
| Path | `D:\AIreader\PaperAI-PoC\dist\installer\PaperAI_0.2.0_x64-setup.exe` |
| Size | 3,852,257 bytes (3.67 MiB) |
| SHA-256 | `c29f9dae30c724dcb6ac4e229f63d68d1a5163b96a4865404cd352391336be43` |
| Installed to | `%LOCALAPPDATA%\PaperAI\` (currentUser, no elevation) |
| Uninstall verified | yes — exe removed, uninstall entry removed, default PDF reader untouched |
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

**`LOCK ARCHITECTURE — Tauri 2 + PDF.js 6.4.299`, with two conditions.**

Conditions to clear before V0.1:

1. Resolve the `.pdf` association (K-01) — either prove Tauri's `perMachine`
   registration works, or ship the association step as a first-class part of the
   installer.
2. Re-run the cross-reader GUI check on a machine with an interactive desktop
   (K-02). Everything else about the file format is already proven.

Rationale: the whole product hinges on three things and all three are now
demonstrated on real Windows with real evidence — PDF.js writes genuine PDF
annotations and writes them **reliably** through a hardened save path; Tauri
delivers a working installer, file hand-off and single-instance behaviour; and
the frontend needed six fixes that only a real WebView2 run surfaced, which
means browser-only testing is not sufficient for this product.

---

## 8. Regression commands

```bash
source scripts/env.sh                      # or rely on the persisted user env vars

npm ci
npx vite build                             # frontend only (see KNOWN_ISSUES K-08)
npx tauri build --config '{"build":{"beforeBuildCommand":""}}'

node tests/desktop-verify.mjs --exe "D:\PaperAI-Build\target\release\PaperAI.exe" --port 9400
node tests/save-safety.mjs   --exe "D:\PaperAI-Build\target\release\PaperAI.exe" --port 9700
node tests/windows-integration.mjs --installer "D:\AIreader\PaperAI-PoC\dist\installer\PaperAI_0.2.0_x64-setup.exe"
node tests/edge-gui-check.mjs --pdf "D:\AIreader\PaperAI-PoC\output\annotated-desktop.pdf"
python tools/inspect_pdf.py output/annotated-desktop.pdf
```

`tests/final-verify.mjs` (the Phase-1 browser suite) still runs against
`npm run dev` and is kept as the quick inner loop.

Manual items that automation cannot cover here are listed in
`reports/STAGE_D_SAVE_COMPATIBILITY.md` §3.

---

## 9. Next development scope

Do **not** extend the product in this round. The agreed next increment is a
single provider abstraction plus "send the current selection to the AI":

1. a `Provider` interface with one DeepSeek/OpenAI-compatible implementation,
2. a "Ask about selection" action that uses the already-proven
   `window.getSelection()` path,
3. the dirty/save guards extended to any new state.

Everything else stays as it is until K-01 and K-02 are closed.
