import puppeteer from "puppeteer-core";
import fs from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[PAGEERROR]", e.message));

await p.goto("http://localhost:5180/", { waitUntil: "networkidle2" });
await p.waitForFunction(() => !!window.__paperai, { timeout: 20000 });
const b64 = fs.readFileSync("D:/AIreader/PaperAI-PoC/test-pdfs/PDF-B.pdf").toString("base64");
await p.evaluate(async (s) => {
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  await window.__paperai.loadByArrayBuffer(a.buffer, "PDF-B.pdf");
}, b64);
await p.waitForFunction(() => window.__paperai.hasUIManager === true, { timeout: 45000 });
await sleep(1500);

// Attach listeners to the *real* layer for both pointerdown and check
// whether DrawingEditor got the event, with a genuine trusted mouse drag.
console.log("=== trusted mouse drag on layer, with instrumentation ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  await um.updateMode(15, null, true);
  await new Promise((r) => setTimeout(r, 400));
  const layer = um.getLayer(0);

  const log = [];
  const origStart = layer.startDrawingSession.bind(layer);
  layer.startDrawingSession = (ev) => {
    log.push(`startDrawingSession: target=${ev.target?.className || ev.target?.tagName}`);
    return origStart(ev);
  };

  // attach a capture-phase spy on window for pointerdown/up
  window.addEventListener("pointerdown", (e) => log.push(`win^down target=${e.target.className||e.target.tagName} pid=${e.pointerId} type=${e.pointerType} isTrusted=${e.isTrusted}`), true);
  window.addEventListener("pointerup", (e) => log.push(`win^up target=${e.target.className||e.target.tagName} pid=${e.pointerId}`), true);

  window.__paperaiEventLog = log; return { ready: true };
}));

// real trusted input
const box = await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const x0 = box.x + 160, y0 = box.y + 260;
await p.mouse.move(x0, y0);
await sleep(250);
await p.mouse.down({ button: "left" });
await sleep(250);
for (let i = 1; i <= 30; i++) { await p.mouse.move(x0 + i * 5, y0 + Math.sin(i / 4) * 20); await sleep(30); }
await sleep(250);
await p.mouse.up({ button: "left" });
await sleep(1500);

console.log("=== event log from the trusted drag ===");
console.log(await p.evaluate(() => window.__paperaiEventLog ?? "(see below)"));

const final = await p.evaluate(() => ({
  ink: document.querySelectorAll(".inkEditor").length,
  canvases: document.querySelectorAll(".annotationEditorLayer canvas").length,
  count: window.__paperai.annotationCount,
  layerClass: document.querySelector(".pdfViewer .page .annotationEditorLayer").className,
}));
console.log("final:", final);

await b.close();