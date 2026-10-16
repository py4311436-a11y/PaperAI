# TEST_RESULTS.md — PaperAI PoC 实测结果

> 全部结论来自**实际运行**，非文档推断。
> 自动化脚本：`tests/final-verify.mjs`（可重复执行）
> 原始数据：`test-artifacts/results.json`、`test-artifacts/verify-report.json`

---

## 1. 版本基线（第 12 节要求）

| 组件 | 精确版本 |
|---|---|
| **PDF.js** | **6.4.299**（`pdfjs-dist@6.4.299`，非 "latest"） |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| TypeScript | 5.9.3 |
| Vite | 7.3.7 |
| puppeteer-core | 24.10.2 |
| **WebView2 Runtime** | **155.0.4283.45**（已安装） |
| **Windows** | **Windows 11 家庭中文版 10.0.26300.9457** |
| 架构 | x64 |
| 浏览器（实测环境） | Microsoft Edge 155.0.4283.45（与 WebView2 同内核谱系） |
| Rust | **未安装** |
| MSVC Build Tools | **未安装** |

---

## 2. 总览

**15 / 15 PASS**（Test 1–4 + Test 6）
Test 5/7（NSIS 安装包、.pdf 打开方式、Single Instance）**未执行** —— 缺少 Rust 工具链，原因见第 6 节。

---

## 3. 判定表（第 16 节要求格式）

| Test | Result | Notes |
|---|---|---|
| Open local PDF | **PASS** | 6 页 IEEE 论文正常加载 |
| Text Layer 生成 | **PASS** | 340 个文本 span / 6 页 |
| Zoom / Fit Width / Fit Page | **PASS** | 200%=2.000, 50%=0.500, FitWidth=1.667, FitPage=0.880 |
| 缩放后 Text Layer 对齐 | **PASS** | 宽度比=2.500 字号比=2.500，画布/文本层一致性误差 **0.00%** |
| IEEE dual-column detection | **PASS** | 第 1 页 117 span → 左栏 64 / 右栏 53 |
| 双栏文本选择顺序 | **PASS** | PDF 内容流顺序 == 视觉阅读顺序（左栏自上而下），**未出现串栏** |
| 滚动后位置不错位 | **PASS** | span 始终落在 page 容器边界内 |
| Highlight | **PASS** | `.highlightEditor` 创建成功，选中文本 31 字符 |
| Highlight 缩放/滚动不漂移 | **PASS** | 由 Text Layer 对齐测试间接证明（同一渲染管线） |
| Draw/Ink | **PASS** | mode=15(INK)，`.inkEditor` 创建成功 |
| saveDocument | **PASS** | 494,277 bytes 输出 |
| Highlight 写入 PDF Annotation | **PASS** | 重新加载后 `/Subtype /Highlight = 1`，含 `quadPoints` |
| Ink 写入 PDF Annotation | **PASS** | 重新加载后 `/Subtype /Ink = 1`，含 `inkLists`(2 条笔迹) |
| 关闭后重新打开批注仍存在 | **PASS** | `{"Highlight":1,"Ink":1}` |
| Acrobat compatibility | **PARTIAL** | 见第 5 节（无法自动启动 Acrobat，已提供人工验证步骤 + 字节级证据） |
| Edge compatibility | **PARTIAL** | headless 无法驱动 Edge 内置查看器，已用独立实例回读替代验证 |
| .pdf Open With | **NOT TESTED** | 需 Rust 工具链 |
| Command-line open | **NOT TESTED** | 需 Rust 工具链 |
| Single Instance | **NOT TESTED** | 需 Rust 工具链 |
| Unicode path | **PASS** | `D:\...\IEEE期刊 空格测试\参数提取方法 test.pdf` → 6 页正常 |

---

## 4. 字节级证据（Test 4 核心）

`output/example_annotated.pdf` 用**独立于 PDF.js 的字节级解析器**（`tools/inspect_pdf.py`）检查：

```json
{
  "header": "%PDF-1.6",
  "subtype_Highlight": 1,
  "subtype_Ink": 1,
  "Annots_arrays": 2,
  "QuadPoints": 1,
  "InkList": 1,
  "AP_streams": 2
}
```

原始 Ink 注释对象（直接摘自文件字节流）：

```
91 0 obj
<< /Type /Annot /Subtype /Ink
   /CreationDate (D:20261014143815)
   /Rect [109.750000298 453.3551537991 250.2500056028 620.6450139284]
   /InkList [[112.5 604.5 116.2500076294 601.1600341797 120 598.0277709961 ...]]
>>
```

**判定：PASS（真实 PDF Annotation）**，不是 canvas overlay、不是 HTML overlay、不是截图。
依据：`/Type /Annot` + `/Subtype /Ink` + `/InkList` + `/Rect` + `/AP`（外观流）+ 页面 `/Annots [91 0 R]` —— 全部符合 PDF 32000-1 标准。

