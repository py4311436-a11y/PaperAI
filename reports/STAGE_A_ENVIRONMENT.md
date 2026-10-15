# Stage A — Windows native build environment

Goal: make `tauri dev` and `tauri build` actually run on this machine, replacing
the Phase-1 situation where everything was exercised in headless Edge.

---

## A.1 What was missing

At takeover (see `BASELINE_STATE.md`) this machine had **no Rust, no MSVC
toolchain and no Windows SDK**. That is why Phase 1 could only test in a
browser.

| Component | Before | After |
|---|---|---|
| rustc / cargo | not installed | **rustc 1.99.0**, cargo 1.99.0, rustup 1.29.1 |
| rustup home | — | `D:\.rustup` |
| cargo home | — | `D:\.cargo` |
| cargo target dir | — | `D:\PaperAI-Build\target` |
| MSVC `cl.exe` | not installed | **19.44.35229** at `D:\PaperAI-Build\VS2022BT\VC\Tools\MSVC\14.44.35207` |
| Windows SDK | not installed | **10.0.26100.0** |
| `rc.exe` | not installed | `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe` |
| Node / npm | v22.22.2 / 10.9.7 | unchanged |
| Tauri CLI | 2.12.2 | 2.12.2 |
| WebView2 Runtime | 155.0.4283.45 | unchanged |

### Where things landed

Everything Rust- and MSVC-related that *can* be redirected was put on **D:**.
Two documented exceptions:

* the **Windows SDK** always installs under `C:\Program Files (x86)\Windows Kits\10`
  (Visual Studio installer behaviour; not relocatable), and
* the VS installer's shared bootstrapper under `C:\Program Files (x86)\Microsoft Visual Studio\Installer`.

C: had ~23 GB free at the start, which was enough.

### Environment variables

Checked first: none of `CARGO_HOME`, `RUSTUP_HOME`, `CARGO_TARGET_DIR` existed
as user variables (`evidence/stage-a/env-vars-check.txt`). They were then added
at **user** scope, and `D:\.cargo\bin` appended to the **user** `Path` (system
`Path` untouched) — `evidence/stage-a/env-vars-set.txt`.
`scripts/env.sh` exports the same values for Git Bash sessions.

---

## A.2 Verifications actually run

| # | Command | Result |
|---|---|---|
| 1 | `cl.exe` compile + run of a `windows.h` smoke program | **PASS** — printed `paperai-ok 8` |
| 2 | `cargo build --release` of a Rust hello-world | **PASS** — linked and printed `paperai-rust-link-ok` |
| 3 | `cargo check` on `src-tauri` | **PASS** (after fixing 3 compile errors, see below) |
| 4 | `npm run sync:assets` | **PASS** — 169 cMaps + 16 standard fonts |
| 5 | `npx tsc --noEmit` | **PASS** |
| 6 | `npx vite build` | **PASS** — see `dist/` |
| 7 | `tauri build` | see A.3 |

---

## A.3 Problems hit (recorded, not hidden)

1. **`curl -o <file>` is blocked** in this sandbox ("client returned ERROR on
   write"). Worked around with `scripts/download.mjs` (Node `fetch` +
   `fs.writeFileSync`). `curl` is still used for HEAD/probe requests.
2. **`rustup-init.exe` fails while creating the `rust-analyzer` proxy**:
   `could not create link from 'D:\.cargo\bin\rustup.exe' to '…rust-analyzer.exe'`
   (os error 183 — the 0-byte target already exists). The toolchain is never
   downloaded in that run.
   *Fix*: invoke the extracted `rustup.exe toolchain install
   stable-x86_64-pc-windows-msvc --profile minimal` directly, then create the
   `cargo.exe` / `rustc.exe` / … proxies with `fs.linkSync`. `rust-analyzer.exe`
   is deliberately not recreated (it is a broken 0-byte stub here).
3. **VS Build Tools bootstrapper exits with `-1073740791` (0xC0000409)** at the
   very end — *after* all components were written. `cl.exe` and the SDK are
   fully functional; the exit code is reported as-is.
4. **Git cannot create the nested ref `refs/heads/feat/...`** here. The branch
   is `phase2` at the identical commit `5333c26`.
5. **`npm run tauri -- build` hangs** in this environment when the nested
   `npm run build` (→ `vite build`) runs as a grandchild; the same `vite build`
   standalone finishes in ~2 s. Workaround used for the actual packaging:
   `npx tauri build --config '{"build":{"beforeBuildCommand":""}}'` after
   building the frontend separately. `tauri.conf.json` keeps the correct
   `beforeBuildCommand` for normal use on a normal machine.
6. A first, naive `sync-pdfjs-assets.mjs` (`rmSync` + `cpSync`) was **killed
   mid-run** and left `public/cmaps` with only 32 of 169 files. The script now
   tops up missing files and never bulk-deletes first.

---

## A.4 Rust compile errors fixed

| Error | Fix |
|---|---|
| `no method named 'emit' found for WebviewWindow` | `use tauri::{Emitter, Manager, …}` |
| closure borrows `startup` which is owned by `run()` | clone into `startup_for_setup` and use `move` |
| `PDFDocumentProxy` has no `destroy()` | use `cleanup()` (see `PDFJS_COMPATIBILITY.md` §8) |

---

## A.5 Reproduce

```bash
source scripts/env.sh          # or rely on the persisted user env vars
npm ci                         # or npm install
npm run build                  # sync:assets + tsc + vite
cd src-tauri && cargo check
npx tauri dev                  # real WebView2 desktop window
npx tauri build                # release + NSIS installer
```

Non-destructive environment inventory:

```powershell
.\scripts\check-windows-env.ps1
```
