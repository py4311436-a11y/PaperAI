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
await sleep(1200);

// Instrument: log what pointerdown receives, and the state of its guards.
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  await um.updateMode(15);
  await new Promise((r) => setTimeout(r, 300));
  const layer = um.getLayer(0);
  const div = layer.div;

  const seen = [];
  const origPD = layer.pointerdown.bind(layer);
  layer.pointerdown = function (ev) {
    seen.push({
      target: ev.target ? ev.target.tagName + "." + ev.target.className : String(ev.target),
      targetIsDiv: ev.target === div,
      button: ev.button,
      ctrlKey: ev.ctrlKey,
      isTrusted: ev.isTrusted,
      type: ev.type,
      offsetX: ev.offsetX,
    });
    return origPD(ev);
  };
  const origSD = layer.startDrawingSession.bind(layer);
  layer.startDrawingSession = function (ev) {
    seen.push({ startDrawingSession: "CALLED" });
    try { return origSD(ev); } catch (e) { seen.push({ sdsErr: String(e) }); throw e; }
  };

  const r = div.getBoundingClientRect();
  const x = r.x + 150, y = r.y + 200;

  // real CDP-like: use dispatchEvent with a proper pointerdown on div
  const ev = new PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: "mouse", isPrimary: true,
    button: 0, buttons: 1, clientX: x, clientY: y,
  });
  div.dispatchEvent(ev);
  await new Promise((z) => setTimeout(z, 400));

  // also check FeatureTest.platform.isMac (affects ctrl+click guard)
  return {
    seen,
    canCreate: layer.canCreateNewEmptyEditor?.(),
    divStylePointerEvents: getComputedStyle(div).pointerEvents,
    divRect: { x: r.x, y: r.y, w: r.width, h: r.height },
  };
}));

await b.close();