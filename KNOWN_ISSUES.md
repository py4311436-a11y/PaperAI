# KNOWN_ISSUES.md — PaperAI PoC 已知问题

> 按严重程度排序。每条都标注了**是否阻塞正式开发**。
> 所有问题均为实测发现，非推测。

---

##🔴 P0 — 阻塞正式开发

### P0-1 · Rust 工具链缺失，Tauri 侧无法构建

**现象**
- `cargo` / `rustc` 不存在，`~/.cargo` 目录不存在
- MSVC Build Tools / Windows SDK 均未安装
- 沙箱策略阻断 `rustup-init.exe` 与 GitHub release 下载

**影响**：Test 5（NSIS 安装包 / .pdf 打开方式）、Test 7（命令行传参）、
Test 8（Single Instance）**无法执行**。

**额外风险**：C 盘仅剩 **11 GB**（90% 已用），MSVC Build Tools 默认装入 C 盘且需 3–7 GB。

**解决方案**
1. 将`CARGO_HOME` / `RUSTUP_HOME` 指向 D 盘（如 `D:\.cargo`、`D:\.rustup`）
2. 安装 Visual Studio Build Tools 时指定 D 盘安装路径
3. 安装完成后重新运行 Test 5/7/8

**是否阻塞架构决策**：❌ 否。前三项判据已实测通过，Tauri 侧是独立工作项。

---

### P0-2 · Single Instance 与文件关联传参未验证（Risk F）

**现象**：完全未测试（依赖 P0-1）。

**为什么这是最高风险**：这是四项判据中唯一未验证的一项。
指令第 20 节明确指出：任意一项出现根本性限制则不应 LOCK。

**待验证的具体场景**
- `PaperAI.exe "D:\IEEE期刊\参考文献\参数提取方法.pdf"`（中文路径）
- 路径含空格
- 二次启动时已有窗口如何获得焦点（`set_focus()` 在 Windows 上偶发失效）
- 文件关联传入的 argv 编码是否正确

**优先级**：Rust 环境就绪后的**第一优先项**。

---

##🟠 P1 — 影响功能正确性

### P1-1 · Ink 不显式commit 就会丢失（Risk H）

**现象**
```
鼠标画完抬起 → .inkEditor 数量 = 0
saveDocument() 输出文件里没有 /Subtype /Ink
```

**根因**（pdf.mjs 源码）：
```js
static _endDraw(event) {
  ...
  if (this.supportMultipleDrawings) {   // InkEditor === true
    return;                              // 只记 undo，不创建注释
  }
  this.endDrawing(false);
}
```

**解决方案**
```js
layer.endDrawingSession();   // 或 layer.commitOrRemove()
```
必须在以下时机调用：
- 切换到其他工具时
- 点击「保存」前
- 打开新PDF 前
- 关闭窗口前（配合 beforeunload）

**UX 建议**：提供显式「完成」按钮，或在状态栏提示"未完成的笔迹"。

---

### P1-2 · 覆盖 viewer CSS 会导致 Ink 静默失效（Risk G）

**现象**：一旦自定义 `.pdfViewer` / `.annotationEditorLayer` 的 `pointer-events`，
Ink 绘制**不报错、不显示、完全无提示**。

**根因**：`DrawingEditor._getDrawingTarget(_parent, { target }) { return target; }`
—— 直接返回 `event.target`。若子元素（textLayer span）捕获了事件，
target 就不是 layer 本身，`startDrawing` 随即失败。

PDF.js 通过 CSS class 驱动 pointer-events：

| class | 效果 |
|---|---|
| `.disabled` | `pointer-events: none` |
| `.highlighting`（在 textLayer 上） | 启用文本选择 |
| `.inkEditing` / `.freetextEditing` 等 | 激活对应工具 |
| `.drawing` | 绘制中|

**解决方案**
- ✅ 只`@import "pdfjs-dist/web/pdf_viewer.css"`，不重写其中任何规则
- ✅ 自定义样式只加**独立前缀**（如 `#toolbar`、`.status-bar`）
- ❌ 禁止重写 `.pdfViewer`、`.textLayer`、`.annotationEditorLayer` 下的任何选择器

---

### P1-3 · `updateMode` 未传 `isFromUser=true` 会污染模块状态（Risk I）

**现象**：某次笔画之后，**后续所有笔画静默失效**，且跨会话不复现，极难定位。

**根因**（pdf.mjs）：
```js
class CurrentPointers {
  static #pointerType = null;
  static setPointer(pointerType, pointerId) {
    CurrentPointers.#pointerId ||= pointerId;
    CurrentPointers.#pointerType ??= pointerType;    // 只设置一次！
  }
}
// startDrawing 第一行：
if (CurrentPointers.isInitializedAndDifferentPointerType(pointerType)) return;
```

`updateMode()` 内部只有在 `isFromUser === true` 时才调用 `clearPointerType()`。

