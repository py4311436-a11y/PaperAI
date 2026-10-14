/**
 * Clean-room Ink verification.
 *
 * Prior tests polluted module-level `CurrentPointers` state inside pdf.mjs:
 *   static #pointerType = null; setPointer() uses `??=` / `||=`, and
 *   `updateMode()` does NOT reset it -> once a stroke with a foreign
 *   pointerType starts, every later startDrawing() early-returns.
 * `updateMode(mode, ..., isFromUser=true)` calls clearPointerType() for us.
 *
 * This script therefore runs ONE stroke per fresh browser page and passes
 * isFromUser=true so the module state is reset legitimately.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[PAGEERROR]", e.message));
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

// Enter INK mode with isFromUser=true so CurrentPointers is reset.
console.log("=== updateMode(INK, isFromUser=true) ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  await um.updateMode(15, null, true);
  await new Promise((r) => setTimeout(r, 500));
  return { mode: um.getMode(), editing: um.isEditingMode() };
}));

// ONE stroke via real CDP mouse.
const box = await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
console.log("layer box:", box);

const x0 = box.x + 140, y0 = box.y + 240;
await p.mouse.move(x0, y0);
await sleep(200);
await p.mouse.down({ button: "left" });
await sleep(200);
for (let i = 1; i <= 45; i++) {
  await p.mouse.move(x0 + i * 4.5, y0 + Math.sin(i / 4) * 22);
  await sleep(28);
}
await sleep(250);
await p.mouse.up({ button: "left" });
await sleep(2000);

const state = await p.evaluate(() => ({
  ink: document.querySelectorAll(".inkEditor").length,
  canvases: document.querySelectorAll(".annotationEditorLayer canvas").length,
  count: window.__paperai.annotationCount,
  layerClass: document.querySelector(".pdfViewer .page .annotationEditorLayer").className,
}));
console.log("state after stroke:", state);

console.log("\n=== save + verify ===");
const res = await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasInk: r.hasInk };
});
console.log(res);

if (res.ok && res.hasInk) {
  const b64out = await p.evaluate(async () => {
    const data = await window.__paperai.save();
    let s = "";
    for (let i = 0; i < data.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, Array.from(data.slice(i, i + 0x8000)));
    }
    return btoa(s);
  });
  fs.mkdirSync("D:/AIreader/PaperAI-PoC/output", { recursive: true });
  fs.writeFileSync("D:/AIreader/PaperAI-PoC/output/example_annotated.pdf", Buffer.from(b64out, "base64"));
  console.log("saved -> output/example_annotated.pdf");
}

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/ink-clean.png" });
await b.close();