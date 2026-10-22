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

/* ------------------------------------- Enter while an answer is in flight -- */

/**
 * The reported symptom: Enter did nothing, and it looked model-dependent.
 *
 * It was not. The send button is disabled while an answer streams, but a
 * disabled button cannot stop a keystroke — Enter went straight to `submit()`,
 * which had no busy check, and `chat.send()` returned null for a busy session
 * with no message anywhere. So the key was simply swallowed for as long as the
 * request was in flight.
 *
 * That reads as model-dependent because a slow model is in flight for a minute
 * or two while a fast one is finished before the user types again.
 */
function panelWithSpy() {
  const calls = { send: 0, blocked: 0 };
  const panel = new ChatPanel({
    onSend: () => {
      calls.send++;
    },
    onStop: () => {},
    onNewConversation: () => {},
    onContextModeChange: () => {},
    onOpenSettings: () => {},
    onOpenLink: () => {},
    onCopy: () => {},
    onSelectProfile: () => {},
    onSelectModel: () => {},
    onGenerateMemory: () => {},
    onScreenshot: () => {},
    onIncludeHistory: () => {},
    onSendBlocked: () => {
      calls.blocked++;
    },
  });
  panel.show();
  return { panel, calls };
}

function composerInput(panel) {
  return panel.root.querySelector("#ai-input");
}

function pressEnter(input) {
  input.fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, preventDefault() {} });
}

test("Enter sends when the composer is idle", () => {
  const { panel, calls } = panelWithSpy();
  panel.setPhase("idle", 0, 0);
  const input = composerInput(panel);
  input.value = "这是什么";
  pressEnter(input);
  assert.equal(calls.send, 1, "the question must go out");
  assert.equal(calls.blocked, 0);
});

test("Enter while streaming is reported instead of silently swallowed", () => {
  // The fix. Without it the keystroke produces nothing at all, which is
  // indistinguishable from a broken composer — and if the answer is slow, that
  // is exactly when the user tries again.
  const { panel, calls } = panelWithSpy();
  panel.setPhase("streaming", 0, 2);
  const input = composerInput(panel);
  input.value = "再问一个";
  pressEnter(input);
  assert.equal(calls.send, 0, "must not start a second request");
  assert.equal(calls.blocked, 1, "and must say why");
});

test("Enter while preparing is reported too", () => {
  // "preparing" is the long one for image requests: the upload happens here.
  const { panel, calls } = panelWithSpy();
  panel.setPhase("preparing", 0, 2, 7);
  pressEnter(composerInput(panel));
  assert.equal(calls.blocked, 1);
});

test("the status line says how many images are being waited on", () => {
  // A seven-page request can sit a minute before the first character. "正在准备…"
  // for that long is what makes a slow answer look like a hung one.
  const { panel } = panelWithSpy();
  panel.setPhase("preparing", 0, 2, 7);
  const status = panel.root.querySelector(".ai-status")?.textContent ?? "";
  assert.ok(status.includes("7"), `expected the image count: ${status}`);
});

test("Shift+Enter is still a newline, never a send", () => {
  const { panel, calls } = panelWithSpy();
  panel.setPhase("idle", 0, 0);
  const input = composerInput(panel);
  input.value = "第一行";
  input.fire("keydown", { key: "Enter", shiftKey: true, isComposing: false, keyCode: 13, preventDefault() {} });
  assert.equal(calls.send, 0);
  assert.equal(calls.blocked, 0, "a newline is not a blocked send");
});

test("an input method's Enter is not a send", () => {
  // A-25: every Chinese input method uses Enter to commit a candidate first.
  const { panel, calls } = panelWithSpy();
  panel.setPhase("idle", 0, 0);
  const input = composerInput(panel);
  input.value = "zhe shi";
  input.fire("keydown", { key: "Enter", shiftKey: false, isComposing: true, keyCode: 229, preventDefault() {} });
  assert.equal(calls.send, 0, "must not send half-typed pinyin");
});

/* ------------------------- the composer keeps the keys PDF.js wants (A-43) -- */

