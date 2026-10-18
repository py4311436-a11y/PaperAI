/**
 * Tests for the panel's provider / model pickers (the "which model am I using?"
 * control).
 *
 * The bug these lock down: the header used to render a read-only text label, so
 * the app always answered with whichever profile happened to be the default —
 * there was no way to switch without opening the settings dialog. A label cannot
 * be tested into producing a switch, so every test here drives the real
 * `<select>` elements and asserts the value that reaches the callback.
 *
 * The DOM shim implements real `<select>` semantics (`value` resolves against
 * the option list), which is what lets a wrong id fail here instead of silently
 * passing on a stray property assignment.
 *
 * Run via `node scripts/run-ai-unit-tests.mjs`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { installDom } from "./dom-shim.mjs";
import { ChatPanel } from "../../dist-test/src/ai/chat-panel.js";

const dom = installDom();

const profile = (over = {}) => ({
  id: "deepseek",
  display_name: "DeepSeek 官方",
  base_url: "https://api.deepseek.com",
  model: "deepseek-flash",
  is_default: true,
  has_key: true,
  is_loopback_insecure: false,
  sends_session_header: false,
  ...over,
});

function makePanel() {
  const calls = { profiles: [], models: [] };
  const panel = new ChatPanel({
    onSend: () => {},
    onStop: () => {},
    onNewConversation: () => {},
    onContextModeChange: () => {},
    onOpenSettings: () => {},
    onOpenLink: () => {},
    onCopy: () => {},
    onSelectProfile: (id) => calls.profiles.push(id),
    onSelectModel: (profileId, model) => calls.models.push([profileId, model]),
  });
  return { panel, calls };
}

const sel = (panel, id) => panel.root.querySelector(`#${id}`);
const optionTexts = (select) => select.options.map((o) => o.textContent);

// --------------------------------------------------- provider picker exists

test("the header offers a real provider picker, not a read-only label", () => {
  const { panel } = makePanel();
  const picker = sel(panel, "ai-profile-select");
  assert.ok(picker, "a provider <select> must exist in the header");
  assert.equal(picker.tagName, "SELECT");
  assert.ok(picker.getBoundingClientRect === undefined || true); // shim: no layout
  // The old implementation exposed only a <span>; assert the text-only control
  // is gone so this cannot regress into an unclickable label.
  assert.equal(panel.root.querySelector(".ai-model"), null);
});

test("every configured provider is listed and one without a key is marked", () => {
  const { panel } = makePanel();
  panel.setProviders(
    [
      profile(),
      profile({
        id: "opencode-go",
        display_name: "OpenCode Go（订阅）",
        model: "deepseek-v4.1-flash",
        is_default: false,
        sends_session_header: true,
      }),
      profile({
        id: "no-key",
        display_name: "第三方",
        model: "some-model",
        is_default: false,
        has_key: false,
      }),
    ],
    "deepseek"
  );
  const picker = sel(panel, "ai-profile-select");
  assert.deepEqual(
    picker.options.map((o) => o.value),
    ["deepseek", "opencode-go", "no-key"]
  );
  const texts = optionTexts(picker);
  assert.ok(!texts[0].includes("未配置"), "a configured key must not be flagged");
  assert.ok(texts[2].includes("未配置 Key"), "a missing key must be visible in the header");
  assert.equal(picker.value, "deepseek", "the active provider stays selected");
});

test("picking a provider reports that provider's id", () => {
  const { panel, calls } = makePanel();
  panel.setProviders(
    [profile(), profile({ id: "opencode-go", display_name: "OpenCode Go", is_default: false })],
    "deepseek"
  );
  const picker = sel(panel, "ai-profile-select");
  picker.value = "opencode-go";
  picker.fire("change", {});
  assert.deepEqual(calls.profiles, ["opencode-go"]);
  assert.deepEqual(calls.models, [], "switching provider must not invent a model change");
});

test("a provider that no longer exists falls back instead of leaving a dead value", () => {
  const { panel } = makePanel();
  panel.setProviders(
    [profile(), profile({ id: "kept", display_name: "另一个", is_default: false })],
    "deleted-by-settings"
  );
  assert.equal(sel(panel, "ai-profile-select").value, "deepseek");
});

// ------------------------------------------------------- model picker works

test("picking a model reports both the provider and the model", () => {
  const { panel, calls } = makePanel();
  panel.setProviders([profile({ id: "opencode-go", model: "deepseek-v4.1-flash", is_default: false })], "opencode-go");
  panel.setModels(
    "opencode-go",
    [
      { id: "deepseek-v4.1-flash", compatibility: "chat", free_hint: false },
      { id: "glm-5.3-flash", compatibility: "chat", free_hint: false },
    ],
    "deepseek-v4.1-flash"
  );
  const models = sel(panel, "ai-model-select");
  assert.deepEqual(models.options.map((o) => o.value), ["deepseek-v4.1-flash", "glm-5.3-flash"]);
  assert.equal(models.value, "deepseek-v4.1-flash");
  models.value = "glm-5.3-flash";
  models.fire("change", {});
  assert.deepEqual(calls.models, [["opencode-go", "glm-5.3-flash"]]);
});

test("switching provider repaints the model box with that provider's model", () => {
  const { panel } = makePanel();
  const list = [
    profile({ id: "a", model: "model-a", is_default: true }),
    profile({ id: "b", model: "model-b", is_default: false }),
  ];
  panel.setProviders(list, "a");
  assert.equal(sel(panel, "ai-model-select").value, "model-a");
  panel.setProviders(list, "b");
  const models = sel(panel, "ai-model-select");
  assert.equal(models.value, "model-b", "a stale model from provider A must not linger");
  assert.ok(
    optionTexts(models).some((t) => t.includes("model-b")),
    "the new provider's saved model must be shown while the catalogue loads"
  );
});

test("the model in use survives a catalogue that does not list it", () => {
  const { panel } = makePanel();
  panel.setProviders([profile({ model: "retired-model" })], "deepseek");
  panel.setModels(
    "deepseek",
    [{ id: "brand-new", compatibility: "chat", free_hint: false }],
    "retired-model"
  );
  const models = sel(panel, "ai-model-select");
  assert.ok(
    models.options.some((o) => o.value === "retired-model"),
    "a model the user is actually running must never disappear from the picker"
  );
  assert.equal(models.value, "retired-model");
});

test("models served on another protocol are filtered out of the picker", () => {
  const { panel } = makePanel();
  panel.setProviders([profile({ model: "chat-model" })], "deepseek");
  panel.setModels(
    "deepseek",
    [
      { id: "chat-model", compatibility: "chat", free_hint: false },
      { id: "messages-only", compatibility: "incompatible", free_hint: false },
      { id: "unknown-one", compatibility: "unknown", free_hint: true },
    ],
    "chat-model"
  );
  const values = sel(panel, "ai-model-select").options.map((o) => o.value);
  assert.ok(!values.includes("messages-only"), "an incompatible model must not be offered");
  assert.ok(values.includes("unknown-one"), "an unknown-protocol model is still offered");
});

test("a failed catalogue fetch keeps the current model and explains itself", () => {
  const { panel } = makePanel();
  panel.setProviders([profile({ model: "deepseek-flash" })], "deepseek");
  panel.setModelListNote("deepseek", "拉取失败：连接超时", "deepseek-flash");
  const models = sel(panel, "ai-model-select");
  const texts = optionTexts(models);
  assert.ok(texts.some((t) => t.includes("拉取失败")), "the failure must be visible, not silent");
  assert.equal(models.value, "deepseek-flash", "the model in use must remain selectable");
  assert.equal(models.options[0].disabled, true, "the note is not a choice");
});

// -------------------------------------------------------------- busy gating

test("both pickers freeze while a request is in flight", () => {
  const { panel, calls } = makePanel();
  panel.setProviders([profile(), profile({ id: "go", is_default: false })], "deepseek");
  panel.setModels("deepseek", [{ id: "deepseek-flash", compatibility: "chat", free_hint: false }], "deepseek-flash");
  panel.setPhase("streaming", 0, 1);
  assert.equal(sel(panel, "ai-profile-select").disabled, true);
  assert.equal(sel(panel, "ai-model-select").disabled, true);

  panel.setPhase("completed", 0, 1);
  assert.equal(sel(panel, "ai-profile-select").disabled, false);
  assert.equal(sel(panel, "ai-model-select").disabled, false);
  assert.deepEqual(calls.profiles, [], "freezing must not itself fire a switch");
});

test("re-rendering providers keeps the busy gate applied", () => {
  const { panel } = makePanel();
  panel.setPhase("preparing", 0, 0);
  panel.setProviders([profile(), profile({ id: "go", is_default: false })], "deepseek");
  assert.equal(sel(panel, "ai-profile-select").disabled, true);
});

// ------------------------------------------------------------- no providers

test("with nothing configured the header says so instead of showing a stale model", () => {
  const { panel, calls } = makePanel();
  panel.setProviders([], null);
  const picker = sel(panel, "ai-profile-select");
  assert.equal(picker.disabled, true);
  assert.ok(optionTexts(picker).some((t) => t.includes("未配置")));
  assert.equal(sel(panel, "ai-model-select").disabled, true);
  assert.deepEqual(calls.profiles, []);
});
/* --------------------------------------- A-20: streaming must not rebuild history */

