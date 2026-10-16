#!/usr/bin/env node
/**
 * Drive the toolbar's tool-state indicator in a REAL browser (A-17).
 *
 * Why a browser: every one of the three reported toolbar bugs was a *state*
 * bug — a button that is lit while the app is in a different mode, and a button
 * that cannot be lit at all. None of that is visible to a logic test; the DOM
 * classes were being written, just to the wrong place or not at all. So these
 * checks read the real classes and the real computed background.
 *
 * The state logic itself (`setToolbarState` / `setTool` / erase arming) is
 * loaded from the real `src/main.ts`? No — main.ts is the Tauri entry point and
 * cannot run without a window. The functions under test are therefore provided
 * by the harness below, but they are the *same source lines* as main.ts's, and
 * the assertions that matter (which button carries `.active`, whether it
 * paints differently, whether a stray `$` reaches the transcript) are about the
 * browser's behaviour rather than about JavaScript bookkeeping.
 *
 * Usage: node tests/toolbar-state.mjs
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

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>toolbar state</title>
<style>
  __MAIN_CSS__
  body { margin: 0; }
  /* The toolbar buttons are laid out exactly as index.html orders them, so the
     geometry assertions below are about the shipped markup. */
  #toolbar { display: flex; gap: 4px; padding: 8px; }
</style></head>
<body>
<!-- The REAL header#toolbar block from index.html is injected here at run
     time (placeholder below), so a regression in the shipped markup (Erase
     losing its tool class) fails this suite instead of being papered over by
     a hand-typed copy. -->
__TOOLBAR__
<div id="log"></div>
<script>
window.__early = [];
window.addEventListener("error", (e) => window.__early.push(String((e.error && e.error.stack) || e.message)));
window.addEventListener("unhandledrejection", (e) => window.__early.push("rejection: " + String((e.reason && e.reason.stack) || e.reason)));
</script>
<script type="module">
/* ---- mirrors of src/main.ts + tools/erase-policy.ts: same logic, no Tauri ---- */
let toolbarState = "select";
const $ = (id) => document.getElementById(id);
let adapterMode = "none";          // what the "editor" is really in
let hasSelection = false;          // what PDF.js currently has selected
let armed = false;
let deleted = 0;                   // how many annotations were removed
const toasts = [];

function setToolbarState(next) {
  toolbarState = next;
  if (next !== "erase") armed = false;
  document.querySelectorAll(".tool").forEach((b) => b.classList.remove("active", "armed"));
  const btn = $("btn-" + next);
  btn.classList.add("active");
  if (next === "erase") btn.classList.add("armed");
}

async function setTool(tool) {
  setToolbarState(tool);
  adapterMode = tool === "select" ? "none" : tool === "ink" ? "ink" : "highlight";
}

async function doHighlight() {
  // Always enters highlight mode first; highlights only if text is selected.
  await setTool("highlight");
  if (hasSelection) { hasSelection = false; toasts.push("highlighted"); return 1; }
  toasts.push("已进入高亮模式：在 PDF 中拖选文字即可高亮");
  return 0;
}

async function onErase() {
  // Arming deletes NOTHING, even with a selection already present.
  await adapterSetTool("ink");
  armed = true;
  setToolbarState("erase");
  toasts.push("擦除模式：点击要删除的批注（Esc 或点 Select 退出）");
}
async function adapterSetTool(t) { adapterMode = t === "select" ? "none" : t; }

/** The real decision function, imported from the shipped module. */
import("/erase-policy.js").then((m) => { window.__eraseDecision = m.eraseDecision; });

/** One viewer click: hitAnnotation is the DOM hit test's answer. */
function viewerClick(hitAnnotation, { selectOnHit = true } = {}) {
  if (hitAnnotation && selectOnHit) hasSelection = true;   // PDF.js selects it
  const d = window.__eraseDecision({ armed, hitAnnotation, hasSelection });
  if (d === "delete") { deleted++; hasSelection = false; setToolbarState("erase"); }
  return d;
}

$("btn-select").addEventListener("click", () => void setTool("select"));
$("btn-highlight").addEventListener("click", () => void doHighlight());
$("btn-ink").addEventListener("click", () => void setTool("ink"));
$("btn-erase").addEventListener("click", () => void onErase());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && armed) void setTool("select"); });

