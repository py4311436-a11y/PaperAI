/**
 * Safety tests for the markdown renderer (AI-19).
 *
 * The renderer's protection is structural: it never builds an HTML string, it
 * only ever calls `createElement` and `textContent`. These tests observe that
 * directly — the DOM shim records every element ever created, so "no <script>
 * element was constructed" is a hard assertion rather than an inspection of
 * output text.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { installDom } from "./dom-shim.mjs";
import { renderMarkdown, renderedText } from "../../dist-test/src/ai/markdown-renderer.js";

const dom = installDom();

function render(src) {
  dom.doc.created.length = 0;
  const container = dom.doc.createElement("div");
  renderMarkdown(container, src, { math: false });
  return { container, created: [...dom.doc.created] };
}

/** Elements that must never be created from model output. */
const FORBIDDEN = [
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "style",
  "form",
  "input",
  "button",
  "svg",
  "math",
  "img",
  "video",
  "audio",
  "source",
];

test("a <script> tag in the answer is rendered as literal text, never an element", () => {
  const { container, created } = render('<script>window.__pwned=1</script>');
  assert.ok(!created.includes("script"), `created: ${created.join(",")}`);
  assert.ok(container.textContent.includes("<script>"), "it should still be visible as text");
  assert.ok(container.textContent.includes("window.__pwned=1"));
});

test("an <img> with a remote src never creates an image element", () => {
  const { container, created } = render('![x](https://tracker.example.com/pixel.png)');
  assert.ok(!created.includes("img"), `created: ${created.join(",")}`);
  // Rendered as an explicit, inert placeholder — not as a clickable link, and
  // nothing is ever fetched.
  assert.equal(container.querySelectorAll(".md-link").length, 0, "must not become a link");
  assert.ok(container.textContent.includes("图片未加载"), container.textContent);
  assert.ok(container.textContent.includes("tracker.example.com"), container.textContent);
});

test("raw <img ...> html is inert", () => {
  const { container, created } = render('<img src="https://tracker.example.com/p.png">');
  assert.ok(!created.includes("img"), `created: ${created.join(",")}`);
  assert.ok(container.textContent.includes("tracker.example.com"));
});

test("an <iframe> is inert", () => {
  const { created, container } = render('<iframe src="https://evil.example.com"></iframe>');
  assert.ok(!created.includes("iframe"), `created: ${created.join(",")}`);
  assert.ok(container.textContent.includes("<iframe"));
});

test("javascript: links are rendered as blocked text, not links", () => {
  const { container } = render("[点我](javascript:alert(1))");
  const links = container.querySelectorAll(".md-link");
  assert.equal(links.length, 0, "no clickable link may be produced");
  assert.ok(container.textContent.includes("链接已禁用"), container.textContent);
  assert.ok(container.textContent.includes("点我"));
  assert.ok(container.textContent.includes("javascript:"), container.textContent);
});

test("balanced parentheses inside a URL are preserved", () => {
  const { container } = render("[维基](https://en.wikipedia.org/wiki/Foo_(bar))");
  const a = container.querySelector(".md-link");
  assert.ok(a, "a legitimate link should render");
  assert.equal(a.dataset.url, "https://en.wikipedia.org/wiki/Foo_(bar)");
});

test("data: links are blocked too", () => {
  const { container } = render("[x](data:text/html,<script>alert(1)</script>)");
  assert.equal(container.querySelectorAll(".md-link").length, 0);
  assert.ok(container.textContent.includes("链接已禁用"));
});

test("a legitimate https link becomes an inert anchor with no href", () => {
  const { container } = render("[论文](https://example.com/paper.pdf)");
  const a = container.querySelector(".md-link");
  assert.ok(a, "the link should be rendered");
  // The whole point: no href attribute, so rendering cannot navigate.
  assert.equal(a.getAttribute("href"), null, "anchor must not carry href");
  assert.equal(a.dataset.url, "https://example.com/paper.pdf");
  assert.equal(a.childNodes[0].textContent, "论文");
});

test("no forbidden element is created for any hostile input", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<SCRIPT SRC=//evil.example.com/x.js></SCRIPT>",
    '<img src=x onerror=alert(1)>',
    "<iframe src=javascript:alert(1)></iframe>",
    '<svg onload=alert(1)></svg>',
    "<style>body{background:url(//evil)}</style>",
    '<object data="//evil"></object>',
    "<embed src=//evil>",
    '<form action="//evil"><input name=x></form>',
    "<math><mtext><script>alert(1)</script></mtext></math>",
    "__import__('os')",
  ];
  for (const p of payloads) {
    const { created } = render(p);
    for (const bad of FORBIDDEN) {
      assert.ok(!created.includes(bad), `payload ${JSON.stringify(p)} created <${bad}>`);
    }
  }
});

