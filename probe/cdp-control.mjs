// CONTROL experiment: is raw CDP usable at all in this session?
// Drives Microsoft Edge (same WebView2/Chromium engine) on a trivial page.
// If this also hangs after navigation, the blocker is the environment
// (no interactive desktop), not the PaperAI frontend.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CdpPage, waitBrowserEndpoint, waitPageTarget } from "../tests/lib-cdp.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
mkdirSync(path.join(ROOT, "evidence", "stage-b"), { recursive: true });
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.argv[2] ?? 9395);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const dt = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const html = "<html><head><title>ControlPage</title></head><body><h1>hello-cdp</h1><script>window.__ok=42;</script></body></html>";
const file = path.join(ROOT, "evidence", "stage-b", "control.html");
writeFileSync(file, html);

const child = spawn(
  EDGE,
  ["--app=file:///" + file.replace(/\\/g, "/"), `--remote-debugging-port=${PORT}`, "--user-data-dir=" + path.join(ROOT, "evidence", "stage-b", "edge-ctrl-profile"), "--no-first-run"],
  { stdio: "ignore" }
);

try {
  await waitBrowserEndpoint(PORT, 30000);
  console.log(dt(), "endpoint up");
  const target = await waitPageTarget(PORT, 30000);
  console.log(dt(), "target:", target.url);
  const page = await CdpPage.connect(target.webSocketDebuggerUrl);
  console.log(dt(), "connected");

  for (const [n, e] of [["href", "location.href"], ["title", "document.title"], ["__ok", "window.__ok"], ["h1", "document.querySelector('h1').textContent"]]) {
    try {
      const v = await page.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: false });
      console.log(dt(), `${n} =`, JSON.stringify(v.result?.value));
    } catch (err) {
      console.log(dt(), `${n} FAILED:`, err.message);
    }
  }
  try {
    const s = await page.screenshot();
    console.log(dt(), "screenshot bytes:", s.length);
  } catch (err) {
    console.log(dt(), "screenshot FAILED:", err.message);
  }
} catch (e) {
  console.log(dt(), "FAILED:", e.message);
} finally {
  try { child.kill(); } catch {}
}
