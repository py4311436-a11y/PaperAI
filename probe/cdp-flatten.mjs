// Attach with Target.attachToTarget(flatten) on the browser endpoint so we can
// capture console/exception events from the moment the document is created —
// before a direct page-socket attach can hang.
import { spawn } from "node:child_process";

const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9430);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const dt = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

let ws;
async function connect() {
  for (let i = 0; i < 90; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (v.webSocketDebuggerUrl) {
        ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
        });
        return v.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("no endpoint");
}

let id = 0;
const pending = new Map();
const listeners = new Map();
function send(method, params = {}, sessionId) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new Error(`${method} timeout`));
      }
    }, 30000);
  });
}

try {
  await connect();
  console.log(dt(), "browser ws connected");
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (!m.method) return;
    if (m.method === "Runtime.consoleAPICalled") {
      const args = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      console.log(dt(), `  [console.${m.params.type}]`, String(args).slice(0, 300));
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      console.log(dt(), "  [exception]", String(d.exception?.description ?? d.text).slice(0, 500));
    } else if (m.method === "Log.entryAdded") {
      console.log(dt(), `  [log.${m.params.entry.level}]`, String(m.params.entry.text).slice(0, 300));
    } else if (m.method === "Network.loadingFailed") {
      console.log(dt(), "  [loadFailed]", m.params.errorText);
    } else if (m.method === "Network.responseReceived") {
      const r = m.params.response;
      console.log(dt(), `  [resp ${r.status}]`, r.url.slice(0, 120));
    } else if (m.method === "Target.attachedToTarget" || m.method === "Target.targetCreated") {
      const info = m.method === "Target.attachedToTarget" ? m.params.targetInfo : m.params.targetInfo;
      console.log(dt(), "  [target]", info.type, info.url);
    }
  });

  await send("Target.setDiscoverTargets", { discover: true });

  // Wait for the page target, then attach flattened.
  let pageId = null;
  for (let i = 0; i < 60 && !pageId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const hit = targetInfos.find((t) => t.type === "page" && !/about:blank/.test(t.url));
    if (hit) pageId = hit.targetId;
    else await sleep(500);
  }
  if (!pageId) throw new Error("no page target");
  console.log(dt(), "page target:", pageId);

  const { sessionId } = await send("Target.attachToTarget", { targetId: pageId, flatten: true });
  console.log(dt(), "attached session:", sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId).catch((e) => console.log(dt(), "Network.enable:", e.message));
  await send("Log.enable", {}, sessionId).catch((e) => console.log(dt(), "Log.enable:", e.message));

  for (let i = 0; i < 20; i++) {
    try {
      const r = await send("Runtime.evaluate", { expression: "location.href + ' | title=' + document.title + ' | paperai=' + (typeof window.__paperai)", returnByValue: true }, sessionId);
      console.log(dt(), "eval:", r.result?.value);
    } catch (e) {
      console.log(dt(), "eval failed:", e.message);
    }
    await sleep(1000);
  }
} catch (e) {
  console.log(dt(), "FAILED:", e.message);
} finally {
  try { ws && ws.close(); } catch {}
  try { child.kill(); } catch {}
}
