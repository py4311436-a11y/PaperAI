# Stage D — cross-reader verification, original-file protection, reliable save

Raw logs: `evidence/stage-d/save-safety.log`, `save-safety-RESULTS.md`,
`byte-inspection.json`, `edge-gui-RESULTS.md`, `desktop-diagnosis.txt`,
`evidence/stage-b/probe-webview2-health.mjs`.

---

## 1. Save safety — 12 / 12 PASS (unchanged)

All destructive cases run on copies under `test-fixtures/save/`.

| ID | Check | Result | Evidence |
|---|---|---|---|
| D3.0 | 打开测试副本 | PASS | 6 页，初始 SHA-256 `e90453ad…` |
| D3.1 | 故障注入需显式开启 | PASS | gated on `PAPERAI_ALLOW_FAULT_INJECTION=1` |
| D3.2 | 正常保存：写入 + 备份 + 往返字节稳定 | PASS | `code=saved`, 备份 `.paperai.bak`, 未修改文档往返 SHA 不变 |
| D3.3 | 同一文件连续保存 3 次 | PASS | 三次均成功，字节一致 |
| D3.4 | 反复保存后仍是可解析 PDF | PASS | 重开 6 页 |
| D3.5 | 注入 `target_readonly` | PASS | 原件 SHA 不变，无残留临时文件 |
| D3.6 | 注入 `temp_write` | PASS | 原件 SHA 不变，临时文件已清理 |
| D3.7 | 注入 `replace` | PASS | 原件 SHA 不变，临时文件已清理 |
| D3.8 | 真实只读属性目标 | PASS | `save_target_readonly`，原件不变 |
| D3.9 | Save As 到新路径 | PASS | 来源文件 SHA 不变 |
| D3.10 | **真实 Save 按钮**失败时保留 dirty | PASS | dirty 前=后=`true`，原件 SHA 不变 |
| D3.11 | 拒绝非 PDF 数据 | PASS | `save_temp_invalid`，目标不变 |

---

## 2. Structural verification of the exported PDF — PASS

`output/annotated-desktop.pdf` (497,510 bytes) inspected with
`tools/inspect_pdf.py`, which parses raw PDF objects **without** going through
PDF.js:

```json
{
  "header": "%PDF-1.6",
  "subtype_Highlight": 1,
  "subtype_Ink": 3,
  "Annots_arrays": 2,
  "QuadPoints": 1,
  "InkList": 3,
  "AP_streams": 4,
  "XFA": false
}
```

`/Type /Annot`, `/Subtype /Highlight`, `/Subtype /Ink`, `QuadPoints`, `InkList`
and appearance streams are all present — PDF 32000-1 objects, not a canvas
overlay.

---

## 3. Cross-reader verification — three independent lines of evidence

### 3a. Byte-level (independent parser) — PASS

`tools/inspect_pdf.py` reads the raw objects and confirms the annotations are
written correctly. Necessary, but it says nothing about whether another reader
*renders* them.

### 3b. Automated GUI capture — PARTIAL

**Microsoft Edge.** `tests/edge-gui-check.mjs` launches a real GUI window on the
annotated file and captures it with `PrintWindow(PW_RENDERFULLCONTENT)`.

> Earlier attempts used GDI `CopyFromScreen` and CDP `Page.captureScreenshot`;
> both returned the desktop wallpaper / a blank image. That was **not** "no
> compositor" — DWM is running and `OpenInputDesktop` succeeds
> (`evidence/stage-d/desktop-diagnosis.txt`). `CopyFromScreen` only reads the
> composited framebuffer, and Chromium's PDF plugin layer is outside the
> surface CDP captures. `PrintWindow` asks the window to render itself, which
> does work.

Result: `evidence/stage-d/edge-printwindow.png` — Edge renders the document
correctly (title, authors, abstract, two-column layout). No highlight blob was
detected in the captured region, consistent with Edge's PDF viewer not painting
the annotation layer by default. **Not conclusive either way.**

**WPS Office** (`D:\Program Files\WPS Office\…\wps.exe /prometheus /pdf`) — an
independent, non-PDFium engine. `tests/wps-capture.mjs` + `PrintWindow`:

* `evidence/stage-d/wps-try6.png` clearly shows the **Ink strokes** rendered as
  black curves over the body text.
* A naive "is there yellow" detector was fooled by the paper's yellow flow-chart
  nodes — `tools/detect_annotations.py` reported a 12,849 px blob that is the
  figure, not the annotation. So the automated check for the highlight is
  **inconclusive**, not negative.

### 3c. Human verification on a normal desktop — PASS for Highlight

