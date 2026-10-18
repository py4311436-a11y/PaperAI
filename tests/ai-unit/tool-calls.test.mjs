/**
 * The rules for acting on a model's tool calls.
 *
 * This module is the only place a model can make the app *do* something, so
 * every rule here is a refusal or a cap rather than a repair. Each test below
 * fails if its rule is removed — that is the point: these are not layout
 * decisions, they are the boundary between "the model asked" and "the app did".
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_REFETCH_PAGES,
  imageToolReply,
  planToolCalls,
  refusalReply,
} from "../../dist-test/src/ai/tool-calls.js";

function call(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const readPage = (id, page) => call(id, "read_page", { page });
const none = new Set();

// --------------------------------------------------------------------- happy

test("a valid request plans exactly that page", () => {
  const plan = planToolCalls([readPage("c1", 5)], 7, none);
  assert.deepEqual(plan.fetch, [5]);
  assert.deepEqual(plan.fresh, [5]);
  assert.equal(plan.overBudget, false);
  assert.deepEqual(plan.replies, []);
});

test("several pages are fetched in the order asked", () => {
  const plan = planToolCalls([readPage("a", 3), readPage("b", 1)], 7, none);
  assert.deepEqual(plan.fetch, [3, 1], "order is preserved so replies line up");
});

test("the same page asked twice is fetched once", () => {
  const plan = planToolCalls([readPage("a", 4), readPage("b", 4)], 7, none);
  assert.deepEqual(plan.fetch, [4]);
  // The second call still needs a reply, but not a second fetch.
  assert.ok(plan.overBudget === false);
});

// ------------------------------------------------------------------ refusals

test("an unknown tool is refused by name", () => {
  // A tool is an action. Only one exists, and a name from anywhere else must not
  // become one — Rust checks the same allowlist, so this is the second gate.
  const plan = planToolCalls([call("c1", "delete_file", {})], 7, none);
  assert.deepEqual(plan.fetch, []);
  assert.equal(plan.replies.length, 1);
  assert.equal(plan.replies[0].id, "c1");
  assert.ok(plan.replies[0].reason.includes("delete_file"), plan.replies[0].reason);
});

test("a page past the end is refused, never clamped", () => {
  // Clamping 900 to page 7 would hand the model a page it did not ask for, and
  // it would answer from it believing it had page 900. A refusal is the only
  // honest response.
  const plan = planToolCalls([readPage("c1", 900)], 7, none);
  assert.deepEqual(plan.fetch, [], "must not fetch anything");
  assert.ok(plan.replies[0].reason.includes("900"), plan.replies[0].reason);
  assert.ok(plan.replies[0].reason.includes("7"), "and it must say how many there are");
});

test("page zero and negative pages are refused", () => {
  for (const page of [0, -3]) {
    const plan = planToolCalls([readPage("c1", page)], 7, none);
    assert.deepEqual(plan.fetch, [], `page ${page} must not be fetched`);
    assert.equal(plan.replies.length, 1);
  }
});

test("a fractional page is refused rather than rounded", () => {
  // Rounding 3.7 to 4 answers a question about a page the model did not ask for.
  const plan = planToolCalls([call("c1", "read_page", { page: 3.7 })], 7, none);
  assert.deepEqual(plan.fetch, []);
  assert.ok(plan.replies[0].reason.includes("整数"), plan.replies[0].reason);
});

test("a string page is refused", () => {
  // Models do emit {"page": "5"}. Accepting it would mean the app silently
  // reinterprets a malformed call as a valid one.
  const plan = planToolCalls([call("c1", "read_page", { page: "5" })], 7, none);
  assert.deepEqual(plan.fetch, []);
  assert.ok(plan.replies[0].reason.includes("整数"));
});

test("malformed JSON is refused with a usable message", () => {
  const plan = planToolCalls(
    [{ id: "c1", type: "function", function: { name: "read_page", arguments: "{oops" } }],
    7,
    none
  );
  assert.deepEqual(plan.fetch, []);
  assert.ok(plan.replies[0].reason.includes("JSON"), plan.replies[0].reason);
});

test("a missing arguments string is refused, not treated as page 0", () => {
  const plan = planToolCalls(
    [{ id: "c1", type: "function", function: { name: "read_page" } }],
    7,
    none
  );
  assert.deepEqual(plan.fetch, []);
  assert.equal(plan.replies.length, 1);
});

// ------------------------------------------------------------------- budget

test("the first two pages fit the budget", () => {
  const plan = planToolCalls([readPage("a", 1), readPage("b", 2)], 7, none);
  assert.equal(plan.overBudget, false);
  assert.deepEqual(plan.fresh, [1, 2]);
});

test("a third page exceeds it and needs approval", () => {
  // The user's cap. Enough for one detail plus the figure it is in, not enough
  // for the model to read the whole paper one page at a time.
  const plan = planToolCalls([readPage("a", 1), readPage("b", 2), readPage("c", 3)], 7, none);
  assert.equal(plan.overBudget, true);
  assert.equal(MAX_REFETCH_PAGES, 2, "the cap is the user's number, not a round one");
});

test("budget already spent means even one more page needs approval", () => {
  const plan = planToolCalls([readPage("c", 3)], 7, new Set([1, 2]));
  assert.equal(plan.overBudget, true);
});

test("a page already in the request is not charged again", () => {
  // Without this, asking twice for page 5 in successive rounds would buy two
  // refetches of the same image.
  const plan = planToolCalls([readPage("c", 2)], 7, new Set([1, 2]));
  assert.deepEqual(plan.fetch, [], "nothing to fetch");
  assert.equal(plan.overBudget, false, "and nothing to charge");
  assert.ok(plan.replies[0].reason.includes("已经发送过"), plan.replies[0].reason);
});

// ------------------------------------------------------------------- replies

test("an image reply carries the page and the call it answers", () => {
  // The protocol correlates a `tool` message with its call by id. A wrong or
  // missing id makes the request malformed, which the provider reports as a bad
  // request — looking like a broken model rather than a broken app.
  const msg = imageToolReply("call_7", 5, "data:image/jpeg;base64,AAA");
  assert.equal(msg.role, "tool");
  assert.equal(msg.tool_call_id, "call_7");
  assert.equal(msg.content[0].type, "text");
  assert.ok(msg.content[0].text.includes("5"));
  assert.equal(msg.content[1].type, "image_url");
  assert.equal(msg.content[1].image_url.url, "data:image/jpeg;base64,AAA");
});

test("a refusal reply is plain text, not an empty result", () => {
  // An empty `tool` message reads as "the page is blank", which is a different
  // claim from "I could not read it".
  const msg = refusalReply("call_1", "页码 900 超出范围（本文件共 7 页）。");
  assert.equal(msg.role, "tool");
  assert.equal(msg.tool_call_id, "call_1");
  assert.ok(msg.content.includes("900"));
});

// ------------------------------------------------------------------ totality

test("every call gets exactly one outcome", () => {
  // The invariant the protocol needs. A call with neither a fetch nor a refusal
  // would go unanswered, and the follow-up request would be rejected.
  const calls = [
    readPage("a", 1),
    call("b", "unknown_tool", {}),
    readPage("c", 900),
    call("d", "read_page", { page: "x" }),
    readPage("a2", 1),
  ];
  const plan = planToolCalls(calls, 7, none);
  const answered = new Set([...plan.replies.map((r) => r.id), ...plan.fetch.map(() => "a")]);
  // `a` and `a2` both asked for page 1: one fetch, and `a2` is de-duplicated into
  // the same fetch rather than given a reply.
  assert.equal(plan.fetch.length, 1);
  assert.equal(plan.replies.length, 3, "the three unusable calls were refused");
  for (const id of ["b", "c", "d"]) {
    assert.ok(answered.has(id), `${id} went unanswered`);
  }
});

/* --------------------- pages already sent are free but still duplicates -- */

