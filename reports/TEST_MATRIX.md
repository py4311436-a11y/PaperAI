# PaperAI Phase 2 — regression matrix

Status column is filled with the real outcome of the run recorded in the
evidence path. Nothing here is pre-filled as PASS.

---

## Automated suites

| Suite | Command | Covers |
|---|---|---|
| `tests/final-verify.mjs` | `node tests/final-verify.mjs` (needs `npm run dev`) | browser-mode PDF.js regression (Phase-1 15 checks) |
| `tests/desktop-verify.mjs` | `node tests/desktop-verify.mjs --exe "<PaperAI.exe>"` | **real WebView2**: open, select, highlight, ink, delete, save, zoom |
| `tests/windows-integration.mjs` | `node tests/windows-integration.mjs --installer "<setup.exe>"` | install, start menu, file assoc, ASCII/CJK/space argv, single instance, uninstall |
| `tests/edge-gui-check.mjs` | `node tests/edge-gui-check.mjs --pdf "<annotated.pdf>"` | cross-reader: real Edge GUI window + screenshot |
| `tools/inspect_pdf.py` | `python tools/inspect_pdf.py <file.pdf>` | byte-level `/Type /Annot`, `/Subtype`, QuadPoints, InkList, AP |

---

## Matrix

| ID | Category | Preconditions | Steps | Expected | Status | Evidence |
|---|---|---|---|---|---|---|
| A1 | Toolchain | — | `cl.exe` smoke program; `cargo build --release` hello-world | compiles, links, runs | **PASS** | `reports/STAGE_A_ENVIRONMENT.md` §A.2 |
| A2 | Toolchain | deps vendored | `cargo check` in `src-tauri` | 0 errors | **PASS** | `evidence/stage-a/` |
| A3 | Build | frontend built | `tauri build` | release exe + NSIS setup.exe | see §Results | `dist/installer/` |
| B1 | PDF core | app installed | open single-column + IEEE two-column, drag-select each column | text selected, no column bleeding | `desktop-verify` B1.x | `evidence/stage-b/RESULTS.md` |
| B2 | Annotation | doc open | select→Highlight; Draw×3 at zoom 1.0/1.75/0.75; Delete | annotation count changes accordingly | `desktop-verify` B2.x | `evidence/stage-b/*.png` |
| B3 | Save | annotations exist | `serialize()` → `verify()` | `/Highlight` + `/Ink` present with QuadPoints/InkList | `desktop-verify` B3.x | `output/annotated-desktop.pdf` |
| B4 | Render | doc open | setScale 1 → 2.5, measure span width ratio | ratio ≈ 2.5 (±5 %) | `desktop-verify` B4.1 | `evidence/stage-b/RESULTS.md` |
| C1 | Installer | setup.exe | `/S` silent install; check dir, exe, start menu, uninstall entry | all present | `windows-integration` C1.x | `evidence/stage-c/RESULTS.md` |
| C2 | File assoc | installed | read `HKCU\SOFTWARE\Classes`; compare `.pdf` UserChoice before/after | PaperAI registered as candidate; default unchanged | `windows-integration` C2.x | `evidence/stage-c/RESULTS.md` |
| C3 | CLI paths | installed | launch exe with CJK path and with spaces path | window title shows the file | `windows-integration` C3.1 | `evidence/stage-c/RESULTS.md` |
| C4 | Single instance | running | launch again with a different PDF; then 3 in a row | ≤1 process; title follows the newest path | `windows-integration` C4.x | `evidence/stage-c/RESULTS.md` |
| C5 | Uninstall | installed | run uninstaller `/S`; re-check | exe + registry gone; default reader intact | `windows-integration` C5.x | `evidence/stage-c/RESULTS.md` |
| D1 | Cross-reader | annotated.pdf | open in real Edge GUI, screenshot | highlight + ink visible | `edge-gui-check` D1.x | `evidence/stage-d/edge-annotated.png` |
| D2 | Cross-reader | Acrobat installed | open in Acrobat GUI | highlight + ink visible | **BLOCKED** — Acrobat not installed | `reports/STAGE_D_SAVE_COMPATIBILITY.md` |
| D3 | Save safety | fixture copies | fault injection: `target_readonly`, `temp_write`, `replace` | original SHA-256 unchanged; dirty not cleared | see §Results | `evidence/stage-d/` |
| D4 | Save safety | pending ink | draw, then serialize without committing | ink still in output | `desktop-verify` D4.1 | `evidence/stage-b/RESULTS.md` |
| D5 | Regression | all suites green | run the four suites | all green or explained | see §Results | — |

---

## Save-safety cases (D3 detail)

| Case | How it is forced | Expected |
|---|---|---|
| successful save | normal save | file grows/changes, backup `.paperai.bak` created, dirty cleared |
| target read-only | `attrib +R` on the fixture, or `inject_failure:"target_readonly"` with `PAPERAI_ALLOW_FAULT_INJECTION=1` | `save_target_readonly`, original SHA unchanged |
| target locked | open the fixture with an exclusive handle, then save | `save_target_locked`, original intact |
| temp write failure | `inject_failure:"temp_write"` (env gate on) | `save_injected_fault`, original intact, temp cleaned or reported |
| replace failure | `inject_failure:"replace"` | `save_injected_fault`, original intact |
| 3× repeated save | save the same doc three times | annotation count stable, page count unchanged, file still parses |
| Save As | save to a new path | source SHA unchanged |

---

## Sample coverage honesty

Fixtures: 2 single-column copies, 2 IEEE two-column copies, 1 formula/caption
copy, 1 pre-annotated copy — but the two-column and single-column pairs are
copies of the *same* underlying document, so the distinct-source count is:

* single column: **1 distinct source**
* IEEE two-column: **1 distinct source**
* formulas/captions: **1 distinct source**

Conclusions about column behaviour are therefore scoped to "the samples tested",
not "all IEEE papers".
