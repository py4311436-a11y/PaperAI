/**
 * Regression tests for page text extraction (A-26).
 *
 * The bug: the panel reported "未能提取到文本" for a document that has text on
 * every page. `getPageText()` read the rendered `.textLayer` DOM element, and
 * PDF.js only builds that inside `PDFPageView#draw()` — which runs for pages it
 * has actually rendered. Rendering is virtualised by visibility, so any page
 * the user had not scrolled to had no text layer and read as empty, exactly
 * like a genuinely scanned page. Text extraction depended on scroll position.
 *
 * Every existing test supplied its own fake `getPageText`, so the adapter's own
 * extraction was never exercised end to end. That is why this bug reached the
 * user with a green suite: the code under test was the fake.
 *
 * Two things follow, and both are done here:
 *   1. The composer is a pure function over `getTextContent()` items, so it is
 *      testable in Node with no browser and no worker.
 *   2. The test inputs are REAL output from real fixture PDFs, captured by
 *      scripts/capture-text-fixture.mjs. Synthetic items only prove the
 *      function handles the shapes I thought of; real items carry the ones I
 *      did not.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { textFromContentItems } from "../../dist-test/src/pdf/text-compose.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "test-fixtures");

/**
 * Real `getTextContent()` output from `test-fixtures/single/PDF-A-single.pdf`.
 *
 * Captured rather than written by hand. If the capture script has not been run
 * these tests are skipped rather than passed — a missing fixture must not look
 * like a green run, which is the failure mode that hid A-26 in the first place.
 */
