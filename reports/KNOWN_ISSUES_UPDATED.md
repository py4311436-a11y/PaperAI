# Known issues — updated after Phase 2

Phase-1 issues are kept where they still apply; everything here was observed in
this round unless marked otherwise.

Severity: **P0** blocks a shipping build · **P1** serious · **P2** cosmetic.

---

## Resolved this round

### ✅ K-01 — `.pdf` file association did not register — **FIXED**

`bundle.fileAssociations` looked inert: after a silent `currentUser` install
nothing appeared under `HKCU`/`HKLM\Software\Classes`. Reading the *generated*
`installer.nsi` showed it is not a config bug but a template bug:

1. The template **does** call `!insertmacro APP_ASSOCIATE "pdf" "PDF Document" …`
   inside `Section Install`.
2. But every macro in `FileAssociation.nsh` writes through the `SHELL_CONTEXT`
   variable, and the only `SetShellVarContext` in the whole generated script
   sits inside the **uninstaller**, inside a `${If} $DeleteAppDataCheckboxState = 1`
   block. During install the shell context is never initialised, so each
   `WriteRegStr SHELL_CONTEXT` fails silently.
3. When the shell context *is* initialised (verified with an instrumented
   build), `APP_ASSOCIATE` sets `.pdf`'s **default** value to our ProgID — i.e.
   it claims the default handler, which this project must not do.

**Fix:** `bundle.fileAssociations` was removed from `tauri.conf.json` and
`src-tauri/installer-hooks.nsh` (wired via `bundle > windows > nsis >
installerHooks`) performs a candidate-only registration in
`NSIS_HOOK_PREINSTALL`:

* `HKCU\Software\Classes\Applications\PaperAI.exe` (+ `DefaultIcon`, `shell\open\command`)
* `.pdf\OpenWithProgids` and `.pdf\OpenWithList` entries
* `SHChangeNotify(SHCNE_ASSOCCHANGED)` so Explorer refreshes
* **never** writes `.pdf`'s default value and never creates its own ProgID

`NSIS_HOOK_PREUNINSTALL` removes exactly those three things.

Verified by `tests/windows-integration.mjs` C2.1 / C5.5 — the installer itself
registers, the uninstaller itself cleans up, and the user's default reader
(`MSEdgePDF`) is untouched before and after.

### ✅ K-02 — cross-reader display could not be verified — **PARTIALLY RESOLVED**

* `PrintWindow(PW_RENDERFULLCONTENT)` replaced GDI `CopyFromScreen` and CDP
  screenshots, both of which only ever returned the desktop wallpaper. This was
  never "no compositor" — DWM runs and `OpenInputDesktop` succeeds.
* **WPS Office** (independent, non-PDFium engine) renders the annotations:
  the user confirmed the yellow highlight on the abstract on a normal desktop,
  and `evidence/stage-d/wps-try6.png` shows the Ink strokes.
* **Edge** renders the document correctly; its PDF viewer does not paint the
  annotation layer by default, so the automated highlight check is inconclusive.
* **Acrobat Reader** remains untested — not installed.

### ✅ Dirty flag was not set for ink strokes — **FIXED**

`commitPendingInk()` now compares the annotation count before/after and calls
`markDirty(true)` when a stroke was committed; the adapter owns the flag and the
shell only reflects it via `onDirtyChange`. Covered by `save-safety` D3.10.

---

## P0

*(none open)*

## P1

### K-03 — `window.__paperai` test API ships inside the release binary

The automation surface used by `tests/desktop-verify.mjs` and
`tests/save-safety.mjs` is compiled into the product.

* Mitigation: strip it behind a Cargo feature / `import.meta.env.DEV` before V0.1.
* Reproduce: open DevTools in the installed app and evaluate
  `Object.keys(window).filter(k => k.startsWith("__paperai"))`.

### K-04 — Highlight geometry: PDF.js reports an empty `quadPoints`

`page.getAnnotations()` returns `quadPoints: []` for a Highlight this app wrote,
while the file itself contains `/QuadPoints` (byte-level check:
`evidence/stage-d/byte-inspection.json`). The annotation is correct; the
in-process read-back is not. Any feature that reads geometry back through PDF.js
must not trust that field.

### K-05 — Windows focus stealing cannot be guaranteed