test("on* attributes are never set, because no raw HTML is parsed", () => {
  const { container } = render('<a href="#" onclick="alert(1)">x</a>');
  const all = [container, ...container.allElements()];
  for (const el of all) {
    for (const attr of Object.keys(el.attributes)) {
      assert.ok(!/^on/i.test(attr), `found event attribute ${attr}`);
    }
  }
});

// ------------------------------------------------------------- normal output

test("headings, lists, bold, italics and code render as elements", () => {
  const { container } = render(
    ["## 标题", "", "- 项目一", "- 项目二", "", "1. 第一", "2. 第二", "", "**粗** 和 *斜* 和 `code`", "", "> 引用"].join("\n")
  );
  assert.ok(container.querySelectorAll("h4").length >= 1, "## should map to h4");
  assert.equal(container.querySelectorAll("ul").length, 1);
  assert.equal(container.querySelectorAll("ol").length, 1);
  assert.equal(container.querySelectorAll("strong").length, 1);
  assert.equal(container.querySelectorAll("em").length, 1);
  assert.equal(container.querySelectorAll(".md-code-inline").length, 1);
  assert.equal(container.querySelectorAll("blockquote").length, 1);
});

test("a fenced code block becomes a <pre> with inert text", () => {
  const { container } = render("```js\nconst a = 1;\n<script>x</script>\n```");
  const pre = container.querySelector(".md-code-block");
  assert.ok(pre);
  assert.equal(pre.dataset.lang, "js");
  // Inside a code block the tag is text, and no script element is created.
  assert.ok(pre.textContent.includes("<script>x</script>"));
  assert.equal(dom.doc.created.includes("script"), false);
});

test("an unterminated code fence does not eat the renderer", () => {
  const { container } = render("```\nhello\nworld");
  assert.ok(container.textContent.includes("hello"));
  assert.ok(container.textContent.includes("world"));
});

test("a horizontal rule renders", () => {
  const { container } = render("---");
  assert.equal(container.querySelectorAll("hr").length, 1);
});

test("text before and after a list stays in paragraphs", () => {
  const { container } = render("前段\n\n- 一\n\n后段");
  const ps = container.querySelectorAll("p");
  assert.ok(ps.length >= 2, `got ${ps.length} paragraphs`);
  assert.ok(renderedText(container).includes("前段"));
  assert.ok(renderedText(container).includes("后段"));
});

test("inline math falls back to literal text when KaTeX is disabled", () => {
  const { container } = render("公式 $E = mc^2$ 结束");
  assert.ok(container.textContent.includes("$E = mc^2$"));
  assert.ok(container.textContent.includes("公式"));
  assert.ok(container.textContent.includes("结束"));
});

test("block math falls back to literal text when KaTeX is disabled", () => {
  const { container } = render("$$\n\\int_0^1 x dx\n$$");
  assert.ok(container.textContent.includes("\\int_0^1 x dx"));
});

/* ------------------------------------------------------------- A-17: \[ \] */

/*
 * The reported bug: models trained on LaTeX emit `\[ ... \]` for display math,
 * and this renderer only knew `$$ ... $$` and `\( ... \)`. So the transcript
 * showed the raw `\[` / `\]` markers and raw commands such as `\varepsilon`,
 * which is what the screenshot showed.
 *
 * These run with KaTeX DISABLED on purpose: with math off the renderer must
 * still recognise the delimiters and reproduce the formula *without* them, and
 * that is observable. The "was it typeset" question is answered separately in
 * the real-browser suite.
 */
test("inline \\[...\\] is consumed, not shown as raw markers", () => {
  const { container } = render("收敛判据 \\[|T_j^{(k+1)} - T_j^{(k)}| < \\varepsilon\\] 收敛");
  const text = container.textContent;
  assert.ok(!text.includes("\\["), `raw opening marker leaked: ${text}`);
  assert.ok(!text.includes("\\]"), `raw closing marker leaked: ${text}`);
  assert.ok(text.includes("T_j^{(k+1)}"), `the formula itself was lost: ${text}`);
  assert.ok(text.includes("收敛判据") && text.includes("收敛"), "surrounding prose must survive");
});

test("block \\[...\\] on its own line becomes a math block", () => {
  const { container } = render("\\[\n\\varepsilon = \\frac{R}{2L}\n\\]");
  assert.equal(container.querySelectorAll(".md-math-block").length, 1, "not treated as a math block");
  assert.ok(!container.textContent.includes("\\["), "raw marker leaked");
  // The block is not merged into a paragraph.
  assert.equal(container.querySelectorAll("p").length, 0, "display math must not be a paragraph");
});

