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

// ---- STEP 1: stay in Select mode, drag to select
console.log("STEP 1 — select text in NONE mode");
console.log("mode now:", await p.evaluate(() => window.__paperai.currentMode));

const t = await p.evaluate(() => {
  const spans = Array.from(document.querySelectorAll(".pdfViewer .page .textLayer span"))
    .filter((s) => (s.textContent || "").trim().length > 30);
  const s = spans[2]; const r = s.getBoundingClientRect();
  return { x: r.x, y: r.y, h: r.height, w: r.width, txt: s.textContent.slice(0, 40) };
});
await p.mouse.move(t.x + 2, t.y + t.h / 2);
await p.mouse.down();
for (let i = 1; i <= 16; i++) { await p.mouse.move(t.x + 2 + (i * Math.min(9, t.w / 18)), t.y + t.h / 2); await sleep(25); }
await p.mouse.up();
await sleep(400);
console.log("selection:", JSON.stringify((await p.evaluate(() => window.getSelection().toString())).slice(0, 60)));

// ---- STEP 2: click the Highlight button (which calls highlightSelection)
console.log("\nSTEP 2 — click Highlight button");
await p.click("#btn-highlight");
await sleep(1200);
console.log("mode after:", await p.evaluate(() => window.__paperai.currentMode));
console.log("annotationCount:", await p.evaluate(() => window.__paperai.annotationCount));
console.log("editor canvases:", await p.evaluate(() => document.querySelectorAll(".annotationEditorLayer canvas").length));
console.log("editorLayer html sample:", await p.evaluate(() => {
  const el = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  return el ? el.innerHTML.slice(0, 300) : "(none)";
}));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-highlight.png" });

// ---- STEP 3: save & verify
console.log("\nSTEP 3 — saveDocument + verify");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasHL: r.hasHighlight };
}));

await b.close();