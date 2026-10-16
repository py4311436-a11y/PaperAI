# PDF.js Compatibility Notes — locked baseline `<email>`

Every statement below was produced by reading the actual locked package in this
repo (`node_modules/pdfjs-dist`) or by running it. Nothing is taken from docs or
from memory of another version.

Unless noted otherwise the probe scripts live in `probe/` and are re-runnable:

```bash
node probe/export-check.mjs     # export surface of the locked version
node probe/ink16.mjs            # Ink commit mechanism
```

---

## 1. Package entry points

| Field | Value |
|---|---|
| version | `6.4.299` (exact pin, no `^`) |
| `main` | `build/pdf.mjs` |
| `types` | `types/src/pdf.d.ts` |
| viewer components | `web/pdf_viewer.mjs` |
| style | `web/pdf_viewer.css` |
| runtime assets | `cmaps/`, `standard_fonts/`, `wasm/`, `iccs/` |

`module` is **undefined** — there is no separate ESM entry beyond `main`.

---

## 2. Export surface (this is the Phase-1 contradiction, resolved)

Phase 1 contained both "not exported" and "exported" for
`AnnotationEditorUIManager`. Both were half-right because they referred to
different entry points. The precise facts:

| Symbol | `pdfjs-dist` (`build/pdf.mjs`) | `pdfjs-dist/web/pdf_viewer.mjs` |
|---|---|---|
| `AnnotationEditorUIManager` | **EXPORTED** (function) | not exported |
| `AnnotationEditorLayer` | **EXPORTED** (function) | not exported |
| `AnnotationEditorType` | **EXPORTED** (object) | not exported |
| `AnnotationEditorParamsType` | **EXPORTED** (object) | not exported |
| `InkEditor` | not exported | not exported |
| `HighlightEditor` | not exported | not exported |
| `FreeTextEditor` | not exported | not exported |
| `AnnotationStorage` | not exported | not exported |

Total export counts in 6.4.299: `build/pdf.mjs` = 62, `web/pdf_viewer.mjs` = 22.

**Corrected wording for the reports:** `AnnotationEditorUIManager` *is* part of
the public `pdfjs-dist` API surface, but it is **not** re-exported by the
viewer bundle, and it is not practically constructible by hand:

```
AnnotationEditorUIManager.length === 16      // 16 required constructor args
AnnotationEditorLayer.length     === 1
```

Several of those 16 arguments are objects the viewer normally supplies
(`altTextManager`, `commentManager`, `signatureManager`, `pageColors`,
`highlightColors`, …). Hand-constructing it is therefore a supported-looking but
unsupported-in-practice path.

**Integration decision (unchanged):** acquire the instance from the viewer via
`eventBus.on("annotationeditoruimanager", …)`. Only `src/pdf/pdfjs-adapter.ts`
does this.

---

## 3. `AnnotationEditorType` values

Read out of `build/pdf.mjs`:

```
DISABLE   = -1
NONE      =  0
FREETEXT  =  3
HIGHLIGHT =  9
STAMP     = 13
INK       = 15
SIGNATURE = 101
```

---

## 4. Mode switching — `updateMode`

```js
async updateMode(mode, editId = null, isFromUser = false,
                 isFromKeyboard = false, mustEnterInEditMode = false,
                 editComment = false)
```

* The 3rd argument `isFromUser` **must be `true`** when the change originates
  from our toolbar. PDF.js keeps module-level pointer state (`CurrentPointers`)
  that is only reset on a user-initiated mode change. Omitting it makes every
  stroke after the first one return early in `DrawingEditor.startDrawing()`.
* The call is a no-op when `#mode === mode`, so switching to the mode already
  active does not reset pointer state.

Adapter call site: `PdfjsAdapter.setTool()` →
`uiManager.updateMode(mode, null, true)`.

---

## 5. Highlight

* Public method: `uiManager.highlightSelection()`.
* **Ordering matters.** The DOM selection must exist *before* entering
  `HIGHLIGHT` mode; the selection survives the mode switch. Entering highlight
  mode first makes the text layer non-selectable and the call produces nothing.
* Implemented in `PdfjsAdapter.highlightSelection()`.

---

## 6. Ink — the two silent-failure traps

1. **`InkEditor.supportMultipleDrawings === true`.** With that flag,
   `DrawingEditor._endDraw()` returns early on pointer-up and does **not** call
   `endDrawing()`. A stroke lives on a temporary canvas until the drawing
   session is explicitly ended. `saveDocument()` will silently omit it.
   → adapter always calls `endDrawingSession()` / `commitOrRemove()` before
   serialising (`commitPendingInk()`).
2. **`DrawingEditor._getDrawingTarget(_parent, { target }) { return event.target; }`**
   PDF.js uses `event.target` directly, so pointer events must land on the
   annotation editor layer. Any custom CSS that hands pointer events to a child
   (`.textLayer span`, an overlay, a wrapper) breaks Ink **with no error**.
   → `src/style.css` does not override any `.pdfViewer` / `.textLayer` /
   `.annotationEditorLayer` rule.

---

## 7. Zoom

`PDFViewer.currentScaleValue` accepts exactly (verified by reading the
`switch` in `pdf_viewer.mjs`):

```
"page-actual" | "page-width" | "page-height" | "page-fit" | "auto"
```

Anything else logs `unknown zoom value` and is ignored. The pre-v6 names
`"width"` and `"page"` are **gone** — do not reintroduce them.

---

## 8. Document lifecycle

* `PDFDocumentProxy` in 6.4.299 has **`cleanup()`, not `destroy()`**.
  `destroy()` belongs to `PDFDocumentLoadingTask`. Calling `doc.destroy()`
  throws. (This differs from older PDF.js releases and bit us during the
  adapter rewrite.)
* `saveDocument(): Promise<Uint8Array>` — returns the full serialised file.
* `annotationStorage` is a **public** property on `PDFDocumentProxy`; the
  `AnnotationEditorUIManager`'s copy is private (`#annotationStorage`). Its
  inner map is private too, so annotation counting goes through the rendered
  editor elements (`PdfjsAdapter.annotationCount()`).

---

## 9. Bootstrap constraints

* `web/pdf_viewer.mjs` destructures `AbortException`, `DOMException`, … off
  `globalThis.pdfjsLib` **at module-evaluation time**. `globalThis.pdfjsLib`
  must therefore be assigned before the dynamic `import()` of the viewer
  module, otherwise the load fails immediately.
* `PDFViewer` requires the `container` element to be `position: absolute`
  (checked at construction).
* `PDFLinkService.setDestinationHash()` **no longer exists** in 6.x.
* `PDFViewer` validates that the viewer component and the core library come
  from the same build.

---

## 10. Version policy

`package.json` pins `"pdfjs-dist": "6.4.299"` with no range operator. Worker,
viewer module, CSS and the core library must all come from that single install;
mixing versions triggers the API-version check. Upgrading requires re-running
`tests/final-verify.mjs` and `tests/desktop-verify.mjs` before anything else.
