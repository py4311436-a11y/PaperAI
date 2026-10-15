# PaperAI Phase 2 — regression matrix

Statuses below are the actual outcomes of the runs recorded in the evidence
paths. Suites: `desktop-verify` (19 assertions), `save-safety` (12),
`windows-integration` (17), `edge-gui-check` (4 + manual).

---

## Automated suites

| Suite | Command | Result |
|---|---|---|
| `tests/desktop-verify.mjs` | `node tests/desktop-verify.mjs --exe "<PaperAI.exe>" --port 9400` | **19/19 PASS** |
| `tests/save-safety.mjs` | `node tests/save-safety.mjs --exe "<PaperAI.exe>" --port 9700` | **12/12 PASS** |
| `tests/windows-integration.mjs` | `node tests/windows-integration.mjs --installer "<setup.exe>"` | **17/17 PASS** |
| `tests/edge-gui-check.mjs` | `node tests/edge-gui-check.mjs --pdf "output/annotated-desktop.pdf"` | D1.0/D1.1/D1.2 PASS, **D1.3 screenshot BLOCKED** |
| `tools/inspect_pdf.py` | `python tools/inspect_pdf.py <file.pdf>` | PASS (byte-level) |
| `tests/final-verify.mjs` | Phase-1 browser suite, `npm run dev` | kept as the quick inner loop |

Total automated: **48 assertions green**, 1 blocked.

---

## Matrix

| ID | Category | Expected | Status | Evidence |
|---|---|---|---|---|
| A1 | Toolchain: `cl.exe` + Rust link | compiles, links, runs | **PASS** | `STAGE_A_ENVIRONMENT.md` §A.2 |
| A2 | Toolchain: `cargo check` | 0 errors | **PASS** | `evidence/stage-a/` |
| A3 | Build: release + NSIS | setup.exe produced | **PASS** | `dist/installer/` |
| B0 | Real WebView2 session | frontend boots, UIManager acquired | **PASS** | `evidence/stage-b/01-webview2-startup.png` |
| B1 | PDF core | open single + IEEE dual column, drag-select each | **PASS** | `evidence/stage-b/RESULTS.md` B1.1–B1.6 |
| B2 | Annotation | Highlight, Ink ×3 zooms, mode cycling, delete | **PASS** | B2.1–B2.4, `05-highlight.png`, `06-ink-zoom-*.png` |
| B3 | Save | standard annotations in the output | **PASS** | B3.1–B3.3 |
| B4 | Render | TextLayer alignment at 150 % DPI | **PASS** | B4.1 ratio 2.500 |
| C1 | Installer | silent install, start menu, uninstall entry, uninstall | **PASS** | `evidence/stage-c/RESULTS.md` C1.x, C5.x |
| C2 | File association | PaperAI is a `.pdf` candidate; default reader unchanged | **PARTIAL** | bundler writes nothing (K-01); `scripts/register-file-association.ps1` verified |
| C3 | CLI paths | CJK + spaces + unicode | **PASS** | C3.1, C4.2 |
| C4 | Single instance | one process, new file forwarded, no loss | **PASS** | C4.1–C4.3 |
| C5 | Uninstall cleanup | exe + registry gone, default reader intact | **PASS** | C5.2–C5.5 |
| D1 | Edge GUI re-open | highlight + ink visible | **BLOCKED** | no interactive compositor (K-02) |
| D2 | Acrobat GUI re-open | highlight + ink visible | **BLOCKED** | not installed |
| D3 | Save safety | original never damaged on failure | **PASS** | `evidence/stage-d/save-safety-RESULTS.md` |
| D4 | Uncommitted ink + close protection | ink survives; dirty survives a failed save | **PASS** | B/D4.1, D3.10 |
| D5 | Full regression | all suites green | **PASS** | — |

---

## Save-safety detail

| Case | Result | Note |
|---|---|---|
| successful save | PASS | backup `.paperai.bak` created; byte-stable round trip |
| 3× repeated save | PASS | no duplication, still parses |
| injected `target_readonly` | PASS | original SHA unchanged, no temp left |
| injected `temp_write` | PASS | original SHA unchanged, temp cleaned |
| injected `replace` | PASS | original SHA unchanged, temp cleaned |
| real read-only attribute | PASS | `save_target_readonly`, original unchanged |
| Save As | PASS | source SHA unchanged |
| real Save button on a read-only target | PASS | error shown, **dirty stays true**, file untouched |
| non-PDF payload | PASS | rejected with `save_temp_invalid`, target untouched |

Not exercised: a target held with an exclusive handle by another process
(`FileShare::None`). The code path reports `save_target_locked`, but it was not
forced in this round — it would need a helper process that holds the file open.

---

## Sample coverage — stated honestly

`test-fixtures/MANIFEST.json` records the SHA-256 of every pristine copy, and the
pairs share hashes: each category is a **copy of one source document**.

* single column: 1 distinct source
* IEEE two-column: 1 distinct source
* formulas / captions: 1 distinct source
* pre-annotated: 1 (PaperAI's own output, not a third-party file)

Conclusions about dual-column behaviour are therefore scoped to "the samples
tested", not "all IEEE papers".
