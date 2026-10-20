/**
 * The text of a page that falls inside a selected rectangle.
 *
 * The geometry is the whole risk: a mistake here does not crash, it silently
 * returns the wrong paragraph — which the reader would then translate and
 * believe. So the tests are about positions, not about output formatting.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  itemBox,
  itemOverlaps,
  textInRegion,
} from "../../dist-test/src/pdf/text-region.js";

/**
 * A text item. `transform` is [a,b,c,d,x,y] with the position in PDF user
 * space; `y` is the baseline, so the glyphs sit above it.
 */
function item(str, x, baseline, width, height = 10, hasEOL = false) {
  return {
    str,
    hasEOL,
    transform: [1, 0, 0, 1, x, baseline],
    width,
    height,
  };
}

// A page 600 wide and 800 tall, with three lines of text on it.
// PDF user space: y grows upward, so the top line has the highest baseline.
const LINE_1 = item("The first line", 50, 750, 100, 10, true);
const LINE_2 = item("The second line", 50, 720, 100, 10, true);
const LINE_3 = item("The third line", 50, 690, 100, 10, true);
const PAGE = [LINE_1, LINE_2, LINE_3];

test("a region covering two lines returns those two lines", () => {
  const text = textInRegion(PAGE, { x: 40, y: 715, width: 200, height: 40 });
  assert.ok(text.includes("first"), text);
  assert.ok(text.includes("second"), text);
  assert.ok(!text.includes("third"), text);
});

test("a region covering one line returns only that line", () => {
  const text = textInRegion(PAGE, { x: 40, y: 685, width: 200, height: 20 });
  assert.equal(text, "The third line");
});

test("a line is selected by overlap, not by containment", () => {
  // A tall run — a heading, a figure label — whose baseline sits *below* the
  // region but whose glyphs reach up into it. Requiring full containment would
  // drop it, and the reader who dragged across it would get text missing.
  const tall = item("Tall heading", 50, 700, 100, 30, true);
  const text = textInRegion([tall, LINE_3], { x: 40, y: 715, width: 200, height: 25 });
  assert.ok(text.includes("Tall heading"), `a partially covered line was dropped: ${text}`);
  assert.ok(!text.includes("third"), "and a line outside the region stays out");
});

test("the first and last lines of a selection are both kept", () => {
  // The everyday case: the reader dragged across a paragraph, and the drag
  // does not land exactly on the text. Requiring containment would silently
  // drop the first and last lines of every selection.
  // The region cuts through the first line's glyphs (750–760) and the last
  // line's (690–700), so neither is fully inside it.
  const text = textInRegion(PAGE, { x: 40, y: 695, width: 200, height: 60 });
  assert.ok(text.includes("first"), `the top line was dropped: ${text}`);
  assert.ok(text.includes("second"), text);
  assert.ok(text.includes("third"), `the bottom line was dropped: ${text}`);
});

test("a region to the right of the text selects nothing", () => {
  const text = textInRegion(PAGE, { x: 400, y: 600, width: 150, height: 200 });
  assert.equal(text, "");
});

test("a region below the text selects nothing", () => {
  const text = textInRegion(PAGE, { x: 40, y: 100, width: 200, height: 40 });
  assert.equal(text, "");
});

test("a region to the left of the text selects nothing", () => {
  const text = textInRegion(PAGE, { x: 0, y: 600, width: 20, height: 200 });
  assert.equal(text, "");
});

test("a narrow region catches only the runs it covers horizontally", () => {
  // Two runs on the same line, side by side.
  const left = item("left", 50, 700, 30, 10);
  const right = item("right", 200, 700, 40, 10);
  const text = textInRegion([left, right], { x: 45, y: 695, width: 60, height: 15 });
  assert.ok(text.includes("left"), text);
  assert.ok(!text.includes("right"), text);
});

test("an item without a transform is skipped rather than crashing", () => {
  const broken = { str: "broken", hasEOL: false };
  const text = textInRegion([broken, LINE_3], { x: 40, y: 685, width: 200, height: 20 });
  assert.equal(text, "The third line");
});

test("the baseline is the bottom of the item, not its middle", () => {
  // Getting this wrong shifts every selection up by a line, which looks like
  // "the text was right but was the previous paragraph".
  const box = itemBox(item("x", 10, 100, 20, 12));
  assert.equal(box.y0, 100, "the bottom is the baseline");
  assert.equal(box.y1, 112, "the top is the baseline plus the height");
});

test("an item with no width still overlaps a region it sits in", () => {
  // Some PDFs report no advance width; the item must not be dropped for it.
  const noWidth = { str: "tight", hasEOL: true, transform: [1, 0, 0, 1, 50, 700], height: 10 };
  const text = textInRegion([noWidth], { x: 40, y: 695, width: 200, height: 20 });
  assert.ok(text.includes("tight"), text);
});

test("a region selects nothing from a page with no text", () => {
  assert.equal(textInRegion([], { x: 0, y: 0, width: 600, height: 800 }), "");
});

test("a whole-page region returns the whole page", () => {
  const text = textInRegion(PAGE, { x: 0, y: 0, width: 600, height: 800 });
  assert.ok(text.includes("first") && text.includes("second") && text.includes("third"), text);
});
