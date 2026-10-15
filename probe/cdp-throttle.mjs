// Probe: does the Tauri WebView2 renderer respond to CDP when backgrounding /
// occlusion throttling is disabled? Symptom was: page loads and JS runs, but
// Runtime.evaluate never returns (renderer suspended because the window is
// treated as occluded in this session).
import { spawn } from "node:child_process";

const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9440);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const dt = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const ARGS = [
  `--remote-debugging-port=${PORT}`,
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
  "--disable-features=CalculateNativeWinOcclusion",
].join(" ");

const child = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: ARGS }, stdio: "ignore" });

let ws;
let id = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); reject(new Error(`${method} timeout`)); }
    }, 20000);
  });
}

try {
  let browserWs = null;
  for (let i = 0; i < 90 && !browserWs; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (v.webSocketDebuggerUrl) browserWs = v.webSocketDebuggerUrl;
    } catch {}
    if (!browserWs) await sleep(500);
  }
  if (!browserWs) throw new Error("no endpoint");
  ws = new WebSocket(browserWs);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("ws")), { once: true }); });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  console.log(dt(), "connected");

  let pageId = null;
  for (let i = 0; i < 60 && !pageId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    pageId = targetInfos.find((t) => t.type === "page" && !/about:blank/.test(t.url))?.targetId ?? null;
    if (!pageId) await sleep(500);
  }
  const { sessionId } = await send("Target.attachToTarget", { targetId: pageId, flatten: true });
  await send("Runtime.enable", {}, sessionId);

  let ok = 0;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await send("Runtime.evaluate", {
        expression: "location.href+' | title='+document.title+' | paperai='+(typeof window.__paperai)+' | ready='+(window.__paperai?window.__paperai.ready:false)",
        returnByValue: true,
      }, sessionId);
      console.log(dt(), "eval:", r.result?.value);
      ok++;
    } catch (e) {
      console.log(dt(), "eval failed:", e.message);
    }
    await sleep(1000);
  }
  console.log(dt(), ok > 0 ? "RENDERER RESPONSIVE" : "STILL FROZEN");
} catch (e) {
  console.log(dt(), "FAILED:", e.message);
} finally {
  try { ws && ws.close(); } catch {}
  try { child.kill(); } catch {}
}
