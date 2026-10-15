# Stage C — Windows integration results

Generated: 2026-10-15T05:49:56.676Z
Installer: `D:\AIreader\PaperAI-PoC\dist\installer\PaperAI_0.2.0_x64-setup.exe`

| ID | Check | Result | Notes |
|---|---|---|---|
| C0 | NSIS 安装包存在 | **PASS** | D:\AIreader\PaperAI-PoC\dist\installer\PaperAI_0.2.0_x64-setup.exe             3.67 MB  SHA-256=c29f9dae30c724dcb6ac4e229f63d68d1a5163b96a4865404cd352391336be43 |
| C1.1 | 静默安装执行 | **PASS** | 退出码=0 |
| C1.2 | 安装目录已生成 | **PASS** | C:\Users\py252\AppData\Local\PaperAI\PaperAI.exe | C:\Users\py252\AppData\Local\PaperAI\paperai.log | C:\Users\py252\AppData\Local\PaperAI\uninstall.exe |
| C1.3 | 主程序 PaperAI.exe | **PASS** | C:\Users\py252\AppData\Local\PaperAI\PaperAI.exe |
| C1.4 | 开始菜单快捷方式 | **PASS** | C:\Users\py252\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\PaperAI.lnk |
| C1.5 | 已安装应用/卸载项登记 | **PASS** | PaperAI || "C:\Users\py252\AppData\Local\PaperAI\uninstall.exe" |
| C2.1 | .pdf 关联注册（作为候选项） | **PASS** | 自动注册(bundle.fileAssociations)=无; 脚本注册脚本输出=Registered: C:\Users\py252\AppData\Local\PaperAI\PaperAI.exe PaperAI is now offered in 'Open with' for .pdf. The default reader was not changed.             注册结果=HKCU:\SOFTWARE\Classes\Applications\PaperAI.exe ;; HKCU:\SOFTWARE\Classes\.pdf\OpenWithProgids contains PaperAI.exe |
| C2.2 | 未抢占系统默认 PDF 阅读器 | **PASS** | 安装前=MSEdgePDF 安装后=MSEdgePDF |
| C3.1 | 命令行打开中文路径 PDF | **PASS** | 进程数=1 窗口标题="PaperAI — IEEE 双栏 论文 副本.pdf"             参数=D:\AIreader\PaperAI-PoC\test-fixtures\dual\IEEE 双栏 论文 副本.pdf |
| C4.1 | 二次打开不产生第二个实例 | **PASS** | 第一次=1 个进程，第二次后=1 个进程 |
| C4.2 | 现有窗口接收新 PDF（含空格路径） | **PASS** | 窗口标题="PaperAI — 报告 中文 空格 copy.pdf"             参数=D:\AIreader\PaperAI-PoC\test-fixtures\single\报告 中文 空格 copy.pdf |
| C4.3 | 连续传入多个 PDF 不崩溃/不丢路径 | **PASS** | 连发 3 次后进程数=1 标题="PaperAI — 报告 中文 空格 copy.pdf" |
| C5.1 | 卸载程序执行 | **PASS** | 退出码=0 命令=C:\Users\py252\AppData\Local\PaperAI\uninstall.exe |
| C5.2 | 卸载后主程序移除 | **PASS** | PaperAI.exe 仍存在=False |
| C5.3 | 卸载后注册信息清理 | **PASS** | 残留卸载项=0 |
| C5.4 | 卸载后默认 PDF 阅读器未受影响 | **PASS** | 原始=MSEdgePDF 卸载后=MSEdgePDF |
| C5.5 | PaperAI 关联项清理 | **PASS** | 卸载器本身不清理本项目脚本注册的项（bundler 未写关联），已运行 scripts/register-file-association.ps1 -Unregister；仍存在=False |
