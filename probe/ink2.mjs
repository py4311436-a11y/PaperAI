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

console.log("=== INK mode: click Draw, wait, inspect ===");
await p.click("#btn-ink");
await sleep(1500);

console.log("mode:", await p.evaluate(() => {
  const um = window.__paperaiUM;
  try { return um.getMode?.(); } catch (e) { return "err:" + e; }
}));
console.log("isEditingMode:", await p.evaluate(() => window.__paperaiUM?.isEditingMode?.()));
console.log("registered editor types:", await p.evaluate(() => {
  try { return window.__paperaiUM?.getEditors?.(0)?.length; } catch (e) { return "err"; }
}));

// check what the editor layer looks like in ink mode
console.log("\n=== editor layer state in INK mode ===");
console.log(await p.evaluate(() => {
  const layers = document.querySelectorAll(".pdfViewer .page .annotationEditorLayer");
  return [...layers].slice(0, 3).map((l) => ({
    id: l.id, cls: l.className,
    children: l.children.length,
    display: getComputedStyle(l).display,
    pointerEvents: getComputedStyle(l).pointerEvents,
  }));
}));

// what's the topmost element at the point where we want to draw?
const box = await p.evaluate(() => {
  const pg = document.querySelector(".pdfViewer .page");
  const r = pg.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const cx = box.x + 200, cy = box.y + 250;
console.log("\nelementFromPoint:", await p.evaluate((x, y) => {
  const el = document.elementFromPoint(x, y);
  return el ? el.tagName + "." + el.className + " (pe=" + getComputedStyle(el).pointerEvents + ")" : "null";
}, cx, cy));

console.log("\n=== draw attempt ===");
await p.mouse.move(cx, cy);
await p.mouse.down();
for (let i = 1; i <= 30; i++) { await p.mouse.move(cx + i * 4, cy + Math.sin(i / 3) * 20); await sleep(22); }
await p.mouse.up();
await sleep(1200);

console.log("annotationCount:", await p.evaluate(() => window.__paperai.annotationCount));
console.log("inkEditor elements:", await p.evaluate(() => document.querySelectorAll(".inkEditor").length));
console.log("editorLayer canvases:", await p.evaluate(() => document.querySelectorAll(".annotationEditorLayer canvas").length));
console.log("layer html:", await p.evaluate(() => {
  const l = document.querySelector(".pdfViewer .page .annotationEditorLayer");
  return l ? l.innerHTML.slice(0, 400) : "(none)";
}));

console.log("\n=== save & verify after ink ===");
console.log(await p.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype };
}));

await p.screenshot({ path: "D:/AIreader/PaperAI-PoC/test-artifacts/diag-ink2.png" });
await b.close();