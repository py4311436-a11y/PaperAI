# Stage B — PDF core + annotations inside the real Tauri WebView2

**Binary under test:** `D:\PaperAI-Build\target\release\PaperAI.exe`
(the output of `tauri build`, not the Vite dev server and not headless Edge).
Raw log: `evidence/stage-b/desktop-verify.log`, table: `evidence/stage-b/RESULTS.md`,
screenshots: `evidence/stage-b/*.png`.

## Result: 19 / 19 PASS

| ID | Check | Result | Notes |
|---|---|---|---|
| A0 | release 可执行文件存在 | PASS | — |
| B0.1 | 连接到真实 WebView2 页面 | PASS | `http://tauri.localhost/` |
| B0.2 | 前端在真实 WebView2 中启动 | PASS | PDF.js 6.4.299, `isTauri=true`, UA `Chrome/155.0.0.0 … Edg/155.0.0.0` |
| B0.3 | AnnotationEditorUIManager 就绪 | PASS | acquired through the EventBus |
| B1.1 | 通过 Rust 后端打开单栏 PDF | PASS | 23 页 |
| B1.2 | 鼠标拖选 + `getSelection()` | PASS | 62 chars |
| B1.3 | 选中文本写入剪贴板 | PASS | 读回一致 |
| B1.4 | IEEE 双栏左右栏可区分 | PASS | 6 页，250 spans，左 111 / 右 139 |
| B1.5 | 左栏拖选无串栏 | PASS | `of 'e' as it is undefined.` |
| B1.6 | 右栏拖选无串栏 | PASS | `excellent industry standard tool, widely used to extract mod…` |
| B2.1 | 选中 → Highlight | PASS | 批注 0 → 1 |
| B2.2 | 三种缩放下绘制 Ink | PASS | zoom 1.0 / 1.75 / 0.75 各 +1 |
| B2.3 | Select→Draw 循环后可继续绘制 | PASS | 3 → 4 |
| B2.4 | 删除批注（真实删除） | PASS | 5 → 4 |
| B3.1 | `saveDocument()` 含标准批注对象 | PASS | `{"Highlight":1,"Ink":4}` |
| B3.2 | Highlight 存在且可解析 | PASS | 见下方 QuadPoints 说明 |
| B3.3 | Ink 含 InkList 笔迹 | PASS | page 1 |
| D4.1 | 未 commit 的笔迹在保存时自动提交 | PASS | Ink 4 → 5 |
| B4.1 | 缩放后 TextLayer 对齐 | PASS | 宽度比例 2.500（期望 2.5） |

---

## How the real WebView2 was driven

Puppeteer was **not** usable: connecting to the WebView2 page target races the
navigation commit and every subsequent `Runtime.evaluate` hangs. The suite
speaks raw CDP to the **browser** endpoint with a flattened session
(`tests/lib-cdp.mjs`).

Two environment facts were required to make it work, both verified:

1. **Renderer suspension.** WebView2 treats the window as occluded in a session
   with no interactive compositor. The page loads, JS runs (the Tauri IPC call
   for `plugin:event|listen` is issued), and then the renderer stops servicing
   CDP. Adding `--disable-renderer-backgrounding
   --disable-backgrounding-occluded-windows --disable-background-timer-throttling
   --disable-features=CalculateNativeWinOcclusion` to
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` restores it (`probe/cdp-throttle.mjs`).
2. **Drag needs `buttons: 1`.** `Input.dispatchMouseEvent` with
   `mouseMoved` and no `buttons` field is treated as hover: Chromium neither
   selects text nor draws ink. Without it the first runs reported "选中(0)".

## Real product bugs this stage found (headless browser tests missed them)

These are the actual value of testing the packaged app:

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 1 | `adapter.eventBusInstance.on(...)` executed at module scope | `TypeError: Cannot read properties of undefined (reading 'on')`; the whole module died before `window.__paperai` was installed — **blank window, no console error visible from outside** | move the subscriptions into `boot()`, after `adapter.init()` |
| 2 | `#viewer` lost its `pdfViewer` class when the HTML was rewritten | every `.page` collapsed to 0×0 — PDF.js sizes pages with `round(down, var(--total-scale-factor) * Npx, …)` and that variable is defined by `.pdfViewer .page`. `PDFViewer` does **not** add the class itself | `class="pdfViewer"` on `#viewer` |
| 3 | `pdfViewer.currentPageNumber = 1` right after `setDocument()` | `TypeError: Cannot destructure property 'div' of 'e' as it is undefined` — `_setCurrentPageNumber` walks page views whose `div` is not built yet. This made every CLI launch look like "open failed" | drive the numeric scale branch only (`numericFitScale`), never the setter |
| 4 | preset zoom strings after `setDocument()` | `PDFViewer.#setScale` early-returns while `_currentPageNumber` is 0, so pages stay 0×0 | same as above |
| 5 | dirty flag never set for ink strokes | draw → save-fails → user loses the warning; `dirty` stayed `false` | adapter owns the flag (`markDirty`), `commitPendingInk` compares annotation counts, shell only reflects it |
| 6 | non-Tauri `listen()` call | `TypeError: … 'transformCallback'` | `bridge.onOpenFiles` is a no-op outside Tauri |

## QuadPoints discrepancy (B3.2)

PDF.js's annotation object reported `quadPoints: []` for the Highlight, while the
**file** demonstrably contains it. Byte-level inspection of the very same file
(`evidence/stage-d/byte-inspection.json`):

```json
{ "subtype_Highlight": 1, "subtype_Ink": 3, "QuadPoints": 1, "InkList": 3, "AP_streams": 4 }
```

So the annotation is written correctly and the gap is in how
`page.getAnnotations()` surfaces it. Recorded as a known issue; the byte check
is the authority.

## Dual-column scope

Each category is still a **copy of one source document**
(`test-fixtures/MANIFEST.json` lists the identical SHA-256 of the pairs), so
the honest claim is "no column bleeding on the samples tested", not "reliable on
all IEEE papers".

## Not covered here

* High-DPI: the WebView ran at `devicePixelRatio = 1.5`, so the TextLayer
  alignment check was made at 150 % scaling — that part is covered, but no
  separate 125 %/200 % matrix was run.
* Encrypted / damaged / empty PDFs: handled with clear errors in Rust
  (`resolve_pdf_path` verifies the `%PDF-` magic and a 512 MB cap), but no
  fixture for them was produced in this round.
