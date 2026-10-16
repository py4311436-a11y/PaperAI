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