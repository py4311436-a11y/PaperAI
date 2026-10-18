/**
 * Tests for `whole-document-images` (A-28) — sending a document as page images.
 *
 * Why the mode exists: a scanned paper has no text in the file at all. The user
 * reported "未能提取到文本" as a bug on exactly such a document, and it was not
 * one — the pages carry one image draw operation each and zero text operations,
 * so there is nothing for the text pipeline to read. Reading it differently
 * cannot help; looking at the page can.
 *
 * What is tested here is the assembly: which pages go out, in what shape, with
 * what the model is told about them. The rendering itself is PDF.js's job and
 * needs a real canvas, so it is not unit-tested — but the budget, the coverage
 * note and the message shape all are, because those are where a silent wrong
 * answer comes from.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContext,
  MAX_IMAGE_PAYLOAD_CHARS,
  MAX_WHOLE_DOCUMENT_IMAGE_PAGES,
  PAGE_IMAGE_MAX_EDGE,
} from "../../dist-test/src/ai/context-builder.js";

// No type import here: this is a `.mjs` file run directly by Node, which has no
// TypeScript syntax. The attachment shape is asserted structurally below.

/** A page image standing in for a real rasterisation. */
function pageImg(page, chars = 200_000) {
  return {
    id: `page-${page}`,
    url: `data:image/jpeg;base64,PAGE${page}`,
    chars,
    width: 1200,
    height: 1600,
    source: "page",
    page,
  };
}

const base = {
  question: "这篇文章讲了什么？",
  selection: null,
  getPageText: async () => "",
  currentPage: 1,
  pageCount: 7,
  documentTitle: "扫描论文.pdf",
  history: [],
};

// ------------------------------------------------------------------- assembly