test("a page the context mode already sent is refused as a duplicate", () => {
  // In whole-document image mode every page is in the request. Sending one
  // again costs a full image for nothing.
  const plan = planToolCalls([readPage("c1", 3)], 7, none, new Set([1, 2, 3, 4, 5, 6, 7]));
  assert.deepEqual(plan.fetch, []);
  assert.ok(plan.replies[0].reason.includes("已经发送过"), plan.replies[0].reason);
});

test("a page already sent does not consume the refetch budget", () => {
  // The two questions are separate. Seeding the budget with sent pages would
  // make a seven-image question start out over budget, so every call would
  // prompt the user even though nothing new would be sent.
  const plan = planToolCalls([readPage("c1", 3)], 30, none, new Set([1, 2, 3]));
  assert.equal(plan.overBudget, false, "asking about an already-sent page spends nothing");
});

test("a page not in the request still spends budget when one was sent", () => {
  // The complement: an image request that was truncated still benefits from a
  // refetch of a page it never carried.
  const plan = planToolCalls([readPage("c1", 20)], 30, none, new Set([1, 2, 3]));
  assert.deepEqual(plan.fetch, [20], "a page outside the request must be fetched");
  assert.equal(plan.overBudget, false, "one page is inside the budget");
});

test("budget and duplicates are counted separately", () => {
  // Two refetches already spent, and the model asks for one already sent plus
  // one new one: the duplicate is free, the new one exceeds the budget.
  const plan = planToolCalls(
    [readPage("a", 1), readPage("b", 9)],
    30,
    new Set([4, 5]),
    new Set([1])
  );
  assert.deepEqual(plan.fetch, [9], "only the page not already carried is planned");
  assert.equal(plan.overBudget, true, "and it is one too many");
});
