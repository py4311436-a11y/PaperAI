import puppeteer from "puppeteer-core";
import fs from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  defaultViewport: { width: 1400, height: 1000 },
});
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

console.log("=== INK mode via real CDP mouse input ===");
await p.click("#btn-ink");
await sleep(1500);
console.log("mode:", await p.evaluate(() => window.__paperaiUM.getMode()));
console.log("layer class:", await p.evaluate(() => document.querySelector(".pdfViewer .page .annotationEditorLayer").className));

// Get exact layer box, then draw INSIDE it with many small steps (real input).
const box = await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log("layer box:", box);

const x0 = box.x + 120, y0 = box.y + 200;
await p.mouse.move(x0, y0);
await sleep(120);
await p.mouse.down({ button: "left" });
await sleep(120);
for (let i = 1; i <= 40; i++) {
  await p.mouse.move(x0 + i * 4, y0 + Math.sin(i / 4) * 20);
  await sleep(25);
}
await sleep(120);
await p.mouse.up({ button: "left" });
await sleep(1500);

console.log("ink editors:", await p.evaluate(() => document.querySelectorAll(".inkEditor").length));
console.log("canvases:", await p.evaluate(() => document.querySelectorAll(".annotationEditorLayer canvas").length));
console.log("annotationCount:", await p.evaluate(() => window.__paperai.annotationCount));
console.log("layer innerHTML len:", await p.evaluate(() =>
  document.querySelector(".pdfViewer .page .annotationEditorLayer").innerHTML.length));

console.log("\n=== save + verify ===");
const res = await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasInk: r.hasInk };
});
console.log(res);

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink-cdp.png" });
await b.close();