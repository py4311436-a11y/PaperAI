#!/usr/bin/env node
/**
 * Drive the settings dialog's model picker in a REAL browser.
 *
 * Why this exists: the picker shipped as a `<datalist>`, and Chromium filters a
 * datalist against the input's current value — 46 fetched models rendered as a
 * single entry, and picking from it did not take. No logic test could have
 * caught that: the DOM was correct and the widget was the wrong one. This is the
 * second bug in this project that only exists at the rendering layer, so the
 * check has to happen there too.
 *
 * The dialog is loaded from source (esbuild bundle, served over HTTP so ES
 * modules are not blocked by file:// CORS) with stubbed dependencies — no
 * Tauri, no network, no credential store involved.
 *
 * Usage: node tests/provider-model-picker.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
// The HTTP port is assigned by the kernel (listen on 0) so two runs cannot
// collide; the CDP port is derived from it and the page target is matched on
// URL, so a leftover Edge from a previous run cannot hijack the session.
let PORT = 0;
let CDP_PORT = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  throw new Error("Edge not found");
}

/* -------------------------------------------------------------- test page -- */

/** 46 models, shaped like a real OpenCode catalogue. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>picker</title>
<style>
  body { font: 14px system-ui; margin: 0; padding: 12px; }
  #ai-settings { position: fixed; inset: 0; background: rgba(0,0,0,.4); }
  .ais-card { background: #fff; padding: 16px; width: 620px; }
  .ais-row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .ais-modelrow { display: flex; gap: 8px; align-items: center; }
  .ais-modelrow input { flex: 1 1 auto; min-width: 0; }
  .ais-modelselect { flex: 0 1 auto; min-width: 0; max-width: 320px; }
  .ais-link { flex: 0 0 auto; }
  .ais-note { color: #666; font-size: 12px; }
  .ais-warn { color: #b00; }
</style></head>
<body>
<div id="host"></div>
<script>
// Registered BEFORE the module script so a throw at module top level is
// captured. Without this, "the button is missing" is all the evidence there is.
window.__early = [];
window.addEventListener("error", (e) => window.__early.push(String((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", (e) => window.__early.push("rejection: " + String((e.reason && e.reason.stack) || e.reason)));
</script>
<script type="module">
import { ProviderSettings } from "./provider-settings.js";

const FREE = ["deepseek-v4.1-flash-free", "longcat-2.5-preview-free", "cat-jam-free"];
const INCOMPATIBLE = ["qwen3.8-max", "grok-4.7", "minimax-m3", "claude-haiku-5-5", "gpt-6-luna", "muse-spark-1.3-contributor"];

const models = [];
for (const id of FREE) models.push({ id, compatibility: "unknown", free_hint: true });
for (const id of INCOMPATIBLE) models.push({ id, compatibility: "incompatible", free_hint: false });
for (let i = 0; i < 46 - FREE.length - INCOMPATIBLE.length; i++) {
  models.push({ id: "model-" + String(i).padStart(2, "0"), compatibility: "unknown", free_hint: false });
}

const preset = {
  id: "opencode-zen",
  display_name: "OpenCode Zen（含免费模型）",
  base_url: "https://opencode.ai/zen/v1",
  model: "deepseek-v4.1-flash-free",
  credential_id: "opencode-zen",
  is_default: false,
  sends_session_header: true,
};

const saved = [];
const settings = new ProviderSettings({
  list: async () => [],
  presets: async () => [preset],
  listModels: async () => models,
  save: async (p) => { saved.push({ ...p }); return { ...p, has_key: false, is_loopback_insecure: false }; },
  remove: async () => {},
  setKey: async () => {},
  deleteKey: async () => {},
  test: async () => ({ ok: true, code: "ok", message: "", elapsed_ms: 1, model_echo: null }),
  onChanged: () => {},
});

document.getElementById("host").appendChild(settings.overlay);

window.__t = {
  settings,
  models,
  saved,
  ready: false,
  async boot() {
    try {
      await settings.open();
    } catch (e) {
      // Surface it rather than letting "no preset button" be the only symptom.
      window.__t.bootError = String((e && e.stack) || e);
    }
    // The dialog opens with nothing selected (editing === null renders an empty
    // card), so pick a preset the way a user would. The preset click also kicks
    // off the catalogue fetch.
    const b = document.getElementById("ais-preset-opencode-zen");
    window.__t.ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    if (!b) throw new Error("preset button not rendered");
    b.click();
    window.__t.ready = true;
    return true;
  },
  click(id) { document.getElementById(id).click(); return true; },
  value(id) { const el = document.getElementById(id); return el ? el.value : null; },
  count(id) { return document.getElementById(id)?.options?.length ?? -1; },
  optionTexts(id) {
    return [...(document.getElementById(id)?.options ?? [])].map((o) => o.textContent);
  },
  /** Pick an option the way a user would: set value, fire change. */
  pick(id, value) {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  },
  type(id, value) {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  },
  hint() { return document.getElementById("ais-model-hint")?.textContent ?? null; },
  status() { return document.getElementById("ais-status")?.textContent ?? null; },
};
</script>
</body></html>`;

/* ------------------------------------------------------------------- cdp -- */

async function connectCdp(port, expectUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = (await r.json()).filter((t) => t.type === "page");
      // Match on OUR url. Without this, a leftover Edge from a previous run can
      // still be holding the port, and the run then drives a stale page from a
      // temp directory that no longer exists — which fails in ways that look
      // like application bugs. That happened twice while building this.
      target = pages.find((p) => (p.url ?? "").includes(expectUrl));
      if (target?.webSocketDebuggerUrl) break;
      target = null;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  if (!target) throw new Error(`no page target matching "${expectUrl}" on port ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("websocket error")), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) rej(new Error(`${method} timed out`));
      }, 20000);
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate threw");
    return r.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

