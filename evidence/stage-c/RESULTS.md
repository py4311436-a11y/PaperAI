# Stage C — Windows integration results

Generated: 2026-10-15T12:59:51.586Z
Installer: `D:/AIreader/PaperAI-PoC/release/PaperAI_0.3.1_x64-setup.exe`

| ID | Check | Result | Notes |
|---|---|---|---|
| C0 | NSIS 安装包存在 | **PASS** | D:/AIreader/PaperAI-PoC/release/PaperAI_0.3.1_x64-setup.exe             4.76 MB  SHA-256=37a3e4636228d164a4d1ebc527eb5a635ce0f0d8c31300afe39cdfed32258509 |
| C1.1 | 静默安装执行 | **PASS** | 退出码=0 |
| C1.2 | 安装目录已生成 | **PASS** | D:\Program Files\PaperAI |
| C1.3 | 主程序存在且版本与安装包一致 | **PASS** | D:\Program Files\PaperAI\PaperAI.exe  ProductVersion=0.3.1  期望=0.3.1 |
| C1.4 | 开始菜单快捷方式 | **PASS** | C:\Users\py252\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\PaperAI.lnk |
| C1.5 | 已安装应用/卸载项登记 | **PASS** | PaperAI || "D:\Program Files\PaperAI\uninstall.exe" |
| C2.1 | .pdf 关联由安装器原生注册（候选项） | **PASS** | 注册结果=HKCU:\SOFTWARE\Classes\Applications\PaperAI.exe ;; HKCU:\SOFTWARE\Classes\.pdf\OpenWithProgids contains PaperAI.exe; .pdf 默认 ProgId=""（安装器不得抢占默认） |
| C2.2 | 未抢占系统默认 PDF 阅读器 | **PASS** | 安装前=MSEdgePDF 安装后=MSEdgePDF |
| C3.1 | 命令行打开中文路径 PDF | **PASS** | 进程数=1 窗口标题="PaperAI — IEEE 双栏 论文 副本.pdf"             参数=D:\AIreader\PaperAI-PoC\test-fixtures\dual\IEEE 双栏 论文 副本.pdf |
| C4.1 | 二次打开不产生第二个实例 | **PASS** | 第一次=1 个进程，第二次后=1 个进程 |
| C4.2 | 现有窗口接收新 PDF（含空格路径） | **PASS** | 窗口标题="PaperAI — 报告 中文 空格 copy.pdf"             参数=D:\AIreader\PaperAI-PoC\test-fixtures\single\报告 中文 空格 copy.pdf |
| C4.3 | 连续传入多个 PDF 不崩溃/不丢路径 | **PASS** | 连发 3 次后进程数=1 标题="PaperAI — 报告 中文 空格 copy.pdf" |
| C5.1 | 卸载程序执行 | **PASS** | 退出码=0 命令=D:\Program Files\PaperAI\uninstall.exe |
| C5.2 | 卸载后主程序移除 | **PASS** | PaperAI.exe 仍存在=False |
| C5.3 | 卸载后注册信息清理 | **PASS** | 残留卸载项=0 |
| C5.4 | 卸载后默认 PDF 阅读器未受影响 | **PASS** | 原始=MSEdgePDF 卸载后=MSEdgePDF |
| C5.5 | 卸载器原生清理 PaperAI 关联项 | **PASS** | Applications\PaperAI.exe 仍存在=False; OpenWithProgids=removed |
