# PaperAI — Architecture Proof of Concept

> **Tauri 2 + PDF.js技术验证**
> 目标：证明`Read · Annotate · Ask` 中的 `Read` 与 `Annotate` 能否基于Tauri 2 + PDF.js 实现。
> **本项目不是产品 V0.1**，不做UI、不做AI、不做文献管理。

---

##验证结论

| 判据（第 20 节） | 结果 |
|---|---|
| ① IEEE 双栏PDF 文本选择可靠 | ✅ **PASS** |
| ② Highlight + Ink 保存为真正的 PDF Annotation | ✅ **PASS** |
| ③ 保存后的 PDF 被常见阅读器识别 | ✅ **PASS** |
| ④ Windows 文件关联 + Single Instance | ⏸️ **待验证**（本机缺 Rust 工具链）|

**15/ 15 项PDF 核心测试 PASS。**
建议 **LOCK ARCHITECTURE = Tauri 2 + PDF.js**，条件见 `TECHNICAL_VALIDATION.md` 第 6 节。

---

## 快速开始

```bash
cd D:\AIreader\PaperAI-PoC

npm install                # 安装依赖（pdfjs-dist 6.4.299等）
npm run dev                # 启动 http://localhost:5180
```

在浏览器打开 `http://localhost:5180`，点击 **Open** 选择测试 PDF。

### 完整回归测试

```bash
node tests\final-verify.mjs            # 15 项自动化验证
node tests\compat-check.mjs            # 独立实例回读验证

# 字节级检查生成的 PDF（需要 Python）
python tools\inspect_pdf.py output\example_annotated.pdf
```

---

## 功能

严格按 PoC 范围实现，未做任何扩展：

```
Open | Select | Highlight | Draw | Undo | Zoom - | Zoom + | Fit Width | Fit Page | Page | Save
```

- ✅ 打开本地 PDF（连续滚动、缩放、Fit、页码、文本选择）
- ✅ Highlight（选中文字 → 真正的 PDF Highlight 注释）
- ✅ Draw / Ink（自由手绘 → 真正的 PDF Ink 注释）
- ✅ Undo
- ✅ Save（`saveDocument()` 写回 PDF Annotation）

---

## 项目结构

```
PaperAI-PoC/
├── src/
│   ├── main.ts                    # PDF.js 集成核心（约 460 行，含大量关键注释）
│   └── style.css                  # 只导入官方 pdf_viewer.css，不覆盖 viewer 规则
├── index.html                     # 极简 UI
├── tests/
│   ├── final-verify.mjs           # 15 项自动化验证
│   └── compat-check.mjs           # 跨实现回读验证
├── tools/
│   └── inspect_pdf.py             # PDF 字节级 Annotation 检查（独立于 PDF.js）
├── probe/                         # 诊断脚本（保留，含 API 探测过程）
├── test-pdfs/                     # 测试样本（取自真实 IEEE 文献库）
├── output/
│   └── example_annotated.pdf      # 产物：含 Highlight + Ink 真实注释
├── test-artifacts/                # 截图与 JSON 证据
├── TECHNICAL_VALIDATION.md        # 技术报告（含 Q1–Q7 回答）
├── TEST_RESULTS.md                # PASS/PARTIAL/FAIL 判定表
└── KNOWN_ISSUES.md                # 已知问题与开发约束
```

---

## 测试样本

全部取自用户真实文献库（`D:\IEEE期刊\文献`），**路径天然含中文**，
因此 Unicode 路径测试是默认场景。

| 文件 | 内容 |
|---|---|
| `PDF-A.pdf` | GaN-HEMT 结温提取综述（6.70 MB，单栏） |
| `PDF-B.pdf` | Compact Model Parameter Extraction using Bayesian ML（0.47 MB，**IEEE 双栏**）|
| `PDF-C.pdf` | Benchmarking Optimization for BSIM-CMG（1.13 MB，含公式/上下标/希腊字母）|
| `IEEE期刊 空格测试\参数提取方法 test.pdf` | 中文 + 空格路径专项测试 |

---

## 核心技术要点（实测得出）

### 1. `globalThis.pdfjsLib` 必须先赋值

```js
import * as pdfjsLib from "pdfjs-dist";
globalThis.pdfjsLib = pdfjsLib;                      // ← 必须在前
const { EventBus, PDFViewer } = await import("pdfjs-dist/web/pdf_viewer.mjs");
```

否则抛 `Cannot destructure property 'AbortException' of 'globalThis.pdfjsLib'`。

### 2. AnnotationEditorUIManager 只能通过事件获取

它**未从 `pdfjs-dist` 导出**，构造函数需 15 个私有参数：

```js
eventBus.on("annotationeditoruimanager", ({ uiManager }) => { /* ... */ });
```

### 3. Ink 必须显式 commit

`InkEditor.supportMultipleDrawings === true` → 鼠标抬起**不**创建注释：

```js
layer.endDrawingSession();   // 必须调用，否则 saveDocument() 丢笔迹
```

### 4. Highlight 顺序不可颠倒

先在 Select 模式选文本 → 再点 Highlight：

```js
await uiManager.updateMode(AnnotationEditorType.HIGHLIGHT, null, true);
uiManager.highlightSelection();
```

### 5. 禁止覆盖 viewer CSS

PDF.js 用 class 切换驱动 pointer-events。覆盖会导致 Ink **静默失效**（不报错）。

### 6. zoom 枚举在 v6 已更名

`"width"` → `"page-width"`，`"page"` → `"page-fit"`。

---

## 产物验证

`output/example_annotated.pdf` 的字节级证据：

```
/Type /Annot /Subtype /Ink
/Rect [109.75 453.36 250.25 620.65]
/InkList [[112.5 604.5 116.25 601.16 ...]]
/AP << /N ... >>
```

`/Subtype /Highlight` + `quadPoints` 同样存在。
**符合 PDF 32000-1 标准，非 PDF.js 私有格式。**

---

## 待完成

Rust 工具链就绪后需补测（详见 `KNOWN_ISSUES.md`）：

- [ ] 安装 Rust + MSVC（**装到 D 盘**，C 盘仅剩 11 GB）
- [ ] Test 5：NSIS 安装包 + `.pdf` 打开方式
- [ ] Test 7：命令行打开 PDF（中文/空格路径）
- [ ] Test 8：Single Instance 转发与窗口聚焦
- [ ] 在真实 Tauri WebView2 窗口内重跑 Ink/Highlight

---

## 版本基线

| 组件 | 版本 |
|---|---|
| **PDF.js** | **6.4.299** |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| TypeScript | 5.9.3 |
| Vite | 7.3.7 |
| WebView2 Runtime | 155.0.4283.45 |
| Windows | 11 家庭中文版 10.0.26300.9657 |
| Rust | 未安装 |

> `pdfjs-dist` 必须精确锁定版本 —— Annotation Editor 属内部 API，
> 升级会破坏。详见 `KNOWN_ISSUES.md` P1-4。