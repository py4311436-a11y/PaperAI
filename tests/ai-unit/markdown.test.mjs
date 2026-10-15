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
