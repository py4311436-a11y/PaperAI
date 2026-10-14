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

console.log("\n=== storage probe on pdfDocument.annotationStorage ===");
console.log(await p.evaluate(() => {
  const st = window.__paperaiUM?.__proto__ ? null : null;
  return null;
}));
console.log(await p.evaluate(() => {
  const doc = window.__paperaiDoc?.();
  return { hasHook: !!doc };
}));

// Use the app hook
console.log("\n=== annotationCount probe ===");
console.log("count:", await p.evaluate(() => window.__paperai.annotationCount));

// ---- HIGHLIGHT via real drag then highlightSelection()
console.log("\n=== highlight via drag + highlightSelection() ===");
await p.evaluate(() => window.__paperai.setTool("highlight"));
await sleep(700);
const t = await p.evaluate(() => {
  const spans = Array.from(document.querySelectorAll(".pdfViewer .page .textLayer span"))
    .filter((s) => (s.textContent || "").trim().length > 30);
  const s = spans[2]; const r = s.getBoundingClientRect();
  return { x: r.x, y: r.y, h: r.height, w: r.width, txt: s.textContent.slice(0, 40) };
});
console.log("target:", t);
await p.mouse.move(t.x + 2, t.y + t.h / 2);
await p.mouse.down();
for (let i = 1; i <= 14; i++) { await p.mouse.move(t.x + 2 + i * Math.min(9, t.w / 16), t.y + t.h / 2); await sleep(25); }
await p.mouse.up();
await sleep(400);
console.log("selection after drag:", await p.evaluate(() => window.getSelection().toString().slice(0, 60)));
console.log("count before highlightSelection:", await p.evaluate(() => window.__paperai.annotationCount));
console.log("highlightSelection() ->", await p.evaluate(async () => await window.__paperai.highlight()));
await sleep(600);
console.log("count after:", await p.evaluate(() => window.__paperai.annotationCount));
console.log("editor canvases:", await p.evaluate(() => document.querySelectorAll(".annotationEditorLayer canvas").length));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-highlight.png" });
await b.close();