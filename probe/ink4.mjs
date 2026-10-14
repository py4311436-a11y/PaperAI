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

await p.evaluate(async () => { await window.__paperaiUM.updateMode(15); });
await sleep(700);

// Dispatch real PointerEvents straight at the editor layer div.
console.log("=== dispatch PointerEvent sequence ===");
console.log(await p.evaluate(async () => {
  const layer = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  if (!layer) return { err: "no layer" };
  const r = layer.getBoundingClientRect();
  const pt = (type, x, y, extra = {}) => {
    const ev = new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
      button: 0, buttons: type === "pointerup" ? 0 : 1,
      clientX: x, clientY: y,
      ...extra,
    });
    layer.dispatchEvent(ev);
  };
  const x0 = r.x + 120, y0 = r.y + 180;
  pt("pointerdown", x0, y0);
  for (let i = 1; i <= 25; i++) {
    pt("pointermove", x0 + i * 5, y0 + Math.sin(i / 3) * 18);
    await new Promise((r2) => setTimeout(r2, 18));
  }
  pt("pointerup", x0 + 125, y0);
  await new Promise((r2) => setTimeout(r2, 900));
  return {
    inkEditors: document.querySelectorAll(".inkEditor").length,
    canvases: document.querySelectorAll(".annotationEditorLayer canvas").length,
    count: window.__paperai.annotationCount,
    layerChildren: layer.children.length,
  };
}));

console.log("\n=== save+verify ===");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasInk: r.hasInk };
}));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink-pointer.png" });
await b.close();