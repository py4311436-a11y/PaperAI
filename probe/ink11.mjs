import puppeteer from "puppeteer-core";
import fs from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
p.on("console", (m) => { const t = m.text(); if (t.includes("PaperAI") || m.type() === "error") console.log("[" + m.type() + "]", t); });

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

console.log("=== FRESH INK DRAW (no prior pointer state) ===");
await p.click("#btn-ink");
await sleep(1200);
console.log("mode:", await p.evaluate(() => window.__paperaiUM.getMode()));

const box = await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

// pointerId must be unique & consistent within one stroke
const x0 = box.x + 130, y0 = box.y + 220;
await p.mouse.move(x0, y0);
await sleep(150);
await p.mouse.down({ button: "left" });
await sleep(150);
for (let i = 1; i <= 40; i++) {
  await p.mouse.move(x0 + i * 4.5, y0 + Math.sin(i / 4) * 22);
  await sleep(28);
}
await sleep(150);
await p.mouse.up({ button: "left" });
await sleep(1800);

console.log("inkEditor elements:", await p.evaluate(() => document.querySelectorAll(".inkEditor").length));
console.log("draw canvases:", await p.evaluate(() => document.querySelectorAll(".annotationEditorLayer canvas").length));
console.log("drawLayer children:", await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  return l ? l.querySelectorAll("canvas, svg, div").length : -1;
}));
console.log("annotationCount:", await p.evaluate(() => window.__paperai.annotationCount));
console.log("layer html len:", await p.evaluate(() =>
  document.querySelector(".pdfViewer .page .annotationEditorLayer").innerHTML.length));

console.log("\n=== save + verify ===");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasInk: r.hasInk };
}));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink-fresh.png" });
await b.close();