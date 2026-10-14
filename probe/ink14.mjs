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

await p.click("#btn-ink");
await sleep(1300);

console.log("=== intercept the real pointerdown and log every guard ===");
console.log(await p.evaluate(async () => {
  const layer = window.__paperaiUM.getLayer(0);
  const div = layer.div;
  const trace = [];

  // Wrap the instance methods PDF.js actually calls.
  const wrap = (obj, name) => {
    const orig = obj[name];
    if (typeof orig !== "function") { trace.push(`${name}: NOT A FUNCTION`); return; }
    obj[name] = function (...a) {
      trace.push(`> ${name}(${a.length} args)`);
      try {
        const r = orig.apply(this, a);
        trace.push(`  ${name} returned ${r === undefined ? "undefined" : typeof r}`);
        return r;
      } catch (e) {
        trace.push(`  !! ${name} THREW: ${e.message}`);
        throw e;
      }
    };
  };
  ["startDrawingSession", "pointerdown", "pointerup", "endDrawingSession", "createAndAddNewEditor", "draw"].forEach((n) => wrap(layer, n));
  if (layer.drawLayer) ["draw", "updateProperties", "remove"].forEach((n) => wrap(layer.drawLayer, n));

  // Real mouse gesture
  const r = div.getBoundingClientRect();
  const x0 = r.x + 140, y0 = r.y + 240;
  div.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 11, pointerType: "mouse", isPrimary: true,
    button: 0, buttons: 1, clientX: x0, clientY: y0,
  }));
  await new Promise((z) => setTimeout(z, 200));
  trace.push(`-- after down: layerChildren=${div.children.length} layerClass="${div.className}"`);

  for (let i = 1; i <= 15; i++) {
    div.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 11, pointerType: "mouse", isPrimary: true,
      button: 0, buttons: 1, clientX: x0 + i * 6, clientY: y0 + Math.sin(i / 3) * 15,
    }));
    await new Promise((z) => setTimeout(z, 25));
  }
  trace.push(`-- after moves: layerChildren=${div.children.length}`);

  window.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 11, pointerType: "mouse", isPrimary: true,
    button: 0, buttons: 0, clientX: x0 + 90, clientY: y0,
  }));
  await new Promise((z) => setTimeout(z, 900));
  trace.push(`-- after up: layerChildren=${div.children.length} ink=${document.querySelectorAll(".inkEditor").length}`);

  return trace;
}));

await b.close();