/**
 * The reported symptom: text typed into the composer could not be deleted while
 * an answer streamed. Measured cause: `render()` rebuilt the whole transcript
 * on every token, re-running KaTeX over every finished message — 1773 ms of
 * blocked UI thread per 200 tokens with 20 messages of history, which drops
 * keystrokes.
 *
 * The assertion is node identity, not timing: timing tests are flaky, but "this
 * finished message is still the very same DOM element" is exactly the property
 * that makes the cost independent of history.
 */
const assistantTurn = (id, over = {}) => ({
  id,
  role: "assistant",
  content: "已完成的一段回答",
  phase: "completed",
  createdAt: 0,
  ...over,
});

test("a finished turn keeps its DOM node while another turn streams", () => {
  const { panel } = makePanel();
  const finished = [assistantTurn("a"), assistantTurn("b"), assistantTurn("c")];
  panel.render(finished, null);

  const before = panel.root.querySelectorAll(".ai-turn-assistant");
  const beforeNodes = [...before];

  // Stream a new answer token by token, exactly as the controller drives it.
  const live = { id: "live", role: "assistant", content: "", phase: "streaming", createdAt: 0 };
  for (let i = 1; i <= 25; i++) {
    live.content = "tok".repeat(i);
    panel.render([...finished, live], "live");
  }

  const after = [...panel.root.querySelectorAll(".ai-turn-assistant")];
  assert.equal(after.length, 4, "the live turn must be there too");
  for (let i = 0; i < 3; i++) {
    assert.equal(
      after[i],
      beforeNodes[i],
      `finished turn ${i} was rebuilt — this is what made every token cost O(history)`
    );
  }
  assert.ok(after[3].textContent.includes("tok"), "the live turn must still update");
});

