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

// instrument: patch the layer's pointerdown to log why it bails
console.log("=== instrument layer pointerdown ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  await um.updateMode(15);
  const layer = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = layer.getBoundingClientRect();
  const probe = { x: r.x + 120, y: r.y + 180 };

  const el = document.elementFromPoint(probe.x, probe.y);
  const info = {
    layerIsDiv: layer.tagName,
    elementFromPoint: el ? el.tagName + "." + el.className : null,
    sameAsLayer: el === layer,
    layerRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    // does the layer even have listeners? check via getEventListeners is devtools-only;
    // instead check that pointerdown is reachable on prototype
  };

  // Try calling the layer's own pointerdown with a synthetic event object
  let err = null;
  try {
    const ev = new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse",
      isPrimary: true, button: 0, buttons: 1,
      clientX: probe.x, clientY: probe.y,
      offsetX: 120, offsetY: 180,
    });
    Object.defineProperty(ev, "target", { value: layer, configurable: true });
    layer.dispatchEvent(ev);
  } catch (e) { err = String(e); }
  info.dispatchErr = err;

  await new Promise((r2) => setTimeout(r2, 400));
  info.afterLayerDispatch = {
    ink: document.querySelectorAll(".inkEditor").length,
    children: layer.children.length,
  };
  return info;
}));

// Directly try createAndAddNewEditor on the layer if reachable via UIManager
console.log("\n=== try direct editor creation paths ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  const out = {};
  // UIManager may keep layers in a private map; try common accessors
  out.umMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(um))
    .filter((k) => /layer|Layer|editor|Editor/i.test(k));
  try {
    out.getLayer = typeof um.getLayer === "function" ? String(um.getLayer(0)) : "no getLayer";
  } catch (e) { out.getLayerErr = String(e); }
  return out;
}));

await b.close();