function loadRealItems(name) {
    try {
        const raw = readFileSync(join(fixtureDir, "text-items", name), "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------ the composer -- */

test("a line of items joins into readable text", () => {
    // Adjacent runs are separate text-showing operations, so they need a space
    // between them or words merge.
    const out = textFromContentItems([
        { str: "Training-Free", hasEOL: false },
        { str: "Parameter", hasEOL: false },
        { str: "Extraction", hasEOL: false },
    ]);
    assert.equal(out, "Training-Free Parameter Extraction");
});

test("hasEOL marks the end of a line", () => {
    // The text layer renders a <br> after an item with hasEOL; the composer has
    // to agree, or the model receives one wall of text with no line structure.
    const out = textFromContentItems([
        { str: "第一行", hasEOL: true },
        { str: "第二行", hasEOL: true },
    ]);
    assert.equal(out, "第一行\n第二行");
});

test("an empty item still ends its line", () => {
    // A zero-width item can carry hasEOL with no text. Dropping the break would
    // silently join two lines the reader sees as separate.
    const out = textFromContentItems([
        { str: "上文", hasEOL: false },
        { str: "", hasEOL: true },
        { str: "下文", hasEOL: true },
    ]);
    assert.equal(out, "上文\n下文");
});

/**
 * A blank line is a paragraph gap, and it comes from an empty run that follows
 * a line which already ended — the text layer renders two `<br>`s there. The
 * expectation was checked against the DOM implementation this replaced rather
 * than assumed: concatenating the layer's own nodes for these items gives
 * "段落一\n\n段落二" too, so the two paths agree.
 */
test("a blank line between paragraphs survives as one break", () => {
    const out = textFromContentItems([
        { str: "段落一", hasEOL: true },
        { str: "", hasEOL: true },
        { str: "段落二", hasEOL: true },
    ]);
    assert.equal(out, "段落一\n\n段落二");
});

test("runs of blank lines collapse to one", () => {
    const out = textFromContentItems([
        { str: "A", hasEOL: true },
        { str: "", hasEOL: true },
        { str: "", hasEOL: true },
        { str: "", hasEOL: true },
        { str: "B", hasEOL: true },
    ]);
    assert.equal(out, "A\n\nB");
});

test("leading and trailing blank lines are dropped", () => {
    const out = textFromContentItems([
        { str: "", hasEOL: true },
        { str: "正文", hasEOL: true },
        { str: "", hasEOL: true },
    ]);
    assert.equal(out, "正文");
});

test("a page with no text at all yields empty, not whitespace", () => {
    // This is the scanned-page case, and it must stay distinguishable from a
    // page with text. Returning " " here would make a scanned page look like a
    // page with one space of content.
    assert.equal(textFromContentItems([]), "");
    assert.equal(textFromContentItems([{ str: "", hasEOL: true }]), "");
    assert.equal(textFromContentItems([{ str: "   ", hasEOL: false }]), "");
});

test("runs that already end in a space are not double-spaced", () => {
    const out = textFromContentItems([
        { str: "word ", hasEOL: false },
        { str: "next", hasEOL: false },
    ]);
    assert.equal(out, "word next");
});

test("a blank line between paragraphs survives as one break", () => {
    const out = textFromContentItems([
        { str: "段落一", hasEOL: true },
        { str: "", hasEOL: true },
        { str: "段落二", hasEOL: true },
    ]);
    assert.equal(out, "段落一\n\n段落二");
});

test("CJK text keeps its characters without injected spaces", () => {
    // The whole point of the reader: papers are read in Chinese too. PDF.js
    // splits a line into one item per text-showing operation, so a Chinese line
    // can arrive as several runs -- and a joiner that adds a space between
    // every run puts a space between two Chinese characters, which is visible
    // and wrong. The rule is therefore script-aware: a space only goes between
    // Latin word characters.
    const out = textFromContentItems([
        { str: "本文提出一种", hasEOL: false },
        { str: "参数提取方法", hasEOL: true },
    ]);
    assert.equal(out, "本文提出一种参数提取方法");
});

test("a space goes between Latin runs but not CJK ones", () => {
    // Same mechanism, opposite requirement, in one line: the Latin runs need
    // the separator to stop merging, the CJK runs must not have one.
    const out = textFromContentItems([
        { str: "Training-Free", hasEOL: false },
        { str: "Parameter", hasEOL: false },
        { str: "方法", hasEOL: false },
        { str: "如下", hasEOL: true },
    ]);
    assert.equal(out, "Training-Free Parameter方法如下");
});

/* ------------------------------------------------- real fixture PDF output -- */

/**
 * The tests above are shapes. These are the real thing: actual items from a
 * fixture PDF, so the composer is exercised against the spacing, ordering and
 * empty-run patterns a real page produces — including the ones not anticipated
 * above.
 */
const realSingle = loadRealItems("PDF-A-single.page1.json");
const realChinese = loadRealItems("报告-中文-空格.page1.json");

test("real PDF output composes into non-empty readable text", (t) => {
    if (!realSingle) {
        t.skip("fixture not captured — run scripts/capture-text-fixture.mjs");
        return;
    }
    const out = textFromContentItems(realSingle);
    assert.ok(out.length > 100, `expected real text, got ${out.length} chars`);
    assert.ok(!/^\s|\s$/.test(out), "no leading or trailing whitespace");
    assert.ok(!/[ \t]{2,}/.test(out), "no runs of spaces");
    assert.ok(!/\n{3,}/.test(out), "no runs of blank lines");
});

test("real Chinese PDF output is not mangled by the joiner", (t) => {
    if (!realChinese) {
        t.skip("fixture not captured — run scripts/capture-text-fixture.mjs");
        return;
    }
    const out = textFromContentItems(realChinese);
    assert.ok(out.length > 50, `expected real text, got ${out.length} chars`);
    // Chinese has no spaces between words, so a joiner that inserts them is
    // detectable as a space between two CJK characters.
    assert.ok(!/[\u4e00-\u9fff] [\u4e00-\u9fff]/.test(out), "no space between CJK chars");
});

/**
 * The property the whole fix rests on: extraction must not depend on which
 * pages happen to be rendered. `textFromContentItems` is a pure function of the
 * items, so the assertion is that the same items always give the same text —
 * the DOM version could not make that promise, because its input was whatever
 * the renderer had happened to build.
 */
test("extraction is deterministic and independent of call order", () => {
    const items = [
        { str: "A", hasEOL: false },
        { str: "B", hasEOL: true },
        { str: "C", hasEOL: false },
    ];
    const first = textFromContentItems(items);
    for (let i = 0; i < 5; i++) {
        assert.equal(textFromContentItems(items), first);
    }
    // And it does not mutate its input, so a cached result cannot drift.
    assert.deepEqual(items, [
        { str: "A", hasEOL: false },
        { str: "B", hasEOL: true },
        { str: "C", hasEOL: false },
    ]);
});
