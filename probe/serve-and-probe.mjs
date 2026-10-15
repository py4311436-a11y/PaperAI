// Serve ./dist over plain HTTP and drive it with Edge + CDP (control proved
// that works here). Tells us whether the built bundle itself boots, separating
// "broken bundle" from "Tauri asset serving problem".
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import path from "node:path";
import { CdpPage, waitBrowserEndpoint, waitPageTarget } from "../tests/lib-cdp.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DIST = join(ROOT, "dist");
const PORT = 8099;
const CDP = Number(process.argv[2] ?? 9400);
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const dt = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".wasm": "application/wasm", ".map": "application/json" };

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const full = join(DIST, normalize(p).replace(/^(\.\.[\\/])+/, ""));
    const s = await stat(full);
    if (!s.isFile()) throw new Error("not a file");
    const body = await readFile(full);
    res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nf");
  }
});
await new Promise((r) => server.listen(PORT, r));
console.log(dt(), `serving ${DIST} at http://127.0.0.1:${PORT}/`);

const child = spawn(
  EDGE,
  [`--app=http://127.0.0.1:${PORT}/`, `--remote-debugging-port=${CDP}`, "--user-data-dir=" + join(ROOT, "evidence", "stage-b", "edge-serve-profile"), "--no-first-run"],
  { stdio: "ignore" }
);

try {
  await waitBrowserEndpoint(CDP, 30000);
  const target = await waitPageTarget(CDP, 30000);
  console.log(dt(), "target:", target.url);
  const page = await CdpPage.connect(target.webSocketDebuggerUrl);

  for (let i = 0; i < 40; i++) {
    const v = await page.send("Runtime.evaluate", { expression: "typeof window.__paperai", returnByValue: true, awaitPromise: false });
    if (v.result?.value === "object") break;
    await sleep(500);
  }

  for (const [n, e] of [
    ["href", "location.href"],
    ["paperai", "typeof window.__paperai"],
    ["ready", "window.__paperai?.ready === true"],
    ["isTauri", "window.__paperai?.isTauri"],
    ["pdfjs", "window.__paperai?.version"],
    ["title", "document.title"],
    ["logs", "(window.__paperai?.logs || []).slice(-6).map(l => l.level + ':' + l.msg).join(' || ')"],
  ]) {
    try {
      const v = await page.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: false });
      console.log(dt(), `${n} =`, JSON.stringify(v.result?.value));
    } catch (err) {
      console.log(dt(), `${n} FAILED:`, err.message);
    }
  }
  await page.screenshot().then((b) => import("node:fs").then((fs) => fs.writeFileSync(join(ROOT, "evidence", "stage-b", "served-dist.png"), b)));
} catch (e) {
  console.log(dt(), "FAILED:", e.message);
} finally {
  try { child.kill(); } catch {}
  server.close();
}
