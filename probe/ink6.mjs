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
await sleep(600);

console.log("=== drive the REAL layer object ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  const layer = um.getLayer(0) ?? um.currentLayer;
  if (!layer) return { err: "no layer" };
  const r = layer.div.getBoundingClientRect();

  const out = { layerCtor: layer.constructor.name };
  out.canCreateNewEmpty = layer.canCreateNewEmptyEditor?.();
  out.layerProto = Object.getOwnPropertyNames(Object.getPrototypeOf(layer))
    .filter((k) => /draw|Draw|create|Create|pointer/i.test(k));

  // feed a pointerdown directly into the layer handler with target===layer.div
  const mk = (type, x, y, buttons) => {
    const ev = new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: "mouse", isPrimary: true,
      button: 0, buttons, clientX: x, clientY: y,
    });
    Object.defineProperty(ev, "target", { value: layer.div, configurable: true });
    Object.defineProperty(ev, "offsetX", { value: x - r.x, configurable: true });
    Object.defineProperty(ev, "offsetY", { value: y - r.y, configurable: true });
    return ev;
  };

  const x0 = r.x + 120, y0 = r.y + 160;
  try {
    layer.pointerdown(mk("pointerdown", x0, y0, 1));
    await new Promise((z) => setTimeout(z, 60));
    out.afterDown = { children: layer.div.children.length, ink: document.querySelectorAll(".inkEditor").length };
    for (let i = 1; i <= 25; i++) {
      const ev = mk("pointermove", x0 + i * 5, y0 + Math.sin(i / 3) * 18, 1);
      layer.div.dispatchEvent(ev);
      await new Promise((z) => setTimeout(z, 18));
    }
    const up = mk("pointerup", x0 + 125, y0, 0);
    layer.div.dispatchEvent(up);
    layer.pointerup?.(up);
    await new Promise((z) => setTimeout(z, 800));
  } catch (e) { out.err = String(e); }

  out.final = {
    ink: document.querySelectorAll(".inkEditor").length,
    canvases: document.querySelectorAll(".annotationEditorLayer canvas").length,
    children: layer.div.children.length,
    count: window.__paperai.annotationCount,
  };
  return out;
}));

console.log("\n=== save+verify ===");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasInk: r.hasInk, hasHL: r.hasHighlight };
}));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink-layer.png" });
await b.close();