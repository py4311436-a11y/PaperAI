/**
 * Tests for the interrupted-answer path in the panel (A-16).
 *
 * The bug: the streaming request carried `RequestBuilder::timeout(15s)`, a
 * *total* deadline, so any completion over 15 s was cut off mid-answer. The
 * Rust side of that is covered by real-socket tests; these cover the two
 * frontend consequences that a user actually sees:
 *
 *   1. the text that DID arrive was thrown away, so a long, mostly-complete
 *      answer looked like it had produced nothing; and
 *   2. the error text said "waiting for the model timed out" even when the
 *      model had already answered half the question.
 *
 * Both are assertions about what the user is shown, which is the part no
 * transport-level test can reach.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { installDom } from "./dom-shim.mjs";
import { ChatPanel, humanError } from "../../dist-test/src/ai/chat-panel.js";

const dom = installDom();

function makePanel() {
  const panel = new ChatPanel({
    onSend: () => {},
    onStop: () => {},
    onNewConversation: () => {},
    onContextModeChange: () => {},
    onOpenSettings: () => {},
    onOpenLink: () => {},
    onCopy: () => {},
    onSelectProfile: () => {},
    onSelectModel: () => {},
    onGenerateMemory: () => {},
  });
  panel.show();
  return panel;
}

const turn = (over = {}) => ({
  id: "t1",
  role: "assistant",
  content: "",
  phase: "error",
  errorCode: "ai_timeout",
  errorMessage: "回答生成到一半被中断（连接在输出过程中停止）。可尝试重试，或改用更小的上下文范围。",
  createdAt: 0,
  ...over,
});

/** Render one assistant turn and return the flattened text of its body. */
function renderBody(panel, t) {
  panel.render([t], null);
  const body = panel.root.querySelector(".ai-turn-assistant").querySelector(".ai-body");
  return {
    text: body.textContent,
    hasPartial: !!body.querySelector(".ai-partial"),
    hasError: !!body.querySelector(".ai-error"),
  };
}

// ------------------------------------------------- the partial answer is kept

test("text that arrived before the failure is kept, above the error", () => {
  const panel = makePanel();
  const r = renderBody(panel, turn({ content: "这段论文主要讨论了图注意力的表达能力，" }));
  assert.equal(r.hasPartial, true, "the partial answer must still be on screen");
  assert.equal(r.hasError, true, "and the failure must still be reported");
  assert.ok(
    r.text.includes("图注意力的表达能力"),
    `the model's work was discarded: ${r.text}`
  );
  assert.ok(
    r.text.indexOf("图注意力") < r.text.indexOf("中断"),
    "the partial answer must come before the error, not after it"
  );
});

test("a partial answer is marked as such rather than passed off as complete", () => {
  const panel = makePanel();
  const r = renderBody(panel, turn({ content: "半句" }));
  assert.ok(
    r.text.includes("中断前已生成的内容"),
    "the user must be able to tell this is not the whole answer"
  );
});

test("a failure with nothing received shows the error alone", () => {
  const panel = makePanel();
  const r = renderBody(panel, turn({ content: "" }));
  assert.equal(r.hasPartial, false, "there was nothing to keep");
  assert.equal(r.hasError, true);
});

// ------------------------------------------------------- error text accuracy

test("a mid-answer interruption keeps the backend's specific wording", () => {
  const msg = humanError("ai_timeout", "回答生成到一半被中断（连接在输出过程中停止）。");
  assert.ok(msg.includes("一半"), `generic timeout text was used instead: ${msg}`);
  assert.ok(
    !msg.includes("检查网络"),
    `this is not a network problem; do not send the user chasing their proxy: ${msg}`
  );
});

test("a first-token timeout does not claim the answer was interrupted", () => {
  const msg = humanError("ai_first_token_timeout", "等待模型响应超时：连接已建立，但一直没有收到内容。");
  assert.ok(msg.includes("一直没有收到内容"), msg);
  assert.ok(!msg.includes("一半"), msg);
});

test("the two timeout codes are distinguishable from their text alone", () => {
  // If these ever render identically the user cannot tell a dead endpoint from
  // a dropped long response — the whole point of splitting them.
  const mid = humanError("ai_timeout", "回答生成到一半被中断。");
  const first = humanError("ai_first_token_timeout", "等待模型响应超时。");
  assert.notEqual(mid, first);
});

test("a missing backend message still falls back to actionable text", () => {
  assert.ok(humanError("ai_timeout", undefined).length > 0);
  assert.ok(humanError("ai_first_token_timeout", null).length > 0);
});
/* ------------------------------------------------ reading-memory row (A-19) */

const memState = (panel) => panel.root.querySelector(".ai-memory-state");
const memBtn = (panel) => panel.root.querySelector("#ai-memory-generate");

test("with no notes the row says so, and does not look active", () => {
  const panel = makePanel();
  panel.setMemoryState(null);
  assert.ok(memState(panel).textContent.includes("无"), memState(panel).textContent);
  assert.equal(memState(panel).classList.contains("on"), false, "no notes must not read as enabled");
  assert.equal(memBtn(panel).textContent, "生成");
});

test("with notes the row shows size, coverage and time, and reads as active", () => {
  const panel = makePanel();
  panel.setMemoryState({
    path: "D:/x/论文.pdf.paperai-notes.md",
    exists: true,
    bytes: 4096,
    updatedAt: "2026-10-16 16:30",
    coveredPages: "1–120（共 150 页）",
    content: "- 结论…",
  });
  const text = memState(panel).textContent;
  assert.ok(text.includes("已启用"), text);
  assert.ok(text.includes("4.0 KB"), text);
  assert.ok(text.includes("1–120（共 150 页）"), text);
  assert.ok(text.includes("2026-10-16 16:30"), text);
  assert.equal(memState(panel).classList.contains("on"), true);
  // The full path is in the tooltip: where the notes live matters, and there is
  // no room for it inline.
  assert.ok(memState(panel).title.endsWith(".paperai-notes.md"));
  assert.equal(memBtn(panel).textContent, "重新生成");
});

test("a running generation blocks a second one and shows progress", () => {
  const panel = makePanel();
  panel.setMemoryBusy(true, "正在生成笔记 2/5（第 41–80 页）…");
  assert.equal(panel.isMemoryBusy(), true);
  assert.equal(memBtn(panel).disabled, true, "must not be re-enterable while running");
  assert.ok(memState(panel).textContent.includes("2/5"), memState(panel).textContent);
  panel.setMemoryBusy(false);
  assert.equal(panel.isMemoryBusy(), false);
  assert.equal(memBtn(panel).disabled, false);
});

test("finishing a generation does not leave the row claiming to be busy", () => {
  const panel = makePanel();
  panel.setMemoryBusy(true, "正在通读全文…");
  // setMemoryState is what the pipeline calls when the write lands.
  panel.setMemoryState({ path: "p.md", exists: true, bytes: 100, content: "x" });
  assert.equal(panel.isMemoryBusy(), false);
  assert.equal(memBtn(panel).disabled, false);
});