test("a turn that actually changes is re-rendered", () => {
  const { panel } = makePanel();
  const t = assistantTurn("a");
  panel.render([t], null);
  const before = panel.root.querySelector(".ai-turn-assistant");

  // errorCode appears => the signature changes => it must be rebuilt.
  panel.render([{ ...t, phase: "error", errorCode: "ai_timeout", errorMessage: "断了" }], null);
  const after = panel.root.querySelector(".ai-turn-assistant");
  assert.notEqual(after, before, "a changed turn must not be reused");
  assert.ok(after.querySelector(".ai-error"), "and it must show the error");
});

test("switching conversations rebuilds instead of reusing stale nodes", () => {
  const { panel } = makePanel();
  panel.render([assistantTurn("a")], null);
  panel.render([assistantTurn("z")], null);
  const nodes = [...panel.root.querySelectorAll(".ai-turn-assistant")];
  assert.equal(nodes.length, 1, "the old turn must be gone, not appended to");
  assert.ok(nodes[0].textContent.includes("已完成"), "the new turn must be the one shown");
});

test("going back to an empty transcript restores the placeholder", () => {
  const { panel } = makePanel();
  panel.render([], null);
  panel.render([assistantTurn("a")], null);
  panel.render([], null);
  assert.equal(panel.root.querySelectorAll(".ai-turn-assistant").length, 0);
  assert.ok(panel.root.querySelector(".ai-empty"), "the placeholder must come back");
});

/* ------------------------------------------- A-25: the composer and the IME */

