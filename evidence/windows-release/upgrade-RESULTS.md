# Windows upgrade path — PaperAI_0.2.0_x64-setup.exe -> PaperAI_0.3.1_x64-setup.exe

Generated: 2026-10-15T13:06:27.716Z
Old: `D:\AIreader\PaperAI-PoC\release\PaperAI_0.2.0_x64-setup.exe`
New: `D:\AIreader\PaperAI-PoC\release\PaperAI_0.3.1_x64-setup.exe`

| ID | Check | Result | Notes |
|---|---|---|---|
| U0.1 | 两个安装包都存在 | **PASS** | PaperAI_0.2.0_x64-setup.exe             PaperAI_0.3.1_x64-setup.exe |
| U0.2 | 清空已有安装与配置 | **PASS** | 原安装目录=(无) 配置目录=true（配置已备份，退出时还原） |
| U1.1 | 安装旧版 0.2.0 | **PASS** | 安装目录版本=0.2.0 |
| U1.2 | 写入升级前的用户配置（模拟真实用户） | **PASS** | 凭据写入=wrote=True             配置：1 个 Provider，凭据 PaperAI/AIProvider/paperai-upgrade-test |
| U2.1 | 覆盖安装 0.3.1 | **PASS** | 覆盖前=0.2.0 覆盖后=0.3.1 |
| U2.2 | Provider 设置升级后保留 | **PASS** | ai-profiles.json 仍在，display_name / base_url / model 均未被覆盖 |
| U2.3 | API Key 在凭据管理器中保留 | **PASS** | CredRead(PaperAI/AIProvider/paperai-upgrade-test) -> present |
| U2.4 | 升级后 .pdf 关联仍在 | **PASS** | HKCU:\SOFTWARE\Classes\Applications\PaperAI.exe |
| U2.5 | 默认 PDF 阅读器未被改变 | **PASS** | 升级前=MSEdgePDF 升级后=MSEdgePDF |
| U2.6 | 用户 PDF 未被安装/升级改动 | **PASS** | pdf 文件数 11 -> 11; 样本 SHA256 E90453AD0086… -> E90453AD0086… |
| U2.7 | 升级后的 0.3.1 能正常打开 PDF | **PASS** | 原生窗口标题="PaperAI — IEEE 双栏 论文 副本.pdf" |
| U3.1 | 测试凭据已清理（不污染用户凭据管理器） | **PASS** | deleted=True  target=PaperAI/AIProvider/paperai-upgrade-test |
| U3.2 | 用户原有设置已还原 | **PASS** | 已写回 252 字节；文件中不含测试数据=true |
