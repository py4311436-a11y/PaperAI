# Stage D — cross-reader compatibility, original-file protection, reliable save

Raw logs: `evidence/stage-d/save-safety.log`, `save-safety-RESULTS.md`,
`byte-inspection.json`, `edge-gui-RESULTS.md`.

---

## 1. Save safety — 12 / 12 PASS

All destructive cases run on copies under `test-fixtures/save/`.

| ID | Check | Result | Evidence |
|---|---|---|---|
| D3.0 | 打开测试副本 | PASS | 6 页，初始 SHA-256 `e90453ad…` |
| D3.1 | 故障注入需显式开启 | PASS | gated on `PAPERAI_ALLOW_FAULT_INJECTION=1` |
| D3.2 | 正常保存：写入 + 备份 + 往返字节稳定 | PASS | `code=saved`, 备份 `.paperai.bak` 生成，未修改文档往返 SHA 不变 |
| D3.3 | 同一文件连续保存 3 次 | PASS | 三次均成功，字节一致 |
| D3.4 | 反复保存后仍是可解析 PDF | PASS | 重开 6 页 |
| D3.5 | 注入 `target_readonly` | PASS | 失败；原件 SHA 不变；无残留临时文件 |
| D3.6 | 注入 `temp_write` | PASS | 失败；原件 SHA 不变；临时文件已清理 |
| D3.7 | 注入 `replace` | PASS | 失败；原件 SHA 不变；临时文件已清理 |
| D3.8 | 真实只读属性目标 | PASS | `save_target_readonly`；原件 SHA 不变 |
| D3.9 | Save As 到新路径 | PASS | 来源文件 SHA 不变 |
| D3.10 | **真实 Save 按钮**失败时保留 dirty | PASS | dirty 前=后=`true`，原件 SHA 不变，提示 `保存失败 [save_target_readonly] …` |
| D3.11 | 拒绝非 PDF 数据 | PASS | `save_temp_invalid`；目标 SHA 不变 |

D3.10 is the end-to-end proof: ink was drawn, the file was marked read-only, the
real toolbar button was clicked, the user got a specific error, the document
stayed dirty, and the file on disk was untouched.

Design details and the honest limits of the guarantees are in
`reports/SAVE_SAFETY_DESIGN.md`.

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
and appearance streams are all present — these are PDF 32000-1 objects, not a
canvas overlay.

SHA-256:

| File | Bytes | SHA-256 |
|---|---|---|
| `output/annotated-desktop.pdf` | 497,510 | `2a99ff81e57ef4298d6402f4bebc95d63815709d10f95510563a4398422dbbde` |
| `test-fixtures/dual/IEEE 双栏 论文 副本.pdf` (source) | 490,608 | `e90453ad008664496bf957a600a37aded935bff5a31d0c7310570e5af2b22559` |
| `dist/installer/PaperAI_0.2.0_x64-setup.exe` | 3,852,257 | `c29f9dae30c724dcb6ac4e229f63d68d1a5163b96a4865404cd352391336be43` |
| `D:\PaperAI-Build\target\release\PaperAI.exe` | 6,394,368 | `0f880f771c74237df0602f1749aecb2b79991b0c88055491ff38534382fd505f` |

Third-party annotation preservation was **not** tested in this round: no
legally redistributable pre-annotated PDF was available locally, and the
pre-existing `output/example_annotated.pdf` is itself a PaperAI product, not a
third-party file.

---

## 3. Cross-reader GUI verification — BLOCKED (both readers)

This is an environment limitation, and it is reported as BLOCKED rather than
quietly upgraded.

**What happens in this session:** the desktop has no interactive compositor.
Windows still creates windows and they respond (`Get-Process … Responding=True`,
correct titles, correct command-line hand-off), but nothing is ever painted:

* GDI `CopyFromScreen` returns the desktop wallpaper for *any* window rect —
  captured `evidence/stage-d/edge-gdi.png`, which shows an unrelated app that was
  underneath, not Edge.
* CDP `Page.captureScreenshot` of Edge's PDF viewer returns a blank white image
  (`evidence/stage-d/edge-annotated.png`, 6,116 bytes) because the PDF renders in
  the PDFium plugin layer, outside the captured surface.

**Microsoft Edge** — `tests/edge-gui-check.mjs` launches a real GUI window on the
annotated file and successfully connects over CDP
(`evidence/stage-d/edge-gui-RESULTS.md`), but the capture is blank → **BLOCKED**.

**Adobe Acrobat Reader** — not installed on this machine
(`evidence/stage-a/env.txt`, `acrobat_reader: (none)`) → **BLOCKED**.

### Manual reproduction on a normal desktop

```powershell
# 1. open the exported file in each reader and look at page 1
start msedge "D:\AIreader\PaperAI-PoC\output\annotated-desktop.pdf"
start "" "C:\Program Files\Adobe\Acrobat Reader DC\Acrobat\Acrobat.exe" ^
      "D:\AIreader\PaperAI-PoC\output\annotated-desktop.pdf"

# 2. in each reader confirm
#    - the yellow highlight renders on the sentence used for the highlight
#    - the black ink strokes are visible and not offset from the page
#    - closing and reopening keeps them
#    - note separately whether the reader can SELECT/EDIT the annotation
#      (displaying it is not the same as being able to edit it)
```

The second bullet matters: "it shows" must not be reported as "it is editable".
Only the display property has been established here, and only structurally.

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
| Display in an independent GUI reader | **BLOCKED** (no compositor) |
| Display in Acrobat Reader | **BLOCKED** (not installed) |
