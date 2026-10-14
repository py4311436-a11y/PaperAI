import puppeteer from "puppeteer-core";
import fs from "node:fs";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
p.on("console", (m) => { if (m.type() === "error" || m.text().includes("PaperAI")) console.log("[" + m.type() + "]", m.text()); });

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

console.log("\n=== UIManager prototype methods ===");
console.log(await p.evaluate(() => window.__paperai.uiManagerKeys));

console.log("\n=== storage probe ===");
console.log(await p.evaluate(() => {
  const um = window.__paperai._um;
  return { hasUmRef: !!um };
}));

// reach into the app's internal via a debug hook we add
console.log("\n=== annotation count via multiple paths ===");
console.log(await p.evaluate(() => {
  const out = {};
  const um = window.__paperaiUM;
  if (!um) return { err: "no __paperaiUM hook" };
  out.methods = Object.getOwnPropertyNames(Object.getPrototypeOf(um));
  try {
    const st = um.getAnnotationStorage?.();
    out.storageType = st?.constructor?.name;
    out.storageKeys = st ? Object.keys(st) : null;
    out.proto = st ? Object.getOwnPropertyNames(Object.getPrototypeOf(st)) : null;
    out.mapSize = st?._map?.size ?? st?.serializable?.size ?? null;
  } catch (e) { out.err = String(e); }
  return out;
}));

// Now actually try drawing ink via real mouse
console.log("\n=== set tool ink, then real drag ===");
await p.evaluate(() => window.__paperai.setTool("ink"));
await sleep(1200);
console.log("mode after ink:", await p.evaluate(() => window.__paperai.currentMode));

const box = await p.evaluate(() => {
  const pg = document.querySelector(".pdfViewer .page");
  const r = pg.getBoundingClientRect();
  const edl = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  return { x: r.x, y: r.y, w: r.width, h: r.height,
           edl: edl ? getComputedStyle(edl).display + "/" + getComputedStyle(edl).visibility : "NO-EDL-LAYER" };
});
console.log("page box + editorLayer:", box);

const cx = box.x + 250, cy = box.y + 200;
await p.mouse.move(cx, cy);
await p.mouse.down();
for (let i = 1; i <= 25; i++) { await p.mouse.move(cx + i * 5, cy + Math.sin(i / 3) * 20); await sleep(25); }
await p.mouse.up();
await sleep(1200);

console.log("annotation count after ink drag:", await p.evaluate(() => window.__paperai.annotationCount));
console.log("canvas elements in editor layer:", await p.evaluate(() =>
  document.querySelectorAll(".pdfViewer .annotationEditorLayer canvas").length));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink.png" });
await b.close();