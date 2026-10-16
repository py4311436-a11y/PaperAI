/**
 * Tests for the eraser decision rules (A-18).
 *
 * The reported bug: Erase was an "if something is selected, delete it now"
 * button. Because PDF.js keeps a freshly drawn ink editor selected, pressing
 * Erase after drawing removed that stroke — the tool looked like it was undoing
 * the previous action instead of erasing what you point at.
 *
 * The fix moves the decision into a pure function so the rules can be pinned
 * down without a PDF, a WebView or a mouse: an eraser deletes ONLY what the
 * user aimed at, and arming it never deletes anything.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { eraseDecision } from "../../dist-test/src/tools/erase-policy.js";

const armed = { armed: true, hitAnnotation: true, hasSelection: true };

test("armed + click on an annotation + something selected -> delete", () => {
  assert.equal(eraseDecision(armed), "delete");
});

test("NOT armed -> never delete, whatever else is true", () => {
  // This is the rule that makes pressing Erase itself harmless: the click on
  // the button cannot delete, even with a selection already sitting there.
  assert.equal(eraseDecision({ armed: false, hitAnnotation: true, hasSelection: true }), "ignore");
});

test("a click on empty paper never deletes, even with a selection present", () => {
  // The case that produced "it erases my last stroke": a selection left over
  // from an earlier action must not be destroyed by an unrelated click.
  assert.equal(eraseDecision({ armed: true, hitAnnotation: false, hasSelection: true }), "ignore");
});

test("a click on an annotation that selected nothing -> ignore", () => {
  // PDF.js may not have applied its selection yet when we are asked.
  assert.equal(eraseDecision({ armed: true, hitAnnotation: true, hasSelection: false }), "ignore");
});

test("the full truth table is exactly these eight outcomes", () => {
  const table = [];
  for (const a of [false, true]) {
    for (const h of [false, true]) {
      for (const s of [false, true]) {
        const key = `${a ? 1 : 0}${h ? 1 : 0}${s ? 1 : 0}`;
        table.push(`${key}=${eraseDecision({ armed: a, hitAnnotation: h, hasSelection: s })}`);
      }
    }
  }
  // Key order is armed/hitAnnotation/hasSelection. Only 111 deletes: deleting
  // requires all three, which is what makes this an eraser rather than a
  // "delete the current selection" button.
  assert.deepEqual(table, [
    "000=ignore",
    "001=ignore",
    "010=ignore",
    "011=ignore",
    "100=ignore",
    "101=ignore",
    "110=ignore",
    "111=delete",
  ]);
});

test("deleting requires ALL THREE conditions, so no single flag is load-bearing", () => {
  // Guards against a future "simplification" that collapses this into
  // `hasSelection && armed`, which would bring back the reported bug.
  const onlyOneTrue = [
    { armed: true, hitAnnotation: false, hasSelection: false },
    { armed: false, hitAnnotation: true, hasSelection: false },
    { armed: false, hitAnnotation: false, hasSelection: true },
  ];
  for (const input of onlyOneTrue) {
    assert.equal(eraseDecision(input), "ignore", `${JSON.stringify(input)} must not delete`);
  }
});