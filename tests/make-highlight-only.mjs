// Produce a clean, unambiguous cross-reader artefact: a single Highlight on a
// pure-text passage, no ink, no figures.
//
// Why: the WPS screenshots of the real paper contain yellow flow-chart nodes,
// which fool a naive "is there yellow" detector. A figure-free page removes
// that ambiguity so the cross-reader verdict is objective.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CdpPage, webview2AutomationArgs, waitBrowserEndpoint, waitPageTarget } from "./lib-cdp.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\PaperAI.exe";
const PORT = Number(process.argv[3] ?? 9800);
const SRC = path.join(ROOT, "test-fixtures", "single", "PDF-A-single.pdf");
const OUT = path.join(ROOT, "output", "highlight-only.pdf");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2AutomationArgs(PORT) },
  stdio: "ignore",
});

try {
  await waitBrowserEndpoint(PORT);
  await waitPageTarget(PORT);
  const page = await CdpPage.attachTauriPage(PORT);
  await page.waitFor("window.__paperai && window.__paperai.ready === true", 45000, "ready");
  await page.eval(`window.__paperai.open(${JSON.stringify(SRC)})`);
  await page.waitFor(
    "document.querySelectorAll('.pdfViewer .page .textLayer span').length > 3",
    30000,
    "text layer"
  );
  await sleep(800);

  // Pick a span in the middle of a text block, well clear of any figure.
  const box = await page.eval(`(() => {
    const vpH = innerHeight;
    const spans = [...document.querySelectorAll(".pdfViewer .page .textLayer span")]
      .filter(s => (s.textContent||"").trim().length > 40)
      .filter(s => { const r = s.getBoundingClientRect(); return r.top >= 120 && r.bottom <= vpH - 40 && r.width > 120; });
    if (!spans.length) return null;
    const s = spans[Math.floor(spans.length / 2)];
    const r = s.getBoundingClientRect();
    return { x1: r.x + 2, y1: r.y + r.height / 2, x2: r.x + r.width - 4, text: s.textContent.slice(0, 50) };
  })()`);
  if (!box) throw new Error("no suitable span found");

  await page.drag({ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y1 }, 12, 20);
  await sleep(400);
  const sel = await page.eval(`window.__paperai.getSelection()`);
  const before = await page.eval(`window.__paperai.annotationCount`);
  await page.eval(`window.__paperai.highlight()`);
  await sleep(600);
  const after = await page.eval(`window.__paperai.annotationCount`);
  console.log(`selected ${sel.length} chars -> annotation ${before} -> ${after}`);

  const b64 = await page.eval(`(async () => { const b = await window.__paperai.serialize(); let s=""; const C=0x8000; for (let i=0;i<b.length;i+=C) s += String.fromCharCode.apply(null, Array.from(b.subarray(i,i+C))); return btoa(s); })()`);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(b64, "base64"));
  console.log("wrote:", OUT);
} catch (e) {
  console.log("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  try { page?.close(); } catch {}
  try { child.kill(); } catch {}
}
