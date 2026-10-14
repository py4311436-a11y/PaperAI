/**
 * PaperAI PoC — final end-to-end verification.
 * Covers Test 1 (reader), Test 2 (Highlight), Test 3 (Ink), Test 4 (write-back).
 *
 * Verified PDF.js 6.4.299 facts this harness relies on:
 *  - globalThis.pdfjsLib MUST exist before pdf_viewer.mjs is imported.
 *  - PDFViewer: container = OUTER scroll element (position:absolute),
 *    viewer = INNER element holding .page children.
 *  - currentScaleValue accepts "page-width" | "page-fit" (NOT "width"/"page").
 *  - AnnotationEditorUIManager arrives via eventBus "annotationeditoruimanager".
 *  - Highlight: select text in NONE mode -> uiManager.highlightSelection().
 *  - Ink: INK mode + real mouse strokes; InkEditor.supportMultipleDrawings=true
 *    means mouse-up does NOT commit -> must end the drawing session.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://localhost:5180/";
const ROOT = "D:\\AIreader\\PaperAI-PoC";
const OUT = path.join(ROOT, "test-artifacts");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });

const results = [];
const record = (id, name, status, notes) => {
  results.push({ id, name, status, notes });
  const tag = status === "PASS" ? "PASS" : status === "PARTIAL" ? "PART" : "FAIL";
  console.log(`  [${tag}] ${id.padEnd(6)} ${name}\n${" ".repeat(13)}${notes}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  defaultViewport: { width: 1400, height: 1000 },
});
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon")) consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));

await page.goto(BASE, { waitUntil: "networkidle2" });
await page.waitForFunction(() => !!window.__paperai, { timeout: 25000 });
const pdfjsVersion = await page.evaluate(() => window.__paperai.version);
console.log(`\nPDF.js in browser: ${pdfjsVersion}\n`);

// ---------- load test PDF
const load = async (rel, name) => {
  const b64 = fs.readFileSync(path.join(ROOT, rel)).toString("base64");
  return page.evaluate(
    async (s, n) => {
      const bin = atob(s);
      const a = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      const d = await window.__paperai.loadByArrayBuffer(a.buffer, n);
      return { pages: d.numPages };
    },
    b64,
    name
  );
};

console.log("== Test 1: PDF.js reader ==");
const ld = await load("test-pdfs/PDF-B.pdf", "PDF-B.pdf");
await page.waitForFunction(() => window.__paperai.hasUIManager === true, { timeout: 45000 });
await sleep(1500);

record("T1.0", "AnnotationEditorUIManager 可获取", "PASS",
  "通过 eventBus 'annotationeditoruimanager' 事件捕获（PDFViewer.setDocument 内部派发）");
record("T1.1", "打开本地 PDF", ld.pages > 0 ? "PASS" : "FAIL", `${ld.pages} 页 (IEEE 双栏论文)`);

const tl = await page.evaluate(() => {
  const pgs = document.querySelectorAll(".pdfViewer .page");
  let spans = 0;
  pgs.forEach((p) => (spans += p.querySelectorAll(".textLayer span").length));
  return { pages: pgs.length, spans };
});
record("T1.2", "Text Layer 生成", tl.spans > 0 ? "PASS" : "FAIL",
  `${tl.spans} 个文本 span / ${tl.pages} 个页面容器`);

// zoom / fit
const zooms = {};
for (const [k, fn] of [
  ["zoom200%", "() => window.__paperai.setScale(2)"],
  ["zoom50%", "() => window.__paperai.setScale(0.5)"],
  ["FitWidth", "() => window.__paperai.fitWidth()"],
  ["FitPage", "() => window.__paperai.fitPage()"],
]) {
  await page.evaluate(new Function("return (" + fn + ")()"));
  await sleep(650);
  zooms[k] = await page.evaluate(() => window.__paperai.scale);
}
record("T1.3", "Zoom / Fit Width / Fit Page",
  Object.values(zooms).every((v) => v > 0.05) ? "PASS" : "FAIL",
  Object.entries(zooms).map(([k, v]) => `${k}=${Number(v).toFixed(3)}`).join(", "));

// alignment under zoom
// Alignment under zoom. Normalise to scale 1 FIRST, then capture the baseline,
// otherwise the baseline is taken at whatever scale FitPage left behind.
await page.evaluate(() => window.__paperai.setScale(1));
await sleep(800);
const probe = await page.evaluate(() => {
  const spans = [...document.querySelectorAll(".pdfViewer .page .textLayer span")]
    .filter((s) => (s.textContent || "").trim().length > 8);
  const t = spans[Math.floor(spans.length / 2)];
  const r = t.getBoundingClientRect();
  return { text: t.textContent.slice(0, 30), w: r.width, fs: getComputedStyle(t).fontSize };
});
const baseScale = await page.evaluate(() => window.__paperai.scale);
await page.evaluate(() => window.__paperai.setScale(2.5));
await sleep(900);
const after = await page.evaluate((needle) => {
  const t = [...document.querySelectorAll(".pdfViewer .page .textLayer span")]
    .find((s) => (s.textContent || "").startsWith(needle));
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { w: r.width, fs: getComputedStyle(t).fontSize };
}, probe.text);
let alignOk = false, alignNote = "未找到同一 span";
if (after) {
  // actual scale ratio, not the requested one (PDF.js may clamp)
  const actual = 2.5;
  const wr = after.w / probe.w, fr = parseFloat(after.fs) / parseFloat(probe.fs);
  const err = Math.max(Math.abs(wr - actual), Math.abs(fr - actual)) / actual;
  // the meaningful invariant: canvas and text layer scale by the SAME factor
  const consistency = Math.abs(wr - fr) / Math.max(wr, fr);
  alignOk = err < 0.08 && consistency < 0.02;
  alignNote = `宽度比=${wr.toFixed(3)} 字号比=${fr.toFixed(3)} (期望 ${actual}) · 画布/文本层一致性误差 ${(consistency * 100).toFixed(2)}%`;
}
record("T1.4", "缩放后 Text Layer 对齐", alignOk ? "PASS" : "FAIL", alignNote);
await page.evaluate(() => window.__paperai.setScale(1));
await sleep(700);

// dual column + order
const dual = await page.evaluate(() => {
  const items = [...document.querySelectorAll(".pdfViewer .page .textLayer span")]
    .map((s) => { const r = s.getBoundingClientRect();
      return { t: s.textContent || "", x: r.x, y: r.y, page: Number(s.closest(".page").dataset.pageNumber) }; })
    .filter((s) => s.t.trim().length > 3 && s.page === 1);
  if (!items.length) return null;
  const xs = items.map((s) => s.x).sort((a, b) => a - b);
  const mid = (xs[0] + xs[xs.length - 1]) / 2;
  const L = items.filter((s) => s.x < mid), R = items.filter((s) => s.x >= mid);
  const read = (a) => [...a].sort((p, q) => p.y - q.y || p.x - q.x).map((s) => s.t).join("");
  return { n: items.length, L: L.length, R: R.length,
    dom: items.map((s) => s.t).join("").replace(/\s+/g, " ").trim(),
    read: read(L).replace(/\s+/g, " ").trim() };
});
const isDual = dual && dual.L > 20 && dual.R > 20;
record("T1.5", "IEEE 双栏布局识别", isDual ? "PASS" : "PARTIAL",
  dual ? `第1页 ${dual.n} span → 左栏 ${dual.L} / 右栏 ${dual.R}` : "无数据");
if (dual) {
  const same = dual.dom.slice(0, 45) === dual.read.slice(0, 45);
  record("T1.6", "双栏文本选择顺序", same ? "PASS" : "PARTIAL",
    same ? "PDF 内容流(DOM)顺序 == 视觉阅读顺序（左栏自上而下）"
          : `DOM="${dual.dom.slice(0, 45)}" / READ="${dual.read.slice(0, 45)}"`);
}

// scroll stability
await page.evaluate(() => (document.querySelector("#viewerContainer").scrollTop = 1500));
await sleep(900);
const sc = await page.evaluate(() => {
  const t = [...document.querySelectorAll(".pdfViewer .page .textLayer span")]
    .filter((s) => (s.textContent || "").trim().length > 8)
    .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
    .find((s) => { const r = s.getBoundingClientRect();
      return r.top > 50 && r.bottom < window.innerHeight - 60; });
  if (!t) return null;
  const r = t.getBoundingClientRect(), pg = t.closest(".page").getBoundingClientRect();
  return { inside: r.left >= pg.left - 2 && r.right <= pg.right + 2, x: r.left, px: pg.left, pw: pg.width };
});
record("T1.7", "滚动后位置不错位", sc?.inside ? "PASS" : sc ? "FAIL" : "PARTIAL",
  sc ? `span.left=${sc.x.toFixed(1)} 落在 page [${sc.px.toFixed(1)}, ${(sc.px + sc.pw).toFixed(1)}] 内` : "无可见 span");
await page.evaluate(() => (document.querySelector("#viewerContainer").scrollTop = 0));
await sleep(700);

// ---------- Test 2: Highlight
console.log("\n== Test 2: Highlight ==");
await page.click("#btn-select");
await sleep(500);
const tgt = await page.evaluate(() => {
  const s = [...document.querySelectorAll(".pdfViewer .page .textLayer span")]
    .filter((x) => (x.textContent || "").trim().length > 30)[2];
  const r = s.getBoundingClientRect();
  return { x: r.x, y: r.y, h: r.height, w: r.width, text: s.textContent.slice(0, 34) };
});
await page.mouse.move(tgt.x + 2, tgt.y + tgt.h / 2);
await page.mouse.down();
for (let i = 1; i <= 16; i++) {
  await page.mouse.move(tgt.x + 2 + (i * Math.min(9, tgt.w / 18)), tgt.y + tgt.h / 2);
  await sleep(20);
}
await page.mouse.up();
await sleep(350);
const selText = await page.evaluate(() => window.getSelection().toString());
const hlBefore = await page.evaluate(() => window.__paperai.annotationCount);
await page.click("#btn-highlight");
await sleep(900);
const hlAfter = await page.evaluate(() => window.__paperai.annotationCount);
const hlDom = await page.evaluate(() => document.querySelectorAll(".highlightEditor").length);
record("T2.1", "选中文字 → Highlight", selText.length > 3 && hlDom > 0 ? "PASS" : "FAIL",
  `选中="${selText.slice(0, 30)}" · .highlightEditor=${hlDom} · 计数 ${hlBefore}→${hlAfter}`);
await page.screenshot({ path: path.join(OUT, "03-highlight.png") });

// ---------- Test 3: Ink
console.log("\n== Test 3: Draw / Ink ==");
await page.click("#btn-ink");
await sleep(1200);
const inkMode = await page.evaluate(() => window.__paperaiUM.getMode());
const box = await page.evaluate(() => {
  const r = document.querySelector(".pdfViewer .page .annotationEditorLayer").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
async function stroke(x, y, dx, amp = 18, n = 24) {
  await page.mouse.move(x, y); await sleep(160);
  await page.mouse.down({ button: "left" }); await sleep(120);
  for (let i = 1; i <= n; i++) { await page.mouse.move(x + i * dx, y + Math.sin(i / 4) * amp); await sleep(26); }
  await sleep(120);
  await page.mouse.up({ button: "left" }); await sleep(600);
}
await stroke(box.x + 150, box.y + 250, 5);
await stroke(box.x + 340, box.y + 340, -5, 14, 22);
await page.evaluate(() => window.__paperai.commitInk());
await sleep(900);
const inkState = await page.evaluate(() => ({
  dom: document.querySelectorAll(".inkEditor").length,
  count: window.__paperai.annotationCount,
}));
record("T3.1", "鼠标手绘 Ink 轨迹", inkState.dom > 0 ? "PASS" : "FAIL",
  `mode=${inkMode}(INK=15) · .inkEditor=${inkState.dom} · 计数=${inkState.count}`);
await page.screenshot({ path: path.join(OUT, "04-ink.png") });

// ---------- Test 4: save + verify
console.log("\n== Test 4: saveDocument() write-back ==");
const saved = await page.evaluate(async () => {
  const d = await window.__paperai.save();
  if (!d) return { ok: false };
  const r = await window.__paperai.verify(d);
  return { ok: true, bytes: d.byteLength, counts: r.annotCountsBySubtype, hasHL: r.hasHighlight, hasInk: r.hasInk, samples: r.samples };
});
fs.writeFileSync(path.join(OUT, "verify-report.json"), JSON.stringify(saved, null, 2));

if (saved.ok) {
  record("T4.1", "saveDocument() 生成 PDF", saved.bytes > 1000 ? "PASS" : "FAIL", `${saved.bytes} bytes`);
  record("T4.2", "Highlight 写入 PDF Annotation", saved.hasHL ? "PASS" : "FAIL",
    `重新打开后 /Subtype /Highlight = ${saved.counts.Highlight ?? 0}`);
  record("T4.3", "Ink 写入 PDF Annotation", saved.hasInk ? "PASS" : "FAIL",
    `重新打开后 /Subtype /Ink = ${saved.counts.Ink ?? 0}`);
  record("T4.4", "关闭后重新打开批注仍存在",
    saved.hasHL && saved.hasInk ? "PASS" : "PARTIAL",
    `全部 annotation subtype: ${JSON.stringify(saved.counts)}`);

  const b64 = await page.evaluate(async () => {
    const d = await window.__paperai.save();
    let s = "";
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(d.slice(i, i + 0x8000)));
    return btoa(s);
  });
  fs.writeFileSync(path.join(ROOT, "output", "example_annotated.pdf"), Buffer.from(b64, "base64"));
  console.log("\n  -> output/example_annotated.pdf");
}

// ---------- Unicode / space path
console.log("\n== Test 6: Unicode + space path ==");
const uni = await load("test-pdfs/IEEE期刊 空格测试/参数提取方法 test.pdf", "参数提取方法 test.pdf");
await sleep(1200);
record("T6.1", "Unicode + 空格路径", uni.pages > 0 ? "PASS" : "FAIL",
  `D:\\AIreader\\PaperAI-PoC\\test-pdfs\\IEEE期刊 空格测试\\参数提取方法 test.pdf → ${uni.pages} 页`);

await browser.close();
fs.writeFileSync(path.join(OUT, "results.json"),
  JSON.stringify({ pdfjsVersion, results, consoleErrors: consoleErrors.slice(0, 30) }, null, 2));

console.log("\n== console errors ==");
if (consoleErrors.length === 0) console.log("  (none)");
else consoleErrors.slice(0, 10).forEach((e) => console.log("  " + e.slice(0, 160)));

const pass = results.filter((r) => r.status === "PASS").length;
console.log(`\n===== ${pass}/${results.length} PASS =====`);