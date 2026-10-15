# Stage D — cross-reader (Edge GUI) verification

Generated: 2026-10-15T05:14:59.785Z
PDF under test: `D:\AIreader\PaperAI-PoC\evidence\stage-d\annotated-EDGE-GUI.pdf`
Reader: Microsoft Edge — GUI (`--app`), `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`

| ID | Check | Result | Notes |
|---|---|---|---|
| D1.0 | 带批注的测试 PDF 存在 | **PASS** | D:\AIreader\PaperAI-PoC\output\annotated-desktop.pdf -> D:\AIreader\PaperAI-PoC\evidence\stage-d\annotated-EDGE-GUI.pdf |
| D1.1 | 以 GUI 方式启动 Edge 打开 PDF | **PASS** | pid=13412, D:\AIreader\PaperAI-PoC\evidence\stage-d\annotated-EDGE-GUI.pdf |
| D1.2 | 连接到 Edge PDF 阅读器窗口 | **PASS** | file:///D:/AIreader/PaperAI-PoC/evidence/stage-d/annotated-EDGE-GUI.pdf |
| D1.3 | 截图捕获（Edge 内置 PDF 阅读器） | **PASS** | D:\AIreader\PaperAI-PoC\evidence\stage-d\edge-annotated.png (6116 bytes) |
| D1.4 | 记录所用阅读器与文件 | **PASS** | url=file:///D:/AIreader/PaperAI-PoC/evidence/stage-d/annotated-EDGE-GUI.pdf title= |

**Adobe Acrobat Reader: BLOCKED** — not installed on this machine (see `evidence/stage-a/env.txt`).
Manual reproduction steps for a machine that has it are in
`reports/STAGE_D_SAVE_COMPATIBILITY.md`.