The user, on a desktop with a working compositor, opened the annotated PDF in
WPS and **confirmed the yellow highlight is visible on the abstract passage**.
This is stronger than any capture produced here, because it is the real
rendered surface. The Ink strokes are independently visible in `wps-try6.png`.

### 3d. Read-back of the geometry — PASS (and it retracts K-04)

`tests/readback-annotations.mjs` loads `output/annotated-desktop.pdf` in plain
Node (no browser, no CDP) and reports what a reader would see. Output archived
at `evidence/stage-d/readback-annotations.txt`:

```
/Subtype /Highlight  rect=[254.0,463.6,296.9,478.0]  color=[255,240,102]  hasAppearance=true
  quadPoints: 1 quad(s), 8 values
    quad 0: (254.7,464.4)..(296.3,477.1)
      covered text: "with6.5%junctionless"
/Subtype /Ink  rect=[173.6,365.2,252.6,393.1]  color=[0,0,0]  hasAppearance=true
  inkLists: 1 stroke(s), 26 points, x 177.1..249.1, y 368.7..389.7
/Subtype /Ink  rect=[176.4,309.4,224.6,331.6]  color=[0,0,0]  hasAppearance=true
  inkLists: 1 stroke(s), 26 points, x 179.9..221.1, y 312.8..328.2
/Subtype /Ink  rect=[171.4,304.2,274.4,346.7]  color=[0,0,0]  hasAppearance=true
  inkLists: 1 stroke(s), 26 points, x 174.9..270.9, y 307.5..343.4
```

Three things this settles:

1. **The highlight is on the intended text.** The quad covers `junctionless` in
   the abstract — exactly the word the user's screenshot
   (`evidence/stage-d/user-confirmed-highlight.png`) shows highlighted. The
   independent text extraction and the third-party render agree.
2. **`quadPoints` is fully readable** — 8 values, correct box. This retracts the
   old K-04 ("PDF.js reports an empty quadPoints"): the data was always there,
   but `quadPoints` is an array-LIKE object so `Array.isArray()` returns false,
   and the Ink property is `inkLists` (plural). That was our test bug, not a
   library defect. `tests/desktop-verify.mjs` B3.2 had the same flaw and is now
   fixed to use `Array.from()`.
3. **The ink strokes carry real geometry** — 3 strokes × 26 points each, with
   coordinate ranges matching their bounding rects, and every annotation has an
   appearance stream.

### 3e. Acrobat Reader — BLOCKED

Not installed (`evidence/stage-a/env.txt`).

### 3e. Automated CDP re-verification — BLOCKED

The CDP route that produced the 19/19 Stage B results stopped working part-way
through Stage D: `--remote-debugging-port` is now ignored by both WebView2 and
Edge on this machine.

`scripts/probe-webview2-health.mjs` proves this is **not** a product regression:
the app is fully functional (correct native window title with the document
name, PDF opened, IPC working, `responding=True`) while no debug port ever
listens — including with an explicit `--user-data-dir`. No Edge/Chromium policy
is blocking it (`evidence/stage-b/edge-policies.txt`). Root cause not
established; recorded as an environment change.

---

## 4. Summary

| Property | Status |
|---|---|
| Saved file contains standard PDF annotations | **PASS** (byte-level) |
| Saving survives the reader round-trip inside PaperAI | **PASS** |
| A failed save never damages the original | **PASS** (7 distinct failure paths) |
| Repeated saves do not corrupt or duplicate annotations | **PASS** |
| Uncommitted ink is never lost on save | **PASS** |
| dirty survives a failed save | **PASS** |
| Third-party annotations preserved | **NOT RUN** (no suitable fixture) |
| Highlight covers the intended text | **PASS** — read-back reports `junctionless` under the quad |
| Ink strokes carry real geometry | **PASS** — 3 × 26 points, appearance streams present |
| Display in WPS (independent engine) | **PASS** — highlight confirmed by the user, ink visible in capture |
| Display in Edge | **PARTIAL** — document renders; annotation layer not shown by default |
| Display in Acrobat Reader | **BLOCKED** (not installed) |
| Automated CDP re-verification | **BLOCKED** (remote debugging disabled on this machine) |

### Re-run when the environment allows

```bash
node tests/desktop-verify.mjs --exe "<PaperAI.exe>" --port 9400   # 19 assertions
node tests/save-safety.mjs    --exe "<PaperAI.exe>" --port 9700   # 12 assertions
node tests/wps-capture.mjs    output/annotated-desktop.pdf        # WPS capture
node tests/edge-gui-check.mjs --pdf output/annotated-desktop.pdf  # Edge capture
python tools/detect_annotations.py <capture.png>                  # objective check
```
