#!/usr/bin/env node
/**
 * Drive the AI panel's provider/model pickers in a REAL browser.
 *
 * Why this exists: the panel header used to be a read-only text label, so the
 * app always answered with whichever profile was the default — the reported
 * symptom was "为什么这里一直都是 DeepSeek", with no way to switch without
 * opening the settings dialog. This project has already been bitten twice by
 * bugs that only exist at the rendering layer (the `<datalist>` picker, the
 * `[hidden]` overlays), where the DOM was right and the widget was wrong. So
 * these checks happen in a real layout, with the real stylesheet, and assert
 * rendered geometry — a control that occupies zero pixels cannot be used no
 * matter what its `.options` says.
 *
 * The panel is loaded from source (esbuild bundle, served over HTTP so ES
 * modules are not blocked by file:// CORS) with stubbed callbacks — no Tauri, no
 * network, no credential store involved.
 *
 * Usage: node tests/panel-model-switch.mjs
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
let PORT = 0;
let CDP_PORT = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  throw new Error("Edge not found");
}

/* -------------------------------------------------------------- test page -- */

/** The catalogue shape the user actually has: 47 models on OpenCode Zen. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>panel pickers</title>
<style>
  /* The app's own panel stylesheet, inlined: geometry assertions must be made
     against the styles that ship, not a convenient substitute. */
  __PANEL_CSS__
  html, body { margin: 0; font: 13px system-ui, "Microsoft YaHei", sans-serif; }
  body { display: flex; height: 100vh; }
  #stub { flex: 1 1 auto; background: #eef; }
