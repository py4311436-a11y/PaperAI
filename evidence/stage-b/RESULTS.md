# Stage B — real WebView2 verification results

Generated: 2026-10-15T05:26:26.556Z
Binary under test: `D:\PaperAI-Build\target\release\PaperAI.exe`

| ID | Check | Result | Notes |
|---|---|---|---|
| A0 | release 可执行文件存在 | **PASS** | D:\PaperAI-Build\target\release\PaperAI.exe |
| B0.1 | 连接到真实 WebView2 页面 | **PASS** | http://tauri.localhost/ (port 9730) |
| B0.2 | 前端在真实 WebView2 中启动 | **PASS** | PDF.js=6.4.299 isTauri=true             UA=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0 |
| B1.1 | 通过 Rust 后端打开单栏 PDF | **PASS** | 页数=23 |
| B0.3 | AnnotationEditorUIManager 已就绪（真实 WebView2） | **PASS** | hasUIManager=true |
| B1.2 | 鼠标拖选文本 + getSelection() | **PASS** | 选中(78)="was supported in part by the National Natural Scie" |
| B1.3 | 选中文本可写入剪贴板 | **PASS** | 读出="was supported in part by the National Na" |
| B1.4 | IEEE 双栏：左右栏 span 可区分 | **PASS** | 页数=6 span=250 左=111 右=139 |
| B1.5 | 双栏左栏拖选无串栏 | **PASS** | 左栏选中(11)="junctionles" |
| B1.6 | 双栏右栏拖选无串栏 | **PASS** | 右栏选中(56)="Bounded Trusted Region to extract parameters. Although i" |
| B2.1 | 选中 → Highlight 创建批注 | **PASS** | 批注 0 -> 1, dirty=false |
| B2.2 | 不同缩放比例下绘制 Ink（3 组） | **PASS** | zoom=1: 1->2; zoom=1.75: 2->3; zoom=0.75: 3->4 |
| B2.3 | Select→Draw 模式循环后仍可绘制 | **PASS** | 批注 4 -> 5 |
| B2.4 | 删除批注（真实删除） | **PASS** | 批注 5 -> 4; 点击前状态={"mode":15,"hasSelection":true,"hasSomethingToControl":true,"currentTool":"ink","isDirty":true,"annotationCount":5}; 点击命中=笔迹像素 |
| B3.1 | saveDocument() 输出含标准批注对象 | **PASS** | 字节=497510 页数=6 计数={"Highlight":1,"Ink":3} |
| B3.2 | Highlight 存在且可解析 | **PASS** | page=1 PDF.js 报告 quadPoints=n/a（以字节检查为准，见 STAGE_D） |
| B3.3 | Ink 含 InkList 笔迹 | **PASS** | page=1 笔画数=1 |
| D4.1 | 未 commit 的笔迹在保存时自动提交 | **PASS** | 保存前 Ink=3 → 直接 serialize() 后 Ink=4 |
| B4.1 | 缩放后 TextLayer 对齐（宽度比例） | **PASS** | 比例=2.500 期望=2.5 |
