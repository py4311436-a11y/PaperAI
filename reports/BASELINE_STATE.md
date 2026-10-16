# BASELINE_STATE — PaperAI Phase 2 takeover

Snapshot taken before any Phase-2 code change. Updated continuously.
Report date: 2026-10-14.

---

## 1. Project taken over

| Item | Value |
|---|---|
| Working directory | `%PROJECT_PARENT%\PaperAI-PoC` |
| `package.json` | present (v0.1.0 → bumped to 0.2.0 in Phase 2) |
| `src/` | present (`main.ts`, `style.css`, `ink-fixes.css`) |
| `src-tauri/` | **absent in Phase 1** — created in Phase 2 |
| `tests/final-verify.mjs` | present |
| Phase-1 reports | `TECHNICAL_VALIDATION.md`, `TEST_RESULTS.md`, `KNOWN_ISSUES.md`, `README.md` |
| Test material | `test-pdfs/PDF-A.pdf`, `PDF-B.pdf`, `PDF-C.pdf`, `output/example_annotated.pdf` |

### Git

* No repository existed → `git init` (2026-10-14).
* Baseline commit: **`5333c26`** — "Phase1 baseline: PDF.js 6.4.299 PoC (pre Phase 2)", 229 files.
* Working branch: **`phase2`**.
  *Note:* the task suggested `feat/windows-native-phase2`, but this sandbox
  could not create the nested ref `refs/heads/feat/...`; the branch was created
  as `phase2` pointing at the identical commit.
* Working tree at snapshot: clean.

### Version pin (task §1.4)

`package.json` declares `"pdfjs-dist": "6.4.299"` — **exact, no `^`/`~`**.
Lockfile resolves to the same. No drift detected; nothing was upgraded.

---

## 2. Environment (detected, not assumed)

Tool: `scripts/check-windows-env.ps1` (non-destructive).
Raw output: `evidence/stage-a/env.txt`, `evidence/stage-a/env.json`.

| Item | Value |
|---|---|
| OS | Microsoft Windows 11 专业版, 10.0.26300, AMD64 |
| C: free | ~23 GB (77 % used) |
| D: free | ~122 GB (68 % used) |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Rust (before Phase 2) | **not installed** |
| MSVC `cl.exe` (before) | **not installed** |
| Windows SDK (before) | **not installed** |
| WebView2 Runtime | 155.0.4283.45 (also 154.0.4258.62 present) |
| Microsoft Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| Adobe Acrobat Reader | **not installed** → Stage D2 is BLOCKED |
| Current `.pdf` default handler | `MSEdgePDF` (must stay unchanged) |

### Installed during Phase 2 (all Rust bits on D:)

| Component | Location | Notes |
|---|---|---|
| rustup / cargo | `D:\.cargo`, `D:\.rustup` | rustup 1.29.1, rustc **1.99.0** |
| cargo target dir | `%BUILD_ROOT%\target` | via `CARGO_TARGET_DIR` |
| MSVC v143 | `%BUILD_ROOT%\VS2022BT` | `cl.exe` 19.44.35229 |
| Windows 11 SDK | `C:\Program Files (x86)\Windows Kits\10\10.0.26100.0` | **cannot be relocated** (Microsoft limitation) |

Persistent user environment variables were checked first (none of
`CARGO_HOME` / `RUSTUP_HOME` / `CARGO_TARGET_DIR` were set) and only then added:
`CARGO_HOME=D:\.cargo`, `RUSTUP_HOME=D:\.rustup`,
`CARGO_TARGET_DIR=%BUILD_ROOT%\target`, and `D:\.cargo\bin` appended to the
**user** `Path` (system `Path` untouched).
Evidence: `evidence/stage-a/env-vars-check.txt`, `evidence/stage-a/env-vars-set.txt`.

---

## 3. Obstacles hit while setting up (recorded, not hidden)

1. `curl -o <file>` is blocked by the sandbox ("client returned ERROR on write").
   Workaround: `scripts/download.mjs` (Node `fetch` + `fs.writeFileSync`).
   `curl` still works for HEAD/probe requests.
2. `rustup-init.exe` fails at proxy creation:
   `could not create link from 'D:\.cargo\bin\rustup.exe' to '…rust-analyzer.exe'`
   (os error 183 — a 0-byte `rust-analyzer.exe` already exists).
   Workaround: run the already-extracted `rustup.exe toolchain install
   stable-x86_64-pc-windows-msvc --profile minimal`, then create the
   `cargo.exe` / `rustc.exe` … proxies manually with `fs.linkSync`.
3. The VS Build Tools bootstrapper exits with `-1073740791` (0xC0000409) at the
   very end, **after** writing all components. `cl.exe` and the SDK are fully
   functional; the exit code is reported as-is rather than papered over.
4. Git cannot create the nested ref `refs/heads/feat/...` here → branch `phase2`.

---

## 4. Test material policy

* Every destructive test operates on `test-fixtures/` copies.
* Pristine SHA-256 of each copy: `test-fixtures/MANIFEST.json`
  (regenerate with `node scripts/make-fixtures.mjs`).
* The user's own papers (`D:\IEEE期刊\…`) are **read-only inputs**, never written.

---

## 5. Phase-1 claims being re-verified (task §9)

| Phase-1 claim | Re-verification | Result |
|---|---|---|
| "Cross-reader compatible" (structure check only) | separate Edge GUI + structure tests | see `STAGE_D_SAVE_COMPATIBILITY.md` |
| "AnnotationEditorUIManager not exported" vs "exported" | `probe/export-check.mjs` | exported from `pdfjs-dist`, **not** from `web/pdf_viewer.mjs` — see `PDFJS_COMPATIBILITY.md` §2 |
| "Only remaining item is pure configuration" | WebView2 / installer / file assoc / single instance all now tested as first-class stages | see Stages B/C |
| Dual-column reliability from 1 sample | ≥2 distinct sources per category | see `STAGE_B_WEBVIEW2.md` |
