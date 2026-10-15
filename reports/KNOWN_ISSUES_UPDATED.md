# Known issues — updated after Phase 2

Phase-1 issues are kept where they still apply; everything here was observed in
this round unless marked otherwise.

Severity: **P0** blocks a shipping build · **P1** serious · **P2** cosmetic.

---

## P0

### K-01 — Tauri's declarative `.pdf` file association does not register on Windows (`currentUser`)

`bundle.fileAssociations` is configured and accepted by the schema, but a silent
install writes no registry entry at all (verified by dumping
`HKCU`/`HKLM\SOFTWARE\Classes`). `role` is macOS-only; `nsis.hooks` is not in the
2.12.3 schema; `nsis.installerHooks` is accepted but inert.

* Workaround shipped: `scripts/register-file-association.ps1` (+ `-Unregister`).
* Not tested: whether `installMode: "perMachine"` makes the built-in
  registration work (needs an elevated install).
* Blocks: shipping as-is. Must be resolved before V0.1.

### K-02 — GUI verification of other PDF readers is impossible in this environment

No interactive compositor: windows are created and responsive but never painted,
so both GDI and CDP screenshots of a rendered PDF come back blank/underlying
desktop. Edge = BLOCKED, Acrobat = not installed.

* Blocks: claiming "cross-reader verified".
* Not a product defect. Re-run `tests/edge-gui-check.mjs` on a normal desktop.

---

## P1

### K-03 — `window.__paperai` test API ships inside the release binary

The automation surface used by `tests/desktop-verify.mjs` and
`tests/save-safety.mjs` is compiled into the product. It is convenient and
read-mostly, but it is not something a shipping build should expose.

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
when another process owns the foreground. Untested here (K-02). If focus fails,
the file is still opened — the window title is the observable.

### K-06 — PDF.js version coupling is deep

`reports/PDFJS_COMPATIBILITY.md` lists ~12 verified behaviours that would break
on upgrade, including: `globalThis.pdfjsLib` ordering, the `pdfViewer` CSS class,
the `#setScale` numeric-vs-preset split, `cleanup()` instead of `destroy()`,
`updateMode(mode, null, true)`, and the `supportMultipleDrawings` Ink commit rule.
`pdfjs-dist` is pinned to the exact version `6.4.299`.

### K-07 — Non-atomic replace

Saving is two renames because Windows `rename` cannot overwrite. A crash between
them leaves `<name>.pdf.paperai.old` holding the previous content — recoverable,
not atomic. See `reports/SAVE_SAFETY_DESIGN.md`.

---

## P2

### K-08 — Exe name vs package name

`cargo build` produces `paperai.exe` **without the embedded frontend**; only
`tauri build` produces the real `PaperAI.exe`. Using the wrong one yields a blank
window and no error. Always test the `tauri build` artefact
(`tests/desktop-verify.mjs` and `tests/windows-integration.mjs` take `--exe`).

### K-09 — Bundle size

The NSIS installer is 3.67 MB and the binary 6.4 MB, dominated by the ~2.2 MB
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

### K-12 — Verbose test-API surface in the release build

`adapter.debugState()` etc. are shipped; same mitigation as K-03.

---

## Environment limitations (not product issues)

| Item | Effect |
|---|---|
| `curl -o` writes blocked by the sandbox | use `scripts/download.mjs` |
| `rustup-init.exe` cannot create its `rust-analyzer` proxy (os error 183) | install via `rustup toolchain install` + manual proxies |
| VS Build Tools bootstrapper exits `0xC0000409` after writing everything | `cl.exe` and the SDK are complete; exit code is cosmetic |
| Nested `npm run build` inside `tauri build` hangs | build the frontend separately, then `tauri build --config '{"build":{"beforeBuildCommand":""}}'` |
| Git cannot create nested refs (`refs/heads/feat/...`) | branch is `phase2` |
| No interactive compositor | K-02 |

---

## Carried over from Phase 1 (still true)

* **Ink silently fails if custom CSS overrides any `.pdfViewer` / `.textLayer` /
  `.annotationEditorLayer` rule.** `src/style.css` now scopes every custom rule
  to app-owned selectors (`#toast`, `#dirty-modal`) and imports
  `pdf_viewer.css` verbatim.
* **An uncommitted ink stroke never reaches `saveDocument()`.** The adapter
  commits before serialising; verified by D4.1.
* **`updateMode` without `isFromUser = true` poisons the module-level pointer
  state** and every later stroke is dropped.
