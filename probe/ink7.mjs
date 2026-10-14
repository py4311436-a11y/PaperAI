import puppeteer from "puppeteer-core";
import fs from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));

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

console.log("=== probe the private static #editorTypes Map via a layer instance ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  const layer = um.getLayer(0);
  // The Map is a static private field. Reach it through a subclass-free trick:
  // any instance's prototype chain won't expose statics, so use
  // Object.getOwnPropertyNames on the constructor for hints, then try
  // known keys directly through behaviour.
  const Ctor = layer.constructor;
  const statics = Object.getOwnPropertyNames(Ctor);
  return { ctorName: Ctor.name, statics };
}));

console.log("\n=== Behavioural probe: which mode value makes canCreateNewEmptyEditor true? ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  const layer = um.getLayer(0);
  const results = {};
  for (const mode of [0, 3, 9, 13, 15, 101, 102, 16]) {
    try {
      await um.updateMode(mode);
      await new Promise((r) => setTimeout(r, 120));
      results[mode] = {
        canCreate: !!layer.canCreateNewEmptyEditor?.(),
        mode: um.getMode(),
        layerClass: layer.div.className,
      };
    } catch (e) { results[mode] = "err " + String(e).slice(0, 60); }
  }
  await um.updateMode(15);
  return results;
}));

console.log("\n=== Now draw in whichever mode allows it ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  const layer = um.getLayer(0);
  await um.updateMode(15);
  await new Promise((r) => setTimeout(r, 300));
  const r = layer.div.getBoundingClientRect();

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
  layer.pointerdown(mk("pointerdown", x0, y0, 1));
  await new Promise((z) => setTimeout(z, 60));
  const afterDown = { ink: document.querySelectorAll(".inkEditor").length, ch: layer.div.children.length };
  for (let i = 1; i <= 25; i++) {
    layer.div.dispatchEvent(mk("pointermove", x0 + i * 5, y0 + Math.sin(i / 3) * 18, 1));
    await new Promise((z) => setTimeout(z, 18));
  }
  layer.div.dispatchEvent(mk("pointerup", x0 + 125, y0, 0));
  await new Promise((z) => setTimeout(z, 900));

  return { afterDown, ink: document.querySelectorAll(".inkEditor").length,
           canvases: document.querySelectorAll(".annotationEditorLayer canvas").length,
           count: window.__paperai.annotationCount };
}));

console.log("\n=== save+verify ===");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasInk: r.hasInk };
}));

await b.close();