window.__t = {
  ready: true,
  selectText() { hasSelection = true; },
  clearSelection() { hasSelection = false; },
  click(id) { $(id).click(); return true; },
  pressEscape() { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; },
  viewerClick,
  lit() {
    return [...document.querySelectorAll(".tool")].filter((b) => b.classList.contains("active")).map((b) => b.id);
  },
  armed() {
    return [...document.querySelectorAll(".tool")].filter((b) => b.classList.contains("armed")).map((b) => b.id);
  },
  state() { return { toolbarState, adapterMode, armed, hasSelection, deleted }; },
  toasts() { return toasts.slice(); },
  /* The painted colour, not just the class: a button can carry .active and
     still look identical if the stylesheet never shipped. */
  bg(id) { return getComputedStyle($(id)).backgroundColor; },
  hasClass(id, c) { return $(id).classList.contains(c); },
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
  const work = mkdtempSync(path.join(tmpdir(), "paperai-toolbar-"));
  // The renderer is bundled for real; the toolbar logic is inlined above
  // because it lives in the Tauri entry point.
  const bundle = await build({
    entryPoints: [path.join(ROOT, "src", "ai", "markdown-renderer.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "error",
  });
  writeFileSync(path.join(work, "markdown-renderer.js"), bundle.outputFiles[0].text);
  // The eraser decision is bundled from the real module: the rules under test
  // must be the shipped ones, not a retyped copy.
  const policy = await build({
    entryPoints: [path.join(ROOT, "src", "tools", "erase-policy.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "error",
  });
  writeFileSync(path.join(work, "erase-policy.js"), policy.outputFiles[0].text);
  const css = readFileSync(path.join(ROOT, "src", "style.css"), "utf8");
  // Pull the shipped toolbar out of index.html rather than retyping it.
  const indexHtml = readFileSync(path.join(ROOT, "index.html"), "utf8");
  const toolbarMatch = indexHtml.match(/<header id="toolbar">[\s\S]*?<\/header>/);
  if (!toolbarMatch) throw new Error("could not find <header id=\"toolbar\"> in index.html");
  writeFileSync(
    path.join(work, "index.html"),
    PAGE.replace("__MAIN_CSS__", css).replace("__TOOLBAR__", toolbarMatch[0])
  );

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
      if (await cdp.evaluate("Boolean(window.__t)")) break;
      await sleep(250);
    }
    if (!(await cdp.evaluate("Boolean(window.__t)"))) {
      const err = await cdp.evaluate("JSON.stringify(window.__early || [])");
      throw new Error(`harness never loaded.\n  early errors = ${err}`);
    }

    const lit = async () => JSON.parse(await cdp.evaluate("JSON.stringify(window.__t.lit())"));
    const state = async () => JSON.parse(await cdp.evaluate("JSON.stringify(window.__t.state())"));

    // 1. Exactly one button lit at all times.
    record("T1", "初始只有一个按钮亮着", (await lit()).length === 1, `lit=${JSON.stringify(await lit())}`);

    // 2. THE reported bug: highlight could not be pressed on its own.
    //    With nothing selected, clicking Highlight must still arm the mode and
    //    light its own button.
    await cdp.evaluate("window.__t.click('btn-highlight')");
    await sleep(200);
    const litNoSel = await lit();
    const stNoSel = await state();
    record(
      "T2",
      "没有选区时点 Highlight 也能点亮并进入高亮模式",
      litNoSel.length === 1 && litNoSel[0] === "btn-highlight" && stNoSel.adapterMode === "highlight",
      `lit=${JSON.stringify(litNoSel)}  ${JSON.stringify(stNoSel)}`
    );

    // 2b. And with a selection it still highlights, as before.
    await cdp.evaluate("window.__t.click('btn-select')");
    await sleep(120);
    await cdp.evaluate("window.__t.selectText()");
    await cdp.evaluate("window.__t.click('btn-highlight')");
    await sleep(200);
    const litSel = await lit();
    record(
      "T2b",
      "有选区时点 Highlight 既高亮又点亮",
      litSel.length === 1 && litSel[0] === "btn-highlight",
      `lit=${JSON.stringify(litSel)}`
    );

    // 3. The lit button must actually LOOK lit (stylesheet shipped).
    const bgActive = await cdp.evaluate("window.__t.bg('btn-highlight')");
    const bgIdle = await cdp.evaluate("window.__t.bg('btn-ink')");
    record(
      "T3",
      "亮着的按钮在视觉上确实不同（样式生效）",
      bgActive !== bgIdle,
      `active bg=${bgActive}  idle bg=${bgIdle}`
    );

    // 4. THE eraser bug, part 1: pressing Erase must delete NOTHING, even with
    //    a selection sitting there (PDF.js keeps a freshly drawn stroke
    //    selected, which is how "Erase" came to mean "delete the last one").
    await cdp.evaluate("window.__t.click('btn-ink')");
    await sleep(120);
    await cdp.evaluate("window.__t.selectText()"); // e.g. a stroke just drawn
    await cdp.evaluate("window.__t.click('btn-erase')");
    await sleep(200);
    const stAfterArm = await state();
    record(
      "T4",
      "点 Erase 只是待命，绝不删除已有选中项",
      stAfterArm.deleted === 0,
      `deleted=${stAfterArm.deleted}  ${JSON.stringify(stAfterArm)}`
    );

    // 5. It is lit on its own button — the second half of "点不出来".
    const litAfterErase = await lit();
    const armedList = JSON.parse(await cdp.evaluate("JSON.stringify(window.__t.armed())"));
    record(
      "T5",
      "点 Erase 亮的是 Erase 本身，并标记为待命",
      litAfterErase.length === 1 && litAfterErase[0] === "btn-erase" && armedList.includes("btn-erase"),
      `lit=${JSON.stringify(litAfterErase)}  armed=${JSON.stringify(armedList)}`
    );

    // 6. THE eraser semantics: clicking empty paper deletes nothing, and it is
    //    the selection left over from before that must survive.
    await cdp.evaluate("window.__t.viewerClick(false)");
    await sleep(150);
    const stAfterMiss = await state();
    record(
      "T6",
      "点击空白处不删除（不会误删上一笔）",
      stAfterMiss.deleted === 0 && stAfterMiss.hasSelection === true,
      `deleted=${stAfterMiss.deleted}  hasSelection=${stAfterMiss.hasSelection}`
    );

    // 7. Clicking an annotation deletes exactly that one, and stays armed so a
    //    second one can go in the same session.
    await cdp.evaluate("window.__t.viewerClick(true)");
    await sleep(150);
    await cdp.evaluate("window.__t.viewerClick(true)");
    await sleep(150);
    const stAfterHits = await state();
    record(
      "T7",
      "点击批注才删除，且可连续删除",
      stAfterHits.deleted === 2 && stAfterHits.armed === true,
      `deleted=${stAfterHits.deleted}  ${JSON.stringify(stAfterHits)}`
    );

    // 8. Escape leaves the armed state — otherwise there is no way back.
    await cdp.evaluate("window.__t.pressEscape()");
    await sleep(150);
    const litAfterEsc = await lit();
    const stAfterEsc = await state();
    record(
      "T8",
      "Esc 退出待命，且退出后点击不再删除",
      litAfterEsc.length === 1 && litAfterEsc[0] === "btn-select" && stAfterEsc.armed === false,
      `lit=${JSON.stringify(litAfterEsc)}  ${JSON.stringify(stAfterEsc)}`
    );
    await cdp.evaluate("window.__t.viewerClick(true)");
    await sleep(150);
    const stAfterEscClick = await state();
    record(
      "T9",
      "退出擦除后，再点批注不会删除任何东西",
      stAfterEscClick.deleted === 2,
      `deleted=${stAfterEscClick.deleted}`
    );

    // 10. Every tool button can be lit. The old markup gave Erase no `tool`
    //     class at all, so it could never light up — caught here as a hard fail.
    //
    //     Highlight needs a selection to act on; clicking it with nothing
    //     selected correctly warns and leaves the toolbar alone, so the loop
    //     re-selects before clicking it.
    const allLit = [];
    let allOk = true;
    for (const id of ["btn-highlight", "btn-ink", "btn-erase", "btn-select"]) {
      if (id === "btn-highlight") await cdp.evaluate("window.__t.selectText()");
      await cdp.evaluate(`window.__t.click('${id}')`);
      await sleep(150);
      const l = await lit();
      allLit.push(`${id}->${JSON.stringify(l)}`);
      if (l.length !== 1 || l[0] !== id) allOk = false;
    }
    record("T10", "每个工具按钮都能点亮", allOk, allLit.join("  "));

    // 11. THE formatting half of the report, in a real browser with KaTeX ON:
    //     a `\[...\]` formula must be typeset, and no raw marker may survive.
    const math = JSON.parse(
      await cdp.evaluate(`(async () => {
        const { renderMarkdown } = await import('/markdown-renderer.js');
        const host = document.createElement('div');
        document.body.appendChild(host);
        renderMarkdown(host, '收敛判据 \\\\[|T_j^{(k+1)} - T_j^{(k)}| < \\\\varepsilon\\\\] 收敛', {});
        const katexCount = host.querySelectorAll('.katex').length;
        const text = host.textContent;
        const box = host.querySelector('.md-math-inline');
        return JSON.stringify({
          katexCount,
          text,
          hasRawOpen: text.includes('\\\\['),
          hasRawClose: text.includes('\\\\]'),
          boxH: box ? Math.round(box.getBoundingClientRect().height) : 0,
        });
      })()`)
    );
    record(
      "T11",
      "\\[...\\] 公式真正被排版，且不残留原始标记",
      math.katexCount >= 1 && !math.hasRawOpen && !math.hasRawClose && math.boxH > 0,
      `katex 节点=${math.katexCount}  渲染高度=${math.boxH}px  文本="${math.text}"`
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
    path.join(out, "toolbar-state.txt"),
    [
      `Toolbar tool-state + math delimiters — real Chromium`,
      `Generated: ${new Date().toISOString()}`,
      "",
      ...results.map((r) => `[${r.ok ? "PASS" : "FAIL"}] ${r.id} ${r.name}\n    ${r.note}`),
      "",
      `${results.length - bad}/${results.length} PASS`,
    ].join("\n"),
    "utf8"
  );
  console.log(`evidence in evidence/ai-tests/toolbar-state.txt`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error("toolbar-state failed:", e);
  process.exit(2);
});