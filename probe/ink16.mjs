/**
 * Ink verification, take 3.
 *
 * Root cause established from pdf.mjs 6.4.299:
 *   DrawingEditor._endDraw() -> if (this.supportMultipleDrawings) { ...save undo...; return; }
 *   InkEditor.supportMultipleDrawings === true
 * => a single mouse-up does NOT create a PDF annotation. The stroke stays on
 *    the drawLayer's temp canvas. The editor is committed on a SUBSEQUENT
 *    pointerdown (startDrawing re-entry) which calls #currentDraw.startNew(...)
 *    and flushes the previous stroke, or when the session is ended.
 *
 * So the correct gesture is: stroke A -> stroke B, then check.
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

await p.evaluate(async () => { await window.__paperaiUM.updateMode(15, null, true); });
await sleep(600);

const box = await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  const r = l.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

async function stroke(x, y, dx, dy, amp = 18, n = 26) {
  await p.mouse.move(x, y);
  await sleep(180);
  await p.mouse.down({ button: "left" });
  await sleep(140);
  for (let i = 1; i <= n; i++) {
    await p.mouse.move(x + i * dx, y + Math.sin(i / 4) * amp);
    await sleep(26);
  }
  await sleep(140);
  await p.mouse.up({ button: "left" });
  await sleep(700);
}

const snap = () => p.evaluate(() => ({
  ink: document.querySelectorAll(".inkEditor").length,
  canvases: document.querySelectorAll(".annotationEditorLayer canvas").length,
  count: window.__paperai.annotationCount,
  cls: document.querySelector(".pdfViewer .page .annotationEditorLayer").className,
}));

console.log("state before:", await snap());

console.log("\n-- stroke 1 --");
await stroke(box.x + 150, box.y + 250, 5, 0);
console.log("after stroke1:", await snap());

console.log("\n-- stroke 2 (triggers commit of stroke 1) --");
await stroke(box.x + 330, box.y + 330, -5, 0);
console.log("after stroke2:", await snap());

console.log("\n-- stroke 3 --");
await stroke(box.x + 170, box.y + 430, 4, 0);
console.log("after stroke3:", await snap());

console.log("\n=== force session end (blur / commitOrRemove) ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  const layer = um.getLayer(0);
  layer.commitOrRemove?.();
  layer.endDrawingSession?.();
  await new Promise((r) => setTimeout(r, 900));
  return {
    ink: document.querySelectorAll(".inkEditor").length,
    canvases: document.querySelectorAll(".annotationEditorLayer canvas").length,
    count: window.__paperai.annotationCount,
  };
}));

console.log("\n=== save + verify ===");
const res = await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasInk: r.hasInk };
});
console.log(res);

if (res.ok && res.hasInk) {
  const out = await p.evaluate(async () => {
    const data = await window.__paperai.save();
    let s = "";
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(data.slice(i, i + 0x8000)));
    return btoa(s);
  });
  fs.mkdirSync("D:/AIreader/PaperAI-PoC/output", { recursive: true });
  fs.writeFileSync("D:/AIreader/PaperAI-PoC/output/example_annotated.pdf", Buffer.from(out, "base64"));
  console.log("SAVED -> output/example_annotated.pdf");
}

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/ink-multistroke.png" });
await b.close();