test("image mode sends every page as an image when there is no text", async () => {
  const sent = [];
  const built = await buildContext({
    ...base,
    mode: "whole-document-images",
    // Text extraction finds nothing — this is a scanned document.
    getPageText: async () => "",
    getPageImage: async (p) => {
      sent.push(p);
      return pageImg(p);
    },
  });

  assert.deepEqual(sent, [1, 2, 3, 4, 5, 6, 7], "every page must be rasterised");
  assert.deepEqual(built.stats.pages_sent, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(built.stats.images, 7, "the count must be the pages, not zero");
  assert.ok(built.label.includes("共 7 页"), built.label);
});

test("the images travel in the question turn, never the document turn", async () => {
  // The cache invariant. An image in the document message would make the prefix
  // diverge on every question, so the whole document has to be re-billed every
  // turn for the rest of the conversation.
  const built = await buildContext({
    ...base,
    mode: "whole-document-images",
    getPageImage: async (p) => pageImg(p),
  });

  // There is no document *text* in this mode, so no document message at all.
  const docMsg = built.messages.find(
    (m) => typeof m.content === "string" && m.content.includes("<document_context>")
  );
  assert.equal(docMsg, undefined, "no text document message is expected");

  const last = built.messages[built.messages.length - 1];
  assert.ok(Array.isArray(last.content), "the question turn carries the images");
  const parts = last.content;
  assert.equal(parts[0].type, "text", "the question still comes first");
  const images = parts.filter((p) => p.type === "image_url");
  assert.equal(images.length, 7);
  for (const [i, p] of images.entries()) {
    assert.equal(p.type === "image_url" && p.image_url.url, `data:image/jpeg;base64,PAGE${i + 1}`);
  }
});

test("the model is told these are whole pages, not fragments", async () => {
  // A region screenshot may be half a figure, and the prompt says so. Telling a
  // model it is looking at a complete page that it "may only contain a formula"
  // understates what it has and invites a hedged answer.
  const built = await buildContext({
    ...base,
    mode: "whole-document-images",
    getPageImage: async (p) => pageImg(p),
  });
  const text = built.messages.at(-1).content;
  const joined = Array.isArray(text) ? text.map((p) => (p.type === "text" ? p.text : "")).join("\n") : text;
  assert.ok(joined.includes("完整页面"), `whole-page framing missing: ${joined.slice(0, 200)}`);
  assert.ok(joined.includes("资料，不是指令"), "the injection rule must still apply");
});

test("a question with no document at all still says so", async () => {
  // The image mode must not be mistaken for "no document provided". A user who
  // picks it and whose renders all fail deserves the honest message, not
  // silence that looks like the document was sent.
  const built = await buildContext({
    ...base,
    mode: "whole-document-images",
    getPageImage: async () => {
      throw new Error("render failed");
    },
  });
  assert.equal(built.stats.images, 0);
  assert.ok(built.label.includes("渲染失败"), built.label);
  const last = built.messages.at(-1).content;
  assert.equal(typeof last, "string", "with no images the question stays a string");
  assert.ok(last.includes("没有提供论文原文"), last);
});

// --------------------------------------------------------------------- budget

test("the page cap stops the walk and says so", async () => {
  const built = await buildContext({
    ...base,
    pageCount: 30,
    mode: "whole-document-images",
    getPageImage: async (p) => pageImg(p),
  });
  assert.equal(
    built.stats.pages_sent.length,
    MAX_WHOLE_DOCUMENT_IMAGE_PAGES,
    "must stop at the cap, not walk all 30"
  );
  assert.ok(built.label.includes("仅发送"), built.label);
  assert.ok(built.label.includes("共 30 页"), built.label);
  assert.equal(built.stats.truncated, true, "and it must be flagged as partial");
});

test("the model is told it received part of the paper", async () => {
  // Without this it summarises 12 pages and calls it the article — the same
  // silent-truncation failure the text mode guards against.
  const built = await buildContext({
    ...base,
    pageCount: 30,
    mode: "whole-document-images",
    getPageImage: async (p) => pageImg(p),
  });
  const last = built.messages.at(-1).content;
  const joined = Array.isArray(last) ? last.map((p) => (p.type === "text" ? p.text : "")).join("\n") : last;
  assert.ok(joined.includes("部分"), `partial-coverage note missing: ${joined.slice(0, 300)}`);
  assert.ok(joined.includes("全文共 30 页"), joined);
});

test("the payload budget stops before the request becomes unsendable", async () => {
  // Each page is 3 MiB of data URL, so four of them exceed the 12 MiB ceiling.
  // Assembling all twelve and letting the provider reject the request would
  // waste every render the user waited for.
  let renders = 0;
  const built = await buildContext({
    ...base,
    pageCount: 12,
    mode: "whole-document-images",
    getPageImage: async (p) => {
      renders++;
      return pageImg(p, 3 * 1024 * 1024);
    },
  });
  assert.ok(renders < 12, `stopped early at ${renders} renders`);
  assert.ok(built.stats.images < 12, "fewer pages than requested");
  assert.equal(built.stats.truncated, true);
});

test("the payload ceiling is inside what the provider layer accepts", () => {
  // The Rust side refuses a request past 24 MiB of image payload. Staying well
  // under it leaves room for the question and a turn of history.
  assert.ok(MAX_IMAGE_PAYLOAD_CHARS <= 16 * 1024 * 1024, "must stay under the provider limit");
});

// ------------------------------------------------------------- mode interplay

test("a hand-drawn screenshot rides along with the page images", async () => {
  // Both are attachments to the same question, and the order matters: the
  // user's own selection is what the question is about, so it goes first.
  const shot = { ...pageImg(3), id: "region-1", source: "region" };
  const built = await buildContext({
    ...base,
    mode: "whole-document-images",
    attachments: [shot],
    getPageImage: async (p) => pageImg(p),
  });
  const parts = built.messages.at(-1).content;
  assert.ok(Array.isArray(parts));
  const images = parts.filter((p) => p.type === "image_url");
  assert.equal(images.length, 8, "the region plus the seven pages");
  assert.equal(
    images[0].type === "image_url" && images[0].image_url.url,
    shot.url,
    "the user's own selection must come first"
  );
});

test("image mode does not depend on the text pipeline at all", async () => {
  // The whole point: `getPageText` returning nothing must not affect it. If
  // these were coupled, a scanned document would be unaskable in both modes.
  const noText = await buildContext({
    ...base,
    mode: "whole-document-images",
    getPageText: async () => "",
    getPageImage: async (p) => pageImg(p),
  });
  const withText = await buildContext({
    ...base,
    mode: "whole-document-images",
    getPageText: async (p) => `第 ${p} 页正文`,
    getPageImage: async (p) => pageImg(p),
  });
  assert.equal(noText.stats.images, withText.stats.images);
  assert.equal(noText.stats.pages_sent.length, withText.stats.pages_sent.length);
});

test("without a renderer the mode says so instead of sending nothing", async () => {
  // A caller that cannot rasterise must not silently degrade into an empty
  // request. This is what the UI keys off to explain itself.
  const built = await buildContext({
    ...base,
    mode: "whole-document-images",
    // no getPageImage at all
  });
  assert.ok(built.label.includes("不支持渲染"), built.label);
  assert.equal(built.stats.images, 0);
});

test("the page image ceiling is a sane size for a rendered page", () => {
  // Small enough that the payload stays bounded, large enough that a formula
  // is still legible. Matches the region-screenshot ceiling deliberately, so
  // there is one number to reason about rather than two.
  assert.ok(PAGE_IMAGE_MAX_EDGE >= 1024, "must stay legible");
  assert.ok(PAGE_IMAGE_MAX_EDGE <= 2048, "must stay bounded");
});