/**
 * Backspace in the composer sometimes did nothing.
 *
 * PDF.js's annotation editor listens for keys on `window` and its "is this a
 * text field?" check excludes <input> but not <textarea> — which is what the
 * composer is. So it claimed Backspace, called preventDefault, and the
 * keystroke never reached the box. It only did that while the editor mode was
 * not "select", which is why it looked intermittent.
 *
 * The fix keeps the event inside the composer: this listener is on the textarea,
 * PDF.js's is further up the bubble path.
 */
function composerKey(over = {}) {
  const stopped = { value: false };
  const ev = {
    key: "Backspace",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 8,
    preventDefault() {},
    stopPropagation() {
      stopped.value = true;
    },
    ...over,
  };
  return { ev, stopped };
}

test("backspace in the composer is not taken by the annotation editor", () => {
  const { panel } = panelWithSpy();
  panel.setPhase("idle", 0, 0);
  const input = composerInput(panel);
  const { ev, stopped } = composerKey();
  input.fire("keydown", ev);
  assert.equal(stopped.value, true, "the event must not reach PDF.js on window");
});

test("the same is true of delete and the select-all and undo shortcuts", () => {
  // All of them are mapped to annotation commands by PDF.js's keyboard
  // manager, and all of them are ordinary editing keys in a text box.
  const cases = [
    { key: "Delete" },
    { key: "a", ctrlKey: true },
    { key: "z", ctrlKey: true },
    { key: "y", ctrlKey: true },
    { key: "z", ctrlKey: true, shiftKey: true },
  ];
  for (const c of cases) {
    const { panel } = panelWithSpy();
    panel.setPhase("idle", 0, 0);
    const input = composerInput(panel);
    const { ev, stopped } = composerKey(c);
    input.fire("keydown", ev);
    assert.equal(stopped.value, true, `the event must not reach PDF.js: ${JSON.stringify(c)}`);
  }
});

test("ordinary typing keys are left alone", () => {
  // Stopping the propagation of every key would break the app's own window
  // shortcuts, so only the ones PDF.js actually takes are stopped.
  const { panel } = panelWithSpy();
  panel.setPhase("idle", 0, 0);
  const input = composerInput(panel);
  for (const key of ["a", "Backspace", "ArrowLeft", "Escape", "Tab"]) {
    const { ev, stopped } = composerKey({ key });
    input.fire("keydown", ev);
    if (key === "Backspace") {
      assert.equal(stopped.value, true, "backspace is taken");
    } else {
      assert.equal(stopped.value, false, `${key} must pass through`);
    }
  }
});

test("ctrl+s still reaches the window, so saving a PDF still works", () => {
  // The app saves on Ctrl+S from a window-level listener. Blanket-stopping
  // propagation in the composer would silently break that.
  const { panel } = panelWithSpy();
  panel.setPhase("idle", 0, 0);
  const input = composerInput(panel);
  const { ev, stopped } = composerKey({ key: "s", ctrlKey: true });
  input.fire("keydown", ev);
  assert.equal(stopped.value, false, "ctrl+s must reach the app");
});

/* ------------------- a streaming answer must not rebuild the transcript -- */

/**
 * While an answer was streaming, taking a screenshot was unbearably slow, the
 * screenshot did not appear in the composer, and the "已提取到文字" notice
 * never appeared — all of it showed up at once when the answer ended.
 *
 * The cause was not the screenshot: the main thread was saturated. Every token
 * rebuilt the whole turn and replaced it in the transcript, and the browser then
 * re-laid-out everything, once per token. Anything the reader did in the
 * meantime queued behind that and ran all at the end.
 *
 * So the live turn's text is changed in place: the text node is held, and a
 * token writes to it.
 */
const liveTurn = (content) => ({
  id: "t2",
  role: "assistant",
  content,
  phase: "streaming",
  createdAt: 1,
});

const userTurn = {
  id: "t1",
  role: "user",
  content: "问",
  phase: "completed",
  createdAt: 1,
};

function assistantNode(panel) {
  return panel.root.querySelector(".ai-turn-assistant");
}