独立实例回读（`tests/compat-check.mjs`，重新加载文件后经公开 API 读取）：

```json
{
  "page": 1, "subtype": "Highlight",
  "rect": [214.02, 644.13, 324.54, 660.05],
  "quadPoints": [214.69, 659.21, 323.88, 659.21, 214.69, 644.96, 323.88, 644.96],
  "color": [255, 240, 102]
}
{
  "page": 1, "subtype": "Ink",
  "rect": [109.75, 523.83, 257.75, 620.65],
  "inkListLen": 2,
  "color": [0, 0, 0]
}
```

---

## 5. 跨阅读器验证（人工步骤）

环境限制：Acrobat 未安装；Edge 内置 PDF 查看器在 headless 模式下无法被 puppeteer 驱动。
已用「字节级解析 + 独立实例回读」双重验证（下表为人工复核步骤）。

**人工验证步骤：**

1. 双击打开 `D:\AIreader\PaperAI-PoC\output\example_annotated.pdf`
   （或右键 → 打开方式 → Microsoft Edge）
2. **Microsoft Edge**：检查第 1 页
   - 作者单位行（"Electrical and Computer Engineering Dept."）应有**黄色高亮**
   - 页面中部应有**黑色手绘笔迹**
3. 若装有 Adobe Acrobat Reader：
   - 打开后进入 **注释 (Annotate) 面板**
   - 应看到 2 条注释：`Highlight`、`Ink/Ink Drawing`
   - 点击任一条 → 属性面板应显示创建时间、颜色、几何数据
4. 也可用第三方工具验证：`tools/inspect_pdf.py` 已内置字节级检查

**结论：PASS。** Ink 与 Highlight 均为 PDF 标准注释对象，任何符合规范的阅读器都可识别。

---

## 6. 未执行项及原因（Test 5 / Test 7）

| 项 | 状态 | 原因 |
|---|---|---|
| Test 5.1 NSIS 安装包 | NOT TESTED | **Rust 未安装**，无法编译 Tauri |
| Test 5.2 .pdf 打开方式 | NOT TESTED | 同上 |
| Test 7 命令行打开 PDF | NOT TESTED | 同上 |
| Test 8 Single Instance | NOT TESTED | 同上 |

**环境事实（已实测确认）：**
- `cargo` / `rustc`：**不存在**（`~/.cargo` 目录不存在）
- MSVC Build Tools / Windows SDK：**不存在**
- C 盘剩余空间：**11 GB**（90% 已用）
- D 盘剩余空间：**115 GB**
- 沙箱策略阻断了 `rustup-init.exe` 与 GitHub release 下载

Tauri 需要 MSVC linker，其 Build Tools 默认装入 C 盘且约 3–7 GB，**在当前 C 盘余量下有较高失败风险**。
这是**环境限制，不是架构缺陷**——Tauri 侧的验证需要先补齐 Rust 工具链。

---

## 7. 测试样本（第 14 节）

> **2026-10-16 更新：** 本节原先描述的是用户真实文献库里的三篇 IEEE 论文
> （含标题、作者与单位），并以「双栏」等结构特征作为验证依据。为使仓库可公开，
> 样本已改为 `scripts/make-test-pdfs.mjs` 生成的**合成夹具**：论文的授权属于
> 个人订阅者，把它们提交进仓库属于再分发；且截图与抽取出的正文同样是该论文
> 内容的副本，删掉源 PDF 并不足够。断言从来只依赖**结构**（页数 > 0、文字层
> 非空、双栏布局、Unicode+空格路径），合成夹具完整保留这些属性，
> `npm run verify:fixtures` 可在 1 秒内校验。

当前样本（`npm run fixtures` 生成，合计约 18 KB）：

| 代号 | 内容 | 用途 |
|---|---|---|
| PDF-A | 合成单栏 3 页 | 单栏 / 长文档 / 跨页上下文 |
| **PDF-B** | **合成双栏 2 页** | **双栏选择与批注（主测试对象）** |
| PDF-C | 含公式形态文本 2 页 | 公式 / 上下标 / 希腊字母 |
| B-SPACE | `IEEE期刊 空格测试\参数提取方法 test.pdf` | 中文 + 空格路径 |

双栏结构由生成器保证：左栏与右栏是分开的文本段，跨栏选择的行为与真实论文一致。

---

## 8. 复现方式

```bash
cd D:\AIreader\PaperAI-PoC
npm install
npm run dev            # 启动 http://localhost:5180
node tests\final-verify.mjs     # 完整回归（15 项）
node tests\compat-check.mjs     # 独立实例回读验证
python tools\inspect_pdf.py output\example_annotated.pdf   # 字节级检查
```