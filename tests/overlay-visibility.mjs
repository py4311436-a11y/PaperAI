#!/usr/bin/env node
/**
 * Regression test for the `[hidden]` cascade bug (A-12).
 *
 * Four overlays toggle visibility with `element.hidden = true`, but the
 * stylesheet gives each of them `display: flex` under an ID selector. The UA
 * stylesheet's `[hidden] { display: none }` lives in the user-agent origin, so
 * EVERY author declaration beats it — specificity is not even consulted. The
 * result: the close button set `.hidden` and nothing happened on screen.
 *
 * A pure-DOM shim cannot catch this, because the bug is exactly the part a
 * shim does not implement: cascade and computed style. So this runs a real
 * Chromium (headless Edge) and asks it for `getComputedStyle`.
 *
 * CDP is available for Edge when it is given a FRESH --user-data-dir; with the
 * default profile Chromium 136+ ignores --remote-debugging-port entirely
 * (that asymmetry is what K-13 was eventually traced to).
 *
 * Usage: node tests/overlay-visibility.mjs [--css <path>]
 * Exits non-zero on any failure. Always cleans up the browser it started.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Elements to check.
 *
 * `kind: "live"`   — the app toggles these with `element.hidden`. All three
 *                    were genuinely broken: created at boot with
 *                    `hidden = true`, and visible anyway.
 * `kind: "latent"` — would break if it were ever toggled via `hidden`, but
 *                    today it dismisses itself with `.remove()`. Listed so the
 *                    invariant is asserted globally rather than only where we
 *                    happened to get bitten.
 */
const OVERLAYS = [
  { id: "ai-settings", kind: "live", source: "src/ai/provider-settings.ts" },
  { id: "ai-panel", kind: "live", source: "src/ai/chat-panel.ts" },
  { id: "selection-bar", kind: "live", source: "src/ai/selection-bar.ts" },
  { id: "recovery-modal", kind: "latent", source: "src/bridge.ts (uses .remove())" },
];

/**
 * Control: also toggled with `.hidden`, but its stylesheet rules never set
 * `display`, so it always worked. It pins down the actual trigger — an author
 * `display` declaration — rather than `hidden` being broken in general.
 */
const CONTROL = { id: "ai-stop", kind: "control", wrapper: "ai-composer-bar", button: true };

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/** Newest built stylesheet, or an explicit path. */
function findCss(argv) {
  const i = argv.indexOf("--css");
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const dir = path.join(ROOT, "dist", "assets");
  if (!existsSync(dir)) return null;
  const cands = readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => ({ f: path.join(dir, f), t: 0 }));
  if (!cands.length) return null;
  // Pick the largest: that is the entry sheet (pdf_viewer.css is inlined).
  cands.sort((a, b) => readFileSync(b.f).length - readFileSync(a.f).length);
  return cands[0].f;
}

/** Minimal CDP client over the browser's page target. */
async function connectCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let targets = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        targets = page;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  if (!targets) throw new Error(`no page target on port ${port} within ${timeoutMs}ms`);

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("websocket error")), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
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

  /** evaluate an expression, returning its JSON value */
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || "evaluate threw");
    }
    return r.result.value;
  };

  return { evaluate, close: () => ws.close() };
}

async function main() {
  const edge = findEdge();
  if (!edge) {
    console.log("BLOCKED: Microsoft Edge not found; cannot verify computed style");
    process.exit(2);
  }
  const cssPath = findCss(process.argv.slice(2));
  if (!cssPath) {
    console.log("BLOCKED: no built stylesheet under dist/assets — run `npm run build` first");
    process.exit(2);
  }
  const css = readFileSync(cssPath, "utf8");
  console.log(`stylesheet : ${path.relative(ROOT, cssPath)} (${css.length} bytes)`);
  console.log(`browser    : ${edge}`);

  const profile = mkdtempSync(path.join(tmpdir(), "paperai-css-"));
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(
    edge,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let cdp = null;
  let failures = 0;
  const rows = [];
  const record = (id, check, ok, detail) => {
    rows.push({ id, check, ok, detail });
    if (!ok) failures++;
  };

  try {
    cdp = await connectCdp(port);

    // Inject the real built stylesheet and stand up each overlay in three
    // states. `hidden` is toggled exactly the way the app toggles it.
    const setup = await cdp.evaluate(`
      (() => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
        const ids = ${JSON.stringify(OVERLAYS.map((o) => o.id))};
        const els = {};
        for (const id of ids) {
          const el = document.createElement('div');
          el.id = id;
          document.body.appendChild(el);
          els[id] = el;
        }
        // Control element: a real <button> inside .ai-composer-bar.
        {
          const bar = document.createElement('div');
          bar.className = ${JSON.stringify(CONTROL.wrapper)};
          const b = document.createElement('button');
          b.id = ${JSON.stringify(CONTROL.id)};
          b.className = 'danger';
          bar.appendChild(b);
          document.body.appendChild(bar);
          els[${JSON.stringify(CONTROL.id)}] = b;
        }
        const out = {};
        for (const id of Object.keys(els)) {
          const el = els[id];
          el.hidden = true;
          const hiddenDisplay = getComputedStyle(el).display;
          el.hidden = false;
          const shownDisplay = getComputedStyle(el).display;
          el.hidden = true;
          const againDisplay = getComputedStyle(el).display;
          out[id] = { hiddenDisplay, shownDisplay, againDisplay };
        }
        return out;
      })()
    `);

    for (const { id, kind } of [...OVERLAYS, CONTROL]) {
      const r = setup[id];
      const label = `${kind}/${id}`;
      record(
        label,
        "hidden=true 时必须 display:none",
        r.hiddenDisplay === "none",
        `display=${r.hiddenDisplay}`
      );
      record(
        label,
        "hidden=false 时必须恢复可见（修复不能把它永久隐藏）",
        r.shownDisplay !== "none",
        `display=${r.shownDisplay}`
      );
      record(
        label,
        "再次隐藏必须生效（可反复切换）",
        r.againDisplay === "none",
        `display=${r.againDisplay}`
      );
    }
  } catch (e) {
    console.log(`\nFAIL: ${e.message}`);
    failures++;
  } finally {
    try {
      cdp?.close();
    } catch {}
    try {
      child.kill();
    } catch {}
    // Kill anything still holding OUR temp profile. Never touch the user's Edge.
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -EA SilentlyContinue | ` +
          `Where-Object { $_.CommandLine -like '*${profile.replace(/\\/g, "\\\\")}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }`,
      ],
      { encoding: "utf8", timeout: 60000 }
    );
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }

  console.log("");
  const w = Math.max(...rows.map((r) => r.id.length), 12);
  for (const r of rows) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(w)}  ${r.check}  [${r.detail}]`);
  }
  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n${pass}/${rows.length} PASS`);

  const outFile = path.join(ROOT, "evidence", "ai-tests", "overlay-visibility.txt");
  try {
    writeFileSync(
      outFile,
      `# overlay visibility (real Chromium, computed style)\n` +
        `stylesheet: ${path.relative(ROOT, cssPath)} (${css.length} bytes)\n` +
        `browser   : ${edge}\n\n` +
        rows.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.check}  [${r.detail}]`).join("\n") +
        `\n\n${pass}/${rows.length} PASS\n`
    );
  } catch {}

  process.exit(failures ? 1 : 0);
}

main();
