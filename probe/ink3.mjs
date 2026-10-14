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

console.log("=== baseline mode ===", await p.evaluate(() => window.__paperaiUM.getMode()));
console.log("=== isEditingMode:", await p.evaluate(() => window.__paperaiUM.isEditingMode()));
console.log("=== #editorTypes map size (via a layer):");
console.log(await p.evaluate(() => {
  const um = window.__paperaiUM;
  // layers are private; probe via getEditors / addLayer bookkeeping
  return { hasGetMode: typeof um.getMode, mode: um.getMode() };
}));

console.log("\n=== call updateMode(INK=15) directly and await ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  await um.updateMode(15);
  return { mode: um.getMode(), isEditing: um.isEditingMode() };
}));
await sleep(800);

console.log("layer class now:", await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  return l ? l.className : "(none)";
}));

console.log("\n=== draw with pointer events, checking event.target ===");
const box = await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log("layer rect:", box);
const cx = box.x + 150, cy = box.y + 200;
console.log("elementFromPoint:", await p.evaluate((x, y) => {
  const el = document.elementFromPoint(x, y);
  return el ? el.tagName + "." + el.className : "null";
}, cx, cy));

await p.mouse.move(cx, cy);
await p.mouse.down();
await sleep(80);
for (let i = 1; i <= 30; i++) { await p.mouse.move(cx + i * 4, cy + Math.sin(i / 3) * 20); await sleep(20); }
await p.mouse.up();
await sleep(1200);

console.log("inkEditor elements:", await p.evaluate(() => document.querySelectorAll(".inkEditor").length));
console.log("all editor-ish:", await p.evaluate(() =>
  [...document.querySelectorAll(".annotationEditorLayer *")].map(e => e.className).filter(Boolean).slice(0, 8)));
console.log("annotationCount:", await p.evaluate(() => window.__paperai.annotationCount));

console.log("\n=== save+verify ===");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype };
}));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink3.png" });
await b.close();