/*
 * These run with KaTeX DISABLED, which means `renderMath` takes its documented
 * fallback path: it prints the formula SOURCE, wrapped in `$$...$$`. So the
 * assertions are about delimiters and structure, never about the LaTeX commands
 * themselves — `\sqrt` surviving is correct when math is off.
 *
 * What is observable, and what the old code got wrong:
 *   - `\[` / `\]` / `\(` / `\)` markers must never reach the reader;
 *   - a `$$...$$` pair must produce ONE display-math span and leave no stray
 *     dollar-sign text behind (the old code emitted the inner `$...$` inline
 *     plus two orphan "$" characters).
 *
 * Whether a formula is actually *typeset* is answered in the real-browser
 * suite, which runs with math enabled.
 */
const textNodes = (root) =>
  root
    .allElements()
    // Text *inside* a math element is the documented math-off fallback
    // (`$$…$$` around the source) and is supposed to contain dollars. Only text
    // that escaped the math element counts as stray.
    .filter((el) => !el.classList.contains("md-math-inline") && !el.classList.contains("md-math-block"))
    .flatMap((el) => el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent);

test("single-line \\[...\\] becomes a math block too", () => {
  const { container } = render("\\[ F(Y) = \\sqrt{\\sum_i (I_i - I_{meas,i})^2} \\]");
  assert.equal(container.querySelectorAll(".md-math-block").length, 1, "not treated as a math block");
  const text = container.textContent;
  assert.ok(!text.includes("\\["), `raw opening marker leaked: ${text}`);
  assert.ok(!text.includes("\\]"), `raw closing marker leaked: ${text}`);
  // The fallback preserves the source; losing it would be worse than showing it.
  assert.ok(text.includes("\\sqrt"), `the formula source was lost: ${text}`);
});

test("inline $$...$$ leaves no stray dollar-sign text", () => {
  const { container } = render("目标函数 $$F(Y) = \\sum_i e_i^2$$ 结束");
  const stray = textNodes(container).filter((t) => t.includes("$"));
  assert.deepEqual(
    stray,
    [],
    `stray "$" outside the math element — the $$ pair was parsed as one inline $..$: ${JSON.stringify(stray)}`
  );
  const text = container.textContent;
  assert.ok(text.includes("F(Y) = \\sum_i e_i^2"), `formula lost: ${text}`);
  assert.ok(text.includes("目标函数") && text.includes("结束"), "prose must survive");
});

test("inline $$...$$ is marked as display math, not inline math", () => {
  const { container } = render("a $$x^2$$ b");
  const spans = container.querySelectorAll(".md-math-inline");
  assert.equal(spans.length, 1);
  assert.ok(
    spans[0].classList.contains("md-math-display"),
    "a $$...$$ pair is display math even when it sits inside a paragraph"
  );
});

test("\\(...\\) keeps working (regression guard for the branch above it)", () => {
  const { container } = render("行内 \\(\\alpha\\) 结束");
  const text = container.textContent;
  assert.ok(!text.includes("\\(") && !text.includes("\\)"), `inline math markers leaked: ${text}`);
  assert.equal(container.querySelectorAll(".md-math-inline").length, 1);
  assert.ok(text.includes("行内") && text.includes("结束"), `prose lost: ${text}`);
});

test("an unclosed \\[ is left as literal text rather than swallowing the rest", () => {
  const { container } = render("前面 \\[ 未闭合，后面还有文字");
  assert.ok(
    container.textContent.includes("后面还有文字"),
    "an unclosed delimiter must not eat the remainder of the message"
  );
});

test("rendering is idempotent and clears previous content", () => {
  const container = dom.doc.createElement("div");
  renderMarkdown(container, "第一次", { math: false });
  assert.equal(container.textContent, "第一次");
  renderMarkdown(container, "第二次", { math: false });
  assert.equal(container.textContent, "第二次", "previous content must be cleared");
});

test("empty input produces no content and no crash", () => {
  const { container } = render("");
  assert.equal(container.textContent, "");
});

test("a link inside a heading is still inert", () => {
  const { container } = render("## 见 [这里](javascript:void(0))");
  assert.equal(container.querySelectorAll(".md-link").length, 0);
  assert.ok(container.textContent.includes("链接已禁用"));
});

/* --------------------------------------------------------- tables (A-34) -- */

/**
 * The reported bug: a parameter table arrived as one run of pipe characters.
 *
 * The renderer had no table support at all, so `| 阶段 | 优化参数 | ...` came
 * through as literal text. That is worse than plain prose — the column structure
 * was the entire reason the model used a table.
 */
function md(source) {
  const el = dom.doc.createElement("div");
  // Math left on: a parameter table contains formulas, and rendering cells as
  // plain text would leave `$C_{ox}$` visible — the same defect as the pipes.
  renderMarkdown(el, source, { math: true });
  return el;
}