`unminimize()` + `show()` + `set_focus()` are best-effort. Windows may refuse
when another process owns the foreground. Untested here. If focus fails, the
file is still opened — the window title is the observable.

### K-06 — PDF.js version coupling is deep

`reports/PDFJS_COMPATIBILITY.md` lists ~12 verified behaviours that would break
on upgrade, including: `globalThis.pdfjsLib` ordering, the `pdfViewer` CSS class,
the `#setScale` numeric-vs-preset split, `cleanup()` instead of `destroy()`,
`updateMode(mode, null, true)`, and the `supportMultipleDrawings` Ink commit
rule. `pdfjs-dist` is pinned to the exact version `6.4.299`.

### K-07 — Non-atomic replace

Saving is two renames because Windows `rename` cannot overwrite. A crash between
them leaves `<name>.pdf.paperai.old` holding the previous content — recoverable,
not atomic. See `reports/SAVE_SAFETY_DESIGN.md`.

### K-13 — Automated CDP verification stopped working on this machine

`--remote-debugging-port` is now ignored by both WebView2 and Edge here, with no
Edge/Chromium policy to explain it. `scripts/probe-webview2-health.mjs` shows the
app fully functional while no debug port listens. Until the cause is found, the
Stage B / save-safety suites cannot be re-run automatically on this machine.

---

## P2

### K-08 — Exe name vs package name

`cargo build` produces `paperai.exe` **without the embedded frontend**; only
`tauri build` produces the real `PaperAI.exe`. Using the wrong one yields a blank
window and no error. Always test the `tauri build` artefact
(`tests/desktop-verify.mjs` and `tests/windows-integration.mjs` take `--exe`).

### K-09 — Bundle size

The NSIS installer is 11.1 MB and the binary 6.4 MB, dominated by the ~2.2 MB
PDF.js worker plus the 169 cMap files. Fine for a PoC; worth revisiting.

### K-10 — Clipboard read-back

`navigator.clipboard.writeText` works in the WebView2 window, but `readText`
can be refused depending on focus. The suite reports PARTIAL in that case rather
than failing.

### K-11 — Erase needs an editing mode

A freshly created annotation cannot be selected while the editor layer is
disabled (`.annotationEditorLayer.disabled { pointer-events: none }`,
`.highlightEditor { pointer-events: none }`). The Erase button therefore enters
Draw mode first and asks the user to click the annotation, then press Erase
again. Slightly awkward, but it is PDF.js's behaviour, not a bug we introduced.

### K-14 — Test-process leakage

Repeated automated launches leaked `msedgewebview2.exe` render processes (30 at
one point), which eventually stopped new WebView2 instances from initialising
their debug port. `tests/*.mjs` now kill the app they spawn; when a suite hangs,
run `Get-Process msedgewebview2 | Stop-Process -Force`.

---

## Environment limitations (not product issues)

| Item | Effect |
|---|---|
| `curl -o` writes blocked by the sandbox | use `scripts/download.mjs` |
| `rustup-init.exe` cannot create its `rust-analyzer` proxy (os error 183) | install via `rustup toolchain install` + manual proxies |
| VS Build Tools bootstrapper exits `0xC0000409` after writing everything | `cl.exe` and the SDK are complete; exit code is cosmetic |
| Nested `npm run build` inside `tauri build` hangs | build the frontend separately, then `tauri build --config '{"build":{"beforeBuildCommand":""}}'` |
| Git cannot create nested refs (`refs/heads/feat/...`) | branch is `phase2` |
| Chromium remote debugging disabled (cause unknown) | K-13 |

---

## Carried over from Phase 1 (still true)

* **Ink silently fails if custom CSS overrides any `.pdfViewer` / `.textLayer` /
  `.annotationEditorLayer` rule.** `src/style.css` scopes every custom rule to
  app-owned selectors and imports `pdf_viewer.css` verbatim.
* **An uncommitted ink stroke never reaches `saveDocument()`.** The adapter
  commits before serialising; verified by B/D4.1.
* **`updateMode` without `isFromUser = true` poisons the module-level pointer
  state** and every later stroke is dropped.
* **The `pdfViewer` CSS class on the viewer container is mandatory** — without
  it `--total-scale-factor` is undefined, every `.page` collapses to 0×0, and
  nothing renders with no console error.