/* ------------------------------------------------------------------ main -- */

const results = [];
function record(id, name, ok, note) {
  results.push({ id, name, ok, note });
  console.log(`[${ok ? "PASS" : "FAIL".padEnd(4)}] ${id}  ${name}\n            ${note}`);
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "paperai-picker-"));
  const bundle = await build({
    entryPoints: [path.join(ROOT, "src", "ai", "provider-settings.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "error",
  });
  writeFileSync(path.join(work, "provider-settings.js"), bundle.outputFiles[0].text);
  writeFileSync(path.join(work, "index.html"), PAGE);

  const server = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html";
    const f = path.join(work, name);
    if (!existsSync(f)) {
      res.writeHead(404);
      res.end("no");
      return;
    }
    const ext = path.extname(f);
    res.writeHead(200, {
      "Content-Type": ext === ".html" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
    });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  CDP_PORT = PORT + 1000;

  const edge = spawn(
    findEdge(),
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(work, "profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `http://127.0.0.1:${PORT}/index.html`,
    ],
    { stdio: "ignore" }
  );

  let cdp;
  try {
    cdp = await connectCdp(CDP_PORT, `:${PORT}/`);

    // Wait for the module script to have run before touching it.
    //
    // `connectCdp` returns as soon as a page target with our URL exists, which
    // is *before* `<script type="module">` has finished evaluating — so
    // `window.__t` may still be undefined here. Calling boot() at that moment
    // threw "Cannot read properties of undefined", which looks like an
    // application failure but is only a startup race. (Observed once on a
    // machine with a warm Edge; the run before and the run after both passed.)
    let booted = false;
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate("Boolean(window.__t)")) {
        booted = true;
        break;
      }
      await sleep(250);
    }
    if (!booted) {
      const early = await cdp.evaluate("JSON.stringify(window.__early || [])");
      const probe = await cdp.evaluate(
        "import('/provider-settings.js').then(m => 'loaded ' + Object.keys(m).join(','))" +
          ".catch(e => 'IMPORT FAILED: ' + e)"
      );
      throw new Error(`module never evaluated.\n  module probe = ${probe}\n  early errors = ${early}`);
    }

    // Open the dialog and pick a preset, the way the user does.
    await cdp.evaluate("window.__t.boot()");

    // Wait for the dialog to finish opening.
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate("Boolean(window.__t && window.__t.ready)")) break;
      await sleep(250);
    }
    if (!(await cdp.evaluate("Boolean(window.__t && window.__t.ready)"))) {
      const err = await cdp.evaluate("window.__t && window.__t.bootError");
      const ids = await cdp.evaluate("JSON.stringify((window.__t && window.__t.ids) || null)");
      // Probe the module directly: "no button" is a symptom, not a diagnosis.
      const probe = await cdp.evaluate(
        "import('/provider-settings.js').then(m => 'loaded ' + Object.keys(m).join(','))" +
          ".catch(e => 'IMPORT FAILED: ' + e)"
      );
      const present = await cdp.evaluate(
        "document.querySelectorAll('script').length + ' script tags'"
      );
      const early = await cdp.evaluate("JSON.stringify(window.__early || [])");
      throw new Error(
        `dialog never became ready.\n  bootError = ${err}\n  rendered ids = ${ids}\n` +
          `  module probe = ${probe}\n  page = ${present}\n  early errors = ${early}`
      );
    }

    const N = 46;
    const total = await cdp.evaluate("window.__t.models.length");

    // 1. The dialog opened and the preset applied.
    record(
      "P1",
      "选择预设后基本字段已填充",
      (await cdp.evaluate("window.__t.value('ais-base-url')")) === "https://opencode.ai/zen/v1",
      `base_url=${await cdp.evaluate("window.__t.value('ais-base-url')")}`
    );

    // 2. The catalogue fetch (triggered by picking the preset) must land.
    for (let i = 0; i < 40; i++) {
      if ((await cdp.evaluate("window.__t.count('ais-model-select')")) > 2) break;
      await sleep(200);
    }
    const after = await cdp.evaluate("window.__t.count('ais-model-select')");
    const texts = await cdp.evaluate("window.__t.optionTexts('ais-model-select')");
    record(
      "P2",
      `下拉框列出全部 ${N} 个模型`,
      after === N + 2,
      `options=${after}（${N} 个模型 + 占位 + 手动输入），预期 ${N + 2}`
    );

    // 2b. THE assertion that matters, and the one no logic test can make.
    //
    // A `<datalist>` also exposes `.options` and accepts `.value`, so counting
    // options and reading `.value` PASS on a datalist too — verified by
    // reverting the fix and watching this suite go 9/9 green on the broken
    // widget. What actually differs in a browser:
    //   - it is a `<select>`, not a suggestion list; and
    //   - it occupies real space on screen. Chromium renders a datalist as a
    //     popup filtered against the input's current value, which is exactly
    //     why 46 models showed as one and why picking did not take.
    const shape = await cdp.evaluate(`(() => {
      const el = document.getElementById('ais-model-select');
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    record(
      "P2b",
      "模型选择器是真正可见的 <select>，而非 datalist 建议框",
      shape.tag === "SELECT" && shape.w > 0 && shape.h > 0,
      `tagName=${shape.tag}  渲染尺寸=${shape.w}x${shape.h}`
    );
    record(
      "P3",
      "占位项说明列表已加载，且提供「手动输入」出口",
      texts[0].includes(`从 ${N} 个模型中选择`) && texts[1].includes("手动输入"),
      `${texts[0]} / ${texts[1]}`
    );

    // 4. Picking an option must actually change the value. THE reported bug.
    const target = "model-07";
    const selValue = await cdp.evaluate(`window.__t.pick('ais-model-select', ${JSON.stringify(target)})`);
    const inputValue = await cdp.evaluate("window.__t.value('ais-model')");
    record(
      "P4",
      "选择下拉项后输入框同步更新（这是被报的那个 bug）",
      selValue === target && inputValue === target,
      `select=${selValue} input=${inputValue}，预期都是 ${target}`
    );

    // 5. And the picked value must reach what gets saved, not just the DOM.
    await cdp.evaluate("window.__t.click('ais-save')");
    await sleep(300);
    const savedModel = await cdp.evaluate("window.__t.saved.at(-1)?.model ?? null");
    record("P5", "选中的模型真正进入保存的数据", savedModel === target, `save() 收到 model=${savedModel}`);

    // 6. Free models are marked, so the cheap ones are findable.
    const freeMarked = texts.some((t) => t.includes("deepseek-v4.1-flash-free") && t.includes("可能免费"));
    record("P6", "免费模型在列表中有标记", freeMarked, texts.find((t) => t.includes("flash-free")) ?? "(未找到)");

    // 7. An incompatible model warns BEFORE any request is attempted.
    await cdp.evaluate(`window.__t.pick('ais-model-select', 'qwen3.8-max')`);
    await sleep(200);
    const hint = await cdp.evaluate("window.__t.hint()");
    record(
      "P7",
      "选择其它协议的模型时给出警告",
      // Match the substantive claim, not incidental wording: the warning must
      // name the model and the one protocol we do speak.
      typeof hint === "string" &&
        hint.includes("qwen3.8-max") &&
        hint.includes("/chat/completions"),
      `hint="${hint}"`
    );

    // 8. Typing wins over the dropdown, and the dropdown admits it.
    await cdp.evaluate(`window.__t.type('ais-model', 'my-own-model')`);
    await sleep(200);
    const afterTyping = await cdp.evaluate("window.__t.value('ais-model-select')");
    record(
      "P8",
      "手动输入后下拉框回到「手动输入」而不是留下过期高亮",
      afterTyping === "__manual__",
      `select=${afterTyping}，预期 __manual__`
    );

    // 9. Re-rendering must not lose the list (the dialog rebuilds its card).
    await cdp.evaluate("window.__t.click('ais-preset-opencode-zen')");
    await sleep(300);
    const afterRerender = await cdp.evaluate("window.__t.count('ais-model-select')");
    record(
      "P9",
      "重新渲染后模型列表仍在（不会变回空下拉）",
      afterRerender >= 2,
      `options=${afterRerender}`
    );

    console.log("");
    console.log(`模型总数断言基准: ${total}`);
  } finally {
    try {
      cdp?.close();
    } catch {
      /* already gone */
    }
    edge.kill();
    // Edge keeps a lock on the profile for a moment after SIGTERM; the temp
    // directory is disposable either way, so a failed cleanup must not turn a
    // green run red.
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(work, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
    server.close();
  }

  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} PASS`);
  const out = path.join(ROOT, "evidence", "ai-tests");
  writeFileSync(
    path.join(out, "provider-model-picker.txt"),
    [
      `Provider model picker — real Chromium`,
      `Generated: ${new Date().toISOString()}`,
      "",
      ...results.map((r) => `[${r.ok ? "PASS" : "FAIL"}] ${r.id} ${r.name}\n    ${r.note}`),
      "",
      `${results.length - bad}/${results.length} PASS`,
    ].join("\n"),
    "utf8"
  );
  console.log(`evidence in evidence/ai-tests/provider-model-picker.txt`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error("provider-model-picker failed:", e);
  process.exit(2);
});