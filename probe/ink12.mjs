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

// Directly invoke the drawing pipeline the way PDF.js does, and capture errors.
console.log("=== call InkEditor.startDrawing path manually via layer internals ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  await um.updateMode(15);
  await new Promise((r) => setTimeout(r, 400));
  const layer = um.getLayer(0);
  const out = {};

  out.drawLayerKeys = layer.drawLayer ? Object.getOwnPropertyNames(Object.getPrototypeOf(layer.drawLayer)) : null;
  out.drawLayerChildren = layer.drawLayer?.div?.children?.length ?? "no div";

  // try a direct stroke simulation calling layer's own handlers
  const div = layer.div;
  const r = div.getBoundingClientRect();
  const x0 = r.x + 100, y0 = r.y + 150;
  const mkEv = (type, x, y, buttons) =>
    new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 7, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: x, clientY: y,
    });

  // hook _endDraw to see if a stroke ever completes
  const layerProto = Object.getPrototypeOf(layer);
  const errs = [];
  window.addEventListener("error", (e) => errs.push(e.message));
  window.addEventListener("unhandledrejection", (e) => errs.push("rej:" + e.reason));

  layer.startDrawingSession(mkEv("pointerdown", x0, y0, 1));
  await new Promise((z) => setTimeout(z, 200));
  out.afterStart = {
    drawLayerChildren: layer.drawLayer?.div?.children?.length ?? -1,
    layerChildren: div.children.length,
  };
  for (let i = 1; i <= 20; i++) {
    const ev = mkEv("pointermove", x0 + i * 5, y0 + Math.sin(i / 3) * 15, 1);
    div.dispatchEvent(ev);
    await new Promise((z) => setTimeout(z, 25));
  }
  out.afterMove = {
    drawLayerChildren: layer.drawLayer?.div?.children?.length ?? -1,
  };
  window.dispatchEvent(mkEv("pointerup", x0 + 100, y0, 0));
  await new Promise((z) => setTimeout(z, 900));

  out.final = {
    ink: document.querySelectorAll(".inkEditor").length,
    drawLayerChildren: layer.drawLayer?.div?.children?.length ?? -1,
    count: window.__paperai.annotationCount,
    errs,
  };
  return out;
}));

console.log("\n=== save+verify ===");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, counts: r.annotCountsBySubtype, hasInk: r.hasInk };
}));

await b.close();