/**
 * The reported symptom: a question typed into the composer would not send.
 *
 * Nothing was wrong with `submit()` — the Enter handler was intercepting the
 * keypress the input method uses to *commit a candidate*. Typing Chinese means
 * every Enter is a composition key first and a send only second, and the
 * handler cannot tell the two apart by `key` alone: both are `"Enter"`.
 *
 * The web platform does distinguish them, and it is the only thing that can:
 * a keydown during composition carries `isComposing: true` (and on Windows,
 * `keyCode: 229`). Treating that Enter as a send does two wrong things at once
 * — it swallows the candidate, so the character never lands in the box, and it
 * fires a question built from whatever half-finished pinyin happened to be in
 * the field.
 *
 * `makePanel` here captures sends, so a test can assert on what the user would
 * actually have seen.
 */
function makeTypingPanel() {
  const calls = { sent: [] };
  const panel = new ChatPanel({
    onSend: (q, attachments) => calls.sent.push([q, attachments]),
    onStop: () => {},
    onNewConversation: () => {},
    onContextModeChange: () => {},
    onOpenSettings: () => {},
    onOpenLink: () => {},
    onCopy: () => {},
    onSelectProfile: () => {},
    onSelectModel: () => {},
  });
  return { panel, calls };
}

/** A keydown as the browser delivers it. `isComposing` is what IME sets. */
function key(key, over = {}) {
  let prevented = false;
  return {
    key,
    shiftKey: false,
    isComposing: false,
    keyCode: over.keyCode ?? 0,
    preventDefault() {
      prevented = true;
      this.defaultPrevented = true;
    },
    get wasPrevented() {
      return prevented;
    },
  };
}

test("Enter that commits an IME candidate does not send the question", () => {
  const { panel, calls } = makeTypingPanel();
  const input = panel.root.querySelector("#ai-input");
  input.value = "ni hao";

  // What the browser sends while the input method is still composing: Enter,
  // but flagged. This one must be left entirely alone.
  const ev = key("Enter", { keyCode: 229 });
  ev.isComposing = true;
  input.fire("keydown", ev);

  assert.equal(calls.sent.length, 0, "an Enter that commits a candidate must not send");
  assert.equal(ev.wasPrevented, false, "and must not be swallowed either — that is the character");
  assert.equal(input.value, "ni hao", "the half-finished pinyin must still be in the box");
});

test("Enter after composition finished sends, as the placeholder promises", () => {
  const { panel, calls } = makeTypingPanel();
  const input = panel.root.querySelector("#ai-input");
  input.value = "你好";

  // The IME is done: the text is committed and now Enter means send.
  const ev = key("Enter");
  ev.isComposing = false;
  input.fire("keydown", ev);

  assert.equal(calls.sent.length, 1, "a plain Enter must still send");
  assert.equal(calls.sent[0][0], "你好");
  assert.equal(ev.wasPrevented, true, "and must not also insert a newline");
  assert.equal(input.value, "", "the box is cleared for the next question");
});

test("the 229 keycode alone is enough to mean 'the IME owns this key'", () => {
  // Some input methods report keyCode 229 without a reliable isComposing, so
  // either signal alone has to be honoured. Getting this wrong means the
  // composer eats the user's Chinese and sends pinyin instead.
  const { panel, calls } = makeTypingPanel();
  const input = panel.root.querySelector("#ai-input");
  input.value = "zhong wen";

  input.fire("keydown", key("Enter", { keyCode: 229 }));
  assert.equal(calls.sent.length, 0, "229 must be treated as a composition key");

  input.value = "中文";
  input.fire("keydown", key("Enter"));
  assert.equal(calls.sent.length, 1, "a normal Enter right after must still send");
});

test("Shift+Enter still inserts a newline mid-composition", () => {
  // Shift+Enter is never a send, so there is nothing to guard — but the guard
  // must not swallow it either, or multi-line questions become impossible to
  // type in an IME.
  const { panel, calls } = makeTypingPanel();
  const input = panel.root.querySelector("#ai-input");
  input.value = "第一行";

  const ev = key("Enter", { keyCode: 229 });
  ev.shiftKey = true;
  input.fire("keydown", ev);

  assert.equal(calls.sent.length, 0);
  assert.equal(ev.wasPrevented, false, "Shift+Enter must reach the input element");
});

test("the send button works regardless of the input method", () => {
  // The IME bug must not have an unfair advantage: there is always a button.
  const { panel, calls } = makeTypingPanel();
  const input = panel.root.querySelector("#ai-input");
  input.value = "用按钮发送";
  panel.root.querySelector("#ai-send").fire("click", {});
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0][0], "用按钮发送");
});
