# Stage D — save safety results

Generated: 2026-10-15T05:25:53.877Z

| ID | Check | Result | Notes |
|---|---|---|---|
| D3.0 | 打开测试副本 | **PASS** | 页数=6, 初始 SHA-256=e90453ad00866449… |
| D3.1 | 故障注入需显式开启（默认关闭） | **PASS** | 本次运行设置了 PAPERAI_ALLOW_FAULT_INJECTION=1；未设置时请求会被 save_injection_disabled 拒绝（代码门控，见 save_service.rs::save_pdf_inner） |
| D3.2 | 正常保存：写入 + 备份 + 往返字节稳定 | **PASS** | code=saved bytes=490608 sha=e90453ad00866449… 备份存在=true 未修改文档往返 SHA 不变=true |
| D3.3 | 同一文件连续保存 3 次 | **PASS** | 三次均成功=true 字节序列=490608,490608,490608 保存后页数=6 备份覆盖=true |
| D3.4 | 反复保存后原文件仍是可解析 PDF | **PASS** | 重开校验页数=6 |
| D3.5 | 注入 target_readonly | **PASS** | 返回 code=save_injected_fault; 原件 SHA 变化=false; 残留临时文件=0 个 [] |
| D3.6 | 注入 temp_write（临时文件写入失败） | **PASS** | 返回 code=save_injected_fault; 原件 SHA 变化=false; 残留临时文件=0 个 [] |
| D3.7 | 注入 replace（替换阶段失败） | **PASS** | 返回 code=save_injected_fault; 原件 SHA 变化=false; 残留临时文件=0 个 [] |
| D3.8 | 目标文件为只读时保存失败且原件不变 | **PASS** | 只读属性已设置; 返回 code=save_target_readonly; 原件 SHA 变化=false |
| D3.9 | Save As 写入新路径且来源文件不变 | **PASS** | 目标=D:\AIreader\PaperAI-PoC\test-fixtures\save\save-as-target.pdf 字节=490608; 来源 SHA 变化=false |
| D3.10 | 真实 Save 按钮在失败时保留 dirty 且不损坏原件 | **PASS** | dirty 前=true 后=true; 原件 SHA 变化=false; 提示="保存失败 [save_target_readonly] 目标文件只读或被占用: D:\AIreader\PaperAI-PoC\test-fixtures\save\target." (attrib rc=0) |
| D3.11 | 拒绝非 PDF 数据且不改目标文件 | **PASS** | 返回 code=save_temp_invalid; 目标 SHA 变化=false |