</style></head>
<body>
<div id="stub"></div>
<script>
// Registered BEFORE the module script so a throw at module top level is
// captured. Without this, "the picker is missing" is all the evidence there is.
window.__early = [];
window.addEventListener("error", (e) => window.__early.push(String((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", (e) => window.__early.push("rejection: " + String((e.reason && e.reason.stack) || e.reason)));
</script>
<script type="module">
import { ChatPanel } from "./chat-panel.js";

const N = 47;
const models = [];
for (let i = 0; i < N; i++) {
  models.push({ id: "zen-model-" + String(i).padStart(2, "0"), compatibility: i === 3 ? "incompatible" : "chat", free_hint: i % 7 === 0 });
}

const profiles = [
  { id: "deepseek", display_name: "DeepSeek（升级前配置）", base_url: "https://api.deepseek.com", model: "deepseek-flash", is_default: true, has_key: true, is_loopback_insecure: false, sends_session_header: false },
  { id: "opencode-go", display_name: "OpenCode Go（订阅）", base_url: "https://opencode.ai/inference/go/v1", model: "deepseek-v4.1-flash", is_default: false, has_key: true, is_loopback_insecure: false, sends_session_header: true },
  { id: "opencode-zen", display_name: "OpenCode Zen（含免费模型）", base_url: "https://opencode.ai/zen/v1", model: "deepseek-v4.1-flash-free", is_default: false, has_key: false, is_loopback_insecure: false, sends_session_header: true },
];

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
document.body.appendChild(panel.root);
panel.show();

const $ = (id) => document.getElementById(id);
window.__t = {
  panel,
  profiles,
  models,
  calls,
  ready: false,
  boot() {
    panel.setProviders(profiles, "deepseek");
    panel.setModels("deepseek", models, "deepseek-flash");
    window.__t.ready = true;
    return true;
  },
  pick(id, value) {
    const el = $(id);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  },
  shape(id) {
    const el = $(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height), disabled: el.disabled };
  },
  value(id) { const el = $(id); return el ? el.value : null; },
  count(id) { return $(id)?.options?.length ?? -1; },
  optionTexts(id) { return [...($(id)?.options ?? [])].map((o) => o.textContent); },
  /** Header must not spill outside the panel. */
  headerOverflow() {
    const h = document.querySelector(".ai-header");
    const p = $("ai-panel");
    return { header: h.scrollWidth, headerClient: h.clientWidth, panel: p.clientWidth, panelScroll: p.scrollWidth };
  },
  applyProfile(id) {
    // Mirrors main.ts: the callback re-paints with the new provider.
    panel.setProviders(profiles, id);
    const p = profiles.find((x) => x.id === id);
    panel.setModels(id, models, p.model);
  },
  busy(phase) { panel.setPhase(phase, 0, 1); },
};
window.__t.boot();
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
      // Match on OUR url: a leftover Edge from a previous run can still be
      // holding the port, and the run then drives a stale page.
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
  const work = mkdtempSync(path.join(tmpdir(), "paperai-panel-"));
  const bundle = await build({
    entryPoints: [path.join(ROOT, "src", "ai", "chat-panel.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "error",
  });
  writeFileSync(path.join(work, "chat-panel.js"), bundle.outputFiles[0].text);
  const css = readFileSync(path.join(ROOT, "src", "ai", "style.css"), "utf8");
  writeFileSync(path.join(work, "index.html"), PAGE.replace("__PANEL_CSS__", css));

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
    for (let i = 0; i < 60; i++) {
      if (await cdp.evaluate("Boolean(window.__t && window.__t.ready)")) break;
      await sleep(250);
    }
    if (!(await cdp.evaluate("Boolean(window.__t && window.__t.ready)"))) {
      const err = await cdp.evaluate("window.__early ? JSON.stringify(window.__early) : 'no page'");
      throw new Error(`panel never became ready.\n  early errors = ${err}`);
    }

    // 1. The header carries two real, visible <select> elements. The old build
    //    had neither, so this fails on it by construction.
    //
    //    Verified by negative control: putting the old read-only <span> back
    //    makes Q1 and Q2 fail (`tag=SPAN`, `options=-1`) and Q5 abort. Note that
    //    Q3/Q4 still pass in that build — a <span> accepts an assigned `.value`
    //    and still fires `change` — so the tag/geometry assertions are what
    //    actually pin the control, exactly as in the datalist round before.
    const prov = await cdp.evaluate("JSON.stringify(window.__t.shape('ai-profile-select'))");
    const mod = await cdp.evaluate("JSON.stringify(window.__t.shape('ai-model-select'))");
    const p = JSON.parse(prov);
    const m = JSON.parse(mod);
    record(
      "Q1",
      "头部有 Provider 与模型两个下拉框",
      p?.tag === "SELECT" && m?.tag === "SELECT" && p.w > 0 && p.h > 0 && m.w > 0 && m.h > 0,
      `provider=${prov}  model=${mod}`
    );

    // 2. All providers are listed; the one without a key says so.
    const provCount = await cdp.evaluate("window.__t.count('ai-profile-select')");
    const provTexts = await cdp.evaluate("window.__t.optionTexts('ai-profile-select')");
    record(
      "Q2",
      "三个 Provider 都在头部列出，未配置 Key 的有标记",
      provCount === 3 && provTexts[2].includes("未配置 Key") && !provTexts[0].includes("未配置"),
      `options=${provCount}  ${JSON.stringify(provTexts)}`
    );

    // 3. Picking a provider fires the callback — the reported inability to
    //    change anything, asserted against a real change event.
    const pickedProv = await cdp.evaluate("window.__t.pick('ai-profile-select', 'opencode-go')");
    const provCalls = await cdp.evaluate("JSON.stringify(window.__t.calls.profiles)");
    record(
      "Q3",
      "在头部切换 Provider 会真正上报（这是被报的问题）",
      pickedProv === "opencode-go" && JSON.parse(provCalls).includes("opencode-go"),
      `select=${pickedProv} 回调收到=${provCalls}`
    );

    // 4. And the panel repaints to the new provider's model.
    await cdp.evaluate("window.__t.applyProfile('opencode-go')");
    await sleep(150);
    const modValue = await cdp.evaluate("window.__t.value('ai-model-select')");
    record(
      "Q4",
      "切换后模型框显示新 Provider 的模型",
      modValue === "deepseek-v4.1-flash",
      `model select=${modValue}，预期 deepseek-v4.1-flash`
    );

    // 5. The real catalogue renders, minus the one incompatible model, plus
    //    the model actually in use (Go's model is not in Zen's catalogue, and a
    //    model in use must never disappear from the picker).
    const modCount = await cdp.evaluate("window.__t.count('ai-model-select')");
    const modValues = await cdp.evaluate(
      "JSON.stringify([...(document.getElementById('ai-model-select')?.options ?? [])].map(o => o.value))"
    );
    const values = JSON.parse(modValues);
    record(
      "Q5",
      "47 个模型进入下拉框：46 个可用 + 当前模型，协议不兼容的被排除",
      modCount === 47 && !values.includes("zen-model-03") && values.includes("deepseek-v4.1-flash"),
      `options=${modCount}（46 可用 + 1 当前），zen-model-03 是否出现=${values.includes("zen-model-03")}`
    );

    // 6. Picking a model reports provider + model.
    const target = "zen-model-11";
    const pickedModel = await cdp.evaluate(`window.__t.pick('ai-model-select', ${JSON.stringify(target)})`);
    const modCalls = await cdp.evaluate("JSON.stringify(window.__t.calls.models)");
    const lastCall = JSON.parse(modCalls).at(-1);
    record(
      "Q6",
      "选择模型会上报 providerId 与 model",
      pickedModel === target && Array.isArray(lastCall) && lastCall[0] === "opencode-go" && lastCall[1] === target,
      `select=${pickedModel} 回调收到=${modCalls}`
    );

    // 7. Free models stay marked, so the cheap ones are findable here too.
    const freeMarked = await cdp.evaluate(
      "window.__t.optionTexts('ai-model-select').filter(t => t.includes('可能免费')).length"
    );
    record("Q7", "免费模型在面板下拉中也有标记", Number(freeMarked) === 7, `标记数量=${freeMarked}`);

    // 8. Busy freezes both controls.
    await cdp.evaluate("window.__t.busy('streaming')");
    await sleep(120);
    const busyProv = await cdp.evaluate("JSON.stringify(window.__t.shape('ai-profile-select'))");
    const busyMod = await cdp.evaluate("JSON.stringify(window.__t.shape('ai-model-select'))");
    record(
      "Q8",
      "生成中两个下拉框都被冻结",
      JSON.parse(busyProv).disabled === true && JSON.parse(busyMod).disabled === true,
      `provider=${busyProv}  model=${busyMod}`
    );

    // 9. Layout: two pickers plus three buttons must fit a 380px panel.
    const ov = JSON.parse(await cdp.evaluate("JSON.stringify(window.__t.headerOverflow())"));
    record(
      "Q9",
      "头部在 380px 面板内不横向溢出",
      ov.header <= ov.headerClient + 1 && ov.panelScroll <= ov.panel + 1,
      `header scrollWidth=${ov.header} clientWidth=${ov.headerClient}；panel scrollWidth=${ov.panelScroll} clientWidth=${ov.panel}`
    );

    console.log("");
  } finally {
    try {
      cdp?.close();
    } catch {
      /* already gone */
    }
    edge.kill();
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
    path.join(out, "panel-model-switch.txt"),
    [
      `AI panel provider/model pickers — real Chromium`,
      `Generated: ${new Date().toISOString()}`,
      "",
      ...results.map((r) => `[${r.ok ? "PASS" : "FAIL"}] ${r.id} ${r.name}\n    ${r.note}`),
      "",
      `${results.length - bad}/${results.length} PASS`,
    ].join("\n"),
    "utf8"
  );
  console.log(`evidence in evidence/ai-tests/panel-model-switch.txt`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error("panel-model-switch failed:", e);
  process.exit(2);
});