test("the streaming turn's node is reused as the text grows", () => {
  const { panel } = panelWithSpy();
  panel.render([userTurn, liveTurn("开头")], "t2");
  const before = assistantNode(panel);
  assert.ok(before, "the turn must be on screen");
  const textBefore = before.textContent;
  assert.ok(textBefore.includes("开头"), textBefore);

  // Another token.
  panel.render([userTurn, liveTurn("开头更长")], "t2");
  const after = assistantNode(panel);
  assert.equal(after, before, "the turn node must be the same object, not a rebuild");
  assert.ok(after.textContent.includes("开头更长"), after.textContent);
});

test("the turn is rebuilt once the answer is finished", () => {
  // The plain-text streaming body is replaced by the markdown body, so the
  // answer is readable once it is complete — and that rebuild is the one place
  // detaching the node is correct.
  const { panel } = panelWithSpy();
  panel.render([userTurn, liveTurn("开头")], "t2");
  const streaming = assistantNode(panel);
  panel.render([userTurn, { ...liveTurn("开头"), phase: "completed" }], "t2");
  const done = assistantNode(panel);
  assert.notEqual(done, streaming, "the finished turn is a different node");
  assert.ok(done.textContent.includes("开头"), done.textContent);
});

test("a turn that is not the live one is not touched by the fast path", () => {
  // The in-place update is for the answer being written. An earlier answer that
  // changed must still be re-rendered.
  const { panel } = panelWithSpy();
  const first = { id: "t1", role: "assistant", content: "旧的", phase: "completed", createdAt: 1 };
  panel.render([first, liveTurn("新")], "t2");
  const before = panel.root.querySelector(".ai-turn-assistant");
  assert.ok(before);
  panel.render([{ ...first, content: "改过的" }, liveTurn("新")], "t2");
  const after = panel.root.querySelector(".ai-turn-assistant");
  assert.ok(after.textContent.includes("改过的"), after.textContent);
});

/* ------------- the model's thinking, shown while it works and then dropped -- */

/**
 * A model that spent two minutes reasoning looked exactly like a model that had
 * hung: the reader saw an empty answer and had no way to tell the two apart.
 *
 * The app knew the difference — the provider streams the thinking separately —
 * and threw it away. Now it is shown while it lasts and dropped the moment the
 * answer starts, so the screen is always either "working" or "here is the
 * answer", never both.
 */
const thinkingTurn = (thinking, content = "") => ({
  id: "t2",
  role: "assistant",
  content,
  thinking: thinking || undefined,
  phase: "streaming",
  createdAt: 1,
});

test("the thinking is shown while there is no answer yet", () => {
  const { panel } = panelWithSpy();
  panel.render([userTurn, thinkingTurn("先确认问题要什么。")], "t2");
  const node = panel.root.querySelector(".ai-thinking");
  assert.ok(node, "the reader must see that the model is working");
  assert.ok(node.textContent.includes("先确认问题要什么"), node.textContent);
});

test("the thinking disappears the moment the answer starts", () => {
  const { panel } = panelWithSpy();
  panel.render([userTurn, thinkingTurn("先确认问题要什么。")], "t2");
  assert.ok(panel.root.querySelector(".ai-thinking"), "it must be there first");

  panel.render([userTurn, thinkingTurn(undefined, "这是答案。")], "t2");
  assert.equal(
    panel.root.querySelector(".ai-thinking"),
    null,
    "the thinking must not stay on screen beside the answer"
  );
  assert.ok(panel.root.textContent.includes("这是答案。"));
});

test("the thinking is never part of the answer text", () => {
  // A reader who copies the answer must not get the model's reasoning with it.
  const { panel } = panelWithSpy();
  panel.render([userTurn, thinkingTurn(undefined, "这是答案。")], "t2");
  const turn = panel.root.querySelector(".ai-turn-assistant");
  assert.ok(!turn.textContent.includes("先确认问题要什么"), turn.textContent);
});

test("only the tail of a long thinking is shown", () => {
  // A reasoning model can emit tens of thousands of characters. This is a
  // progress signal, not something to read.
  const { panel } = panelWithSpy();
  const long = "甲".repeat(5000) + "结尾在这里";
  panel.render([userTurn, thinkingTurn(long)], "t2");
  const node = panel.root.querySelector(".ai-thinking-body");
  assert.ok(node.textContent.includes("结尾在这里"), "the newest part must be visible");
  assert.ok(node.textContent.length < 1200, `shown ${node.textContent.length} chars`);
});