const PARAM_TABLE = `| 阶段 | 优化参数 | 依据特性 | 目标函数 |
|------|----------|----------|----------|
| 阶段1 | 基于场的参数 | — | — |
| 阶段2 | $C_{ox}$、$E_{g0}-E_{g2}$ | Cgg–Vgg（CV） | $O_1$（公式5） |
| 阶段3 | $\\mu_{eff}$、$n_{sub}$ | 线性转移特性（I–V） | $O_2$（公式6） |`;

test("a markdown table becomes a real table", () => {
  const root = md(PARAM_TABLE);
  const table = root.querySelector("table");
  assert.ok(table, "no table element was produced");
  assert.ok(!root.textContent.includes("|---"), "the separator row must not survive as text");
});

test("the header and every body row land in the right cells", () => {
  const root = md(PARAM_TABLE);
  const heads = root.querySelectorAll("th").map((th) => th.textContent.trim());
  assert.deepEqual(heads, ["阶段", "优化参数", "依据特性", "目标函数"]);

  const rows = root.querySelectorAll("tbody tr");
  assert.equal(rows.length, 3, `expected three body rows, got ${rows.length}`);
  const first = rows[0].querySelectorAll("td").map((td) => td.textContent.trim());
  assert.deepEqual(first, ["阶段1", "基于场的参数", "—", "—"]);
});

test("math inside a cell is rendered, not left as dollar signs", () => {
  // A parameter table always contains formulas. Plain-text cells would show
  // `$C_{ox}$`, which is the same defect as the pipes — the notation was the
  // point.
  const root = md(PARAM_TABLE);
  // Assert on the renderer's own marker rather than on KaTeX output: the test
  // environment has no layout engine, so KaTeX may fall back to literal text.
  // What must be true either way is that the cell content went through the
  // inline renderer instead of being printed as a plain string.
  const math = root.querySelectorAll(".md-math-inline");
  assert.ok(math.length > 0, "cell math did not go through the inline renderer");
  const cells = root.querySelectorAll("td");
  assert.ok(
    cells.some((td) => td.textContent.includes("C")),
    "the formula text must still be present in its cell"
  );
});

test("alignment markers are applied", () => {
  const root = md("| a | b | c |\n|:--|:--:|--:|\n| 1 | 2 | 3 |");
  const th = root.querySelectorAll("th");
  assert.equal(th[0].style.textAlign, "left");
  assert.equal(th[1].style.textAlign, "center");
  assert.equal(th[2].style.textAlign, "right");
});

test("a prose line with a pipe is not mistaken for a table", () => {
  // The separator row is what defines a table. Without this check, a sentence
  // like "用 A | B 表示" would swallow the following lines.
  const root = md("这里用 A | B 表示两种情况。\n下一行还是普通文字。");
  assert.equal(root.querySelector("table"), null, "made a table out of prose");
  assert.ok(root.textContent.includes("A | B"), root.textContent);
});

test("a ragged row is padded so later columns do not shift", () => {
  // Model output routinely has a short row. Letting it shift would put values
  // under the wrong heading, which is a wrong answer rather than a layout nit.
  const root = md("| a | b | c |\n|---|---|---|\n| 1 | 2 |");
  const tds = root.querySelectorAll("tbody tr")[0].querySelectorAll("td");
  assert.equal(tds.length, 3, "the row must still have three cells");
  assert.equal(tds[2].textContent.trim(), "");
});

test("an escaped pipe stays a literal pipe inside its cell", () => {
  const root = md("| expr | note |\n|---|---|\n| P(a \\| b) | 条件概率 |");
  const tds = root.querySelectorAll("tbody tr")[0].querySelectorAll("td");
  assert.equal(tds.length, 2, "the escaped pipe must not split the cell");
  assert.ok(tds[0].textContent.includes("P(a | b)"), tds[0].textContent);
});

test("a table with no body rows still renders its header", () => {
  const root = md("| a | b |\n|---|---|");
  assert.ok(root.querySelector("table"));
  assert.equal(root.querySelectorAll("tbody tr").length, 0);
});

test("the table ends at a blank line and the prose after it survives", () => {
  const root = md("| a | b |\n|---|---|\n| 1 | 2 |\n\n表格之后的说明文字。");
  assert.equal(root.querySelectorAll("tbody tr").length, 1);
  assert.ok(root.textContent.includes("表格之后的说明文字"), root.textContent);
});

test("a table is wrapped so a wide one can scroll", () => {
  // Four columns do not fit a side panel; squeezing them makes the numbers
  // unreadable instead of saving space.
  const root = md(PARAM_TABLE);
  assert.ok(root.querySelector(".md-table-wrap"), "missing scroll container");
});
