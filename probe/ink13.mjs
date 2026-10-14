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

console.log("=== verify official CSS is in effect ===");
console.log(await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const t = document.querySelector(".pdfViewer .page .textLayer");
  const c = document.querySelector(".pdfViewer .page .canvasWrapper");
  return {
    layerClass: l?.className,
    layerPE: l ? getComputedStyle(l).pointerEvents : null,
    textLayerPE: t ? getComputedStyle(t).pointerEvents : null,
    canvasPE: c ? getComputedStyle(c).pointerEvents : null,
    textZ: t ? getComputedStyle(t).zIndex : null,
  };
}));

console.log("\n=== INK draw with official CSS ===");
await p.click("#btn-ink");
await sleep(1300);
console.log("mode:", await p.evaluate(() => window.__paperaiUM.getMode()));
console.log("layer class:", await p.evaluate(() => document.querySelector(".pdfViewer .page .annotationEditorLayer").className));
console.log("elementFromPoint at draw area:", await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  const el = document.elementFromPoint(r.x + 150, r.y + 250);
  return el ? el.tagName + "." + el.className : "null";
}));

const box = await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const x0 = box.x + 130, y0 = box.y + 230;
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
console.log("canvases in layer:", await p.evaluate(() => document.querySelectorAll(".annotationEditorLayer canvas").length));
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

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink-officialcss.png" });
await b.close();