**解决方案**：**所有** `updateMode` 调用一律传第三个参数 `true`：
```js
await uiManager.updateMode(mode, null, true);
```

---

### P1-4 · Annotation Editor 属内部 API，升级会破坏（Risk A）

**现象**（6.4.299 实测）：

| 类 | 是否导出 |
|---|---|
| `AnnotationEditorUIManager` | ✅ |
| `AnnotationEditorLayer` | ✅ |
| `AnnotationEditorType` / `AnnotationEditorParamsType` | ✅ |
| `InkEditor` / `HighlightEditor` / `FreeTextEditor` | ❌ |
| `AnnotationStorage` | ❌（但 `pdfDocument.annotationStorage` 可访问）|

`AnnotationEditorUIManager` 构造函数需 **15 个参数**，且只能通过
`eventBus.on("annotationeditoruimanager")` 获取实例。

**已踩到的具体破坏点**

| 变更 | 表现 |
|---|---|
| `linkService.setDestinationHash()` | v6 已移除，调用即抛|
| `currentScaleValue = "width"` | v6 改为 `"page-width"`，旧值抛 unknown zoom |
| `currentScaleValue = "page"` | v6 改为 `"page-fit"` |
| `addEditor(type, params)` | v6 签名是 `addEditor(editor)`，误用抛 `editor.enable is not a function` |
| PDFViewer `container`/`viewer` 语义 | 传反抛 `must be absolutely positioned` |

**解决方案**
- `package.json` 锁定 `pdfjs-dist` 精确版本，**禁用 `^` / `latest`**
- 每次升级必须跑 `node tests/final-verify.mjs`（15 项回归）
- 关注上游 release notes的 Annotation Editor 变更

---

## 🟡 P2 — 体验与工程问题

### P2-1 · WebView2 下的鼠标/Canvas 行为未直接实测（Risk E）

**现状**：全部测试在 headless Edge（Chromium 内核）完成，**WebView2 未直接验证**。

**已知风险点**（PDF.js 在 WebView2 上历来需要关注）：
- `Ctrl+C` 复制
- 文本选区拖拽
- Canvas 混合模式（Highlight/Ink 使用 `mix-blend-mode`）
- 高 DPI 缩放

**解决方案**：Rust 环境就绪后，在真实 Tauri 窗口内重跑 Ink + Highlight。

### P2-2 · `pdfjs-dist` 不含官方完整 viewer 应用

**现象**：npm 包只有 `pdf_viewer.mjs`（组件库），**没有 `viewer.html`**。

```
node_modules/pdfjs-dist/web/
├── pdf_viewer.css
├── pdf_viewer.mjs        ← 组件库
└── images/
```

**影响**：无法通过 `iframe → viewer.html` 走捷径，必须自己搭 UI + 调组件。
这其实符合 PaperAI 的需求（极简 UI），但意味着要自己处理工具栏、状态栏等。

**解决方案**：如需完整 viewer 作对照，需从 GitHub Releases 下载 `pdfjs-X-dist.zip`
（本环境沙箱阻断，未能获取）。

### P2-3 · Annotation 计数无公开 API

**现象**：`pdfDocument.annotationStorage` 的内部 `#storage` 是私有 `Map`，
无公开的 `size` / `keys()`。

**当前变通**：统计 DOM 中的 `.highlightEditor` / `.inkEditor` / `.freeTextEditor` 等元素。

**影响**：低。正式版可在Rust 侧解析保存后的 PDF 来获得权威计数。

### P2-4 · 无跨页Annotation 显示开关

PDF.js 有 `HIGHLIGHT_SHOW_ALL`（`AnnotationEditorParamsType` = 34），
本次未验证。正式版若需"显示全部高亮"功能需补充测试。

---

## 🟢 已排除的风险

| Risk | 结论 | 证据 |
|---|---|---|
| **B** `saveDocument()` 不完整 | ✅ 已排除 | Highlight + Ink 均正确写入 |
| **C** 只有 PDF.js 能读 | ✅ 已排除 | 标准 `/Type /Annot` + `quadPoints` + `InkList` + `AP` |
| **D** 双栏选择顺序错误 | ✅ 已排除 | 117 span，左右栏 64/53，顺序与视觉阅读一致 |

---

## 📋 开发约束速查（建议写入团队规范）

```
1. 禁止覆盖 .pdfViewer / .textLayer / .annotationEditorLayer 的 CSS 规则
2. updateMode() 一律传 isFromUser = true
3. 切换工具 / 保存 / 打开新文件前，必须 commitPendingInk()
4. pdfjs-dist 版本精确锁定，升级必跑 tests/final-verify.mjs
5. globalThis.pdfjsLib 必须在 import pdf_viewer.mjs 之前赋值
6. zoom 枚举用 "page-width" / "page-fit"，不用 "width" / "page"
7. 高亮流程：先在 Select 模式选文本，再点 Highlight（不可颠倒）
```