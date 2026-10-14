/**
 * PaperAI PoC — automated verification harness.
 * Drives the real UI in headless Edge (same engine family as WebView2) and
 * records hard evidence for Test 1-4.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_BASE = "http://localhost:5180/";
const ROOT = "D:\\AIreader\\PaperAI-PoC";
const OUT = path.join(ROOT, "test-artifacts");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(id, name, status, notes) {
  results.push({ id, name, status, notes });
  const mark = status === "PASS" ? "PASS" : status === "PARTIAL" ? "PART" : "FAIL";
  console.log(`[${mark}] ${id} ${name}\n        ${notes}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForViewer(page, timeout = 45000) {
  await page.waitForFunction(() => window.__paperai?.hasUIManager === true, { timeout });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ["--allow-file-access-from-files", "--font-render-hinting=none"],
    defaultViewport: { width: 1400, height: 1000 },
  });
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + e.message));

  await page.goto(URL_BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__paperai, { timeout: 20000 });

  const pdfjsVersion = await page.evaluate(() => window.__paperai.version);
  console.log(`\n=== PDF.js version in browser: ${pdfjsVersion} ===\n`);

  // ---------------------------------------------------------------- load PDF B (IEEE dual-column)
  const pdfB = path.join(ROOT, "test-pdfs", "PDF-B.pdf");
  await page.evaluate(
    async (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await window.__paperai.loadByArrayBuffer(arr.buffer, "PDF-B.pdf");
    },
    fs.readFileSync(pdfB).toString("base64")
  );

  let uiManagerOk = true;
  try {
    await waitForViewer(page);
  } catch {
    uiManagerOk = false;
  }

  record(
    "T1.0",
    "AnnotationEditorUIManager 可获取",
    uiManagerOk ? "PASS" : "FAIL",
    uiManagerOk
      ? "通过 EventBus 'annotationeditoruimanager' 事件捕获成功"
      : "setDocument() 后未派发该事件 → AnnotationEditor 不可用"
  );

  if (!uiManagerOk) {
    console.log("\nUIManager 不可用，后续测试中止。console errors:");
    consoleErrors.slice(0, 20).forEach((e) => console.log("   " + e));
    await browser.close();
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, consoleErrors }, null, 2));
    return;
  }

  const uiKeys = await page.evaluate(() => window.__paperai.uiManagerKeys);
  fs.writeFileSync(path.join(OUT, "uiManager-prototype.json"), JSON.stringify(uiKeys, null, 2));

  const numPages = await page.evaluate(() => window.__paperai.numPages);
  record("T1.1", "打开本地 PDF", numPages > 0 ? "PASS" : "FAIL", `${numPages} 页`);

  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, "01-loaded-page1.png") });

  // ---------------------------------------------------------------- Text layer sanity
  const textStats = await page.evaluate(() => {
    const pages = document.querySelectorAll(".pdfViewer .page");
    let spans = 0;
    pages.forEach((p) => (spans += p.querySelectorAll(".textLayer span").length));
    return { pages: pages.length, spans };
  });
  record(
    "T1.2",
    "Text Layer 生成",
    textStats.spans > 0 ? "PASS" : "FAIL",
    `${textStats.spans} 个文本 span / ${textStats.pages} 个页面容器`
  );

  // ---------------------------------------------------------------- zoom / fit
  const zoomResults = {};
  for (const [name, fn] of [
    ["zoom200", () => window.__paperai.setScale(2)],
    ["zoom50", () => window.__paperai.setScale(0.5)],
    ["fitWidth", () => window.__paperai.fitWidth()],
    ["fitPage", () => window.__paperai.fitPage()],
  ]) {
    await page.evaluate(fn);
    await sleep(700);
    zoomResults[name] = await page.evaluate(() => window.__paperai.scale);
  }
  const zoomOk = Object.values(zoomResults).every((v) => v > 0.05);
  record(
    "T1.3",
    "Zoom / Fit 控件",
    zoomOk ? "PASS" : "FAIL",
    Object.entries(zoomResults)
      .map(([k, v]) => `${k}=${Number(v).toFixed(3)}`)
      .join(", ")
  );

  // ---------------------------------------------------------------- ALIGNMENT: span rect before/after zoom+scroll
  await page.evaluate(() => window.__paperai.setScale(1));
  await sleep(800);
  const probe = await page.evaluate(() => {
    // find a distinctive word in page 1
    const spans = Array.from(document.querySelectorAll(".pdfViewer .page .textLayer span"));
    const withText = spans.filter((s) => (s.textContent || "").trim().length > 8);
    if (!withText.length) return null;
    const target = withText[Math.floor(withText.length / 2)];
    const r = target.getBoundingClientRect();
    return {
      text: target.textContent.slice(0, 50),
      page: Number(target.closest(".page")?.dataset.pageNumber ?? 0),
      x: r.x, y: r.y, w: r.width, h: r.height,
      cssFontSize: getComputedStyle(target).fontSize,
    };
  });

  let alignPass = false, alignNotes = "";
  if (probe) {
    await page.evaluate(() => window.__paperai.setScale(2.5));
    await sleep(900);
    const after = await page.evaluate((needle) => {
      const spans = Array.from(document.querySelectorAll(".pdfViewer .page .textLayer span"));
      const m = spans.find((s) => (s.textContent || "").startsWith(needle.slice(0, 25)));
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, fs: getComputedStyle(m).fontSize };
    }, probe.text);

    if (after) {
      // canvas and text must scale together; check the span still sits on the page box
      const ratio = after.w / probe.w;
      const expected = 2.5;
      const ratioErr = Math.abs(ratio - expected) / expected;
      const fsRatio = parseFloat(after.fs) / parseFloat(probe.cssFontSize);
      alignPass = ratioErr < 0.08 && Math.abs(fsRatio - expected) / expected < 0.08;
      alignNotes = `span宽度比=${ratio.toFixed(3)}(期望${expected}) 字号比=${fsRatio.toFixed(3)} 误差=${(ratioErr * 100).toFixed(1)}%`;
    } else {
      alignNotes = "放大后未找到同一 span";
    }
    await page.screenshot({ path: path.join(OUT, "02-zoom250-alignment.png") });
  } else {
    alignNotes = "未找到可用文本 span";
  }
  record("T1.4", "缩放后 Text Layer 对齐", alignPass ? "PASS" : "FAIL", alignNotes);

  await page.evaluate(() => window.__paperai.setScale(1));
  await sleep(700);

  // ---------------------------------------------------------------- DUAL COLUMN: selection order
  const dual = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll(".pdfViewer .page .textLayer span"));
    const items = spans
      .map((s) => {
        const r = s.getBoundingClientRect();
        return { t: s.textContent || "", x: r.x, y: r.y, page: Number(s.closest(".page")?.dataset.pageNumber ?? 0) };
      })
      .filter((s) => s.t.trim().length > 3);
    if (!items.length) return null;

    const p1 = items.filter((s) => s.page === 1);
    // cluster into columns by x
    const xs = p1.map((s) => s.x).sort((a, b) => a - b);
    const mid = (xs[0] + xs[xs.length - 1]) / 2;
    const left = p1.filter((s) => s.x < mid);
    const right = p1.filter((s) => s.x >= mid);

    // sort each column in reading order (y then x)
    const byReading = (arr) => [...arr].sort((a, b) => a.y - b.y || a.x - b.x).map((s) => s.t).join("");
    // DOM order
    const domOrder = p1.map((s) => s.t).join("");

    return {
      totalSpans: items.length,
      page1Spans: p1.length,
      leftCount: left.length,
      rightCount: right.length,
      leftSample: left.sort((a, b) => a.y - b.y).slice(0, 6).map((s) => s.t.slice(0, 28)),
      rightSample: right.sort((a, b) => a.y - b.y).slice(0, 6).map((s) => s.t.slice(0, 28)),
      domOrderHead: domOrder.slice(0, 220),
      readingOrderHead: byReading(left).slice(0, 220),
    };
  });

  fs.writeFileSync(path.join(OUT, "dual-column-analysis.json"), JSON.stringify(dual, null, 2));

  const isDual = dual && dual.leftCount > 20 && dual.rightCount > 20;
  record(
    "T1.5",
    "IEEE 双栏检测",
    isDual ? "PASS" : "PARTIAL",
    dual
      ? `第1页 ${dual.page1Spans} span，左栏 ${dual.leftCount}，右栏 ${dual.rightCount}`
      : "无数据"
  );

  if (dual) {
    // PDF.js orders text layer spans in PDF content-stream order. For IEEE
    // 2-column papers produced by LaTeX/Word this is usually correct.
    const dom = dual.domOrderHead.replace(/\s+/g, " ").trim();
    const reading = dual.readingOrderHead.replace(/\s+/g, " ").trim();
    const first40 = dom.slice(0, 40);
    const readingFirst40 = reading.slice(0, 40);
    const orderOk = first40.length > 10 && first40 === readingFirst40;
    record(
      "T1.6",
      "双栏文本选择顺序",
      orderOk ? "PASS" : "PARTIAL",
      orderOk
        ? "DOM(内容流)顺序与视觉阅读顺序(左栏自上而下)前40字符一致"
        : `DOM前40="${first40}" / 阅读顺序前40="${readingFirst40}"`
    );
  }

  // ---------------------------------------------------------------- page scroll stability
  await page.evaluate(() => {
    document.querySelector("#viewerContainer").scrollTop = 1200;
  });
  await sleep(900);
  const afterScroll = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll(".pdfViewer .page .textLayer span"));
    const withText = spans.filter((s) => (s.textContent || "").trim().length > 8);
    const t = withText[Math.floor(withText.length / 2)];
    if (!t) return null;
    const r = t.getBoundingClientRect();
    const pg = t.closest(".page");
    const pr = pg.getBoundingClientRect();
    // span must be inside its page box
    const inside =
      r.x >= pr.x - 2 && r.x + r.width <= pr.x + pr.width + 2;
    return { inside, spanX: r.x, pageX: pr.x, pageW: pr.width };
  });
  record(
    "T1.7",
    "滚动后位置不错位",
    afterScroll?.inside ? "PASS" : afterScroll ? "FAIL" : "PARTIAL",
    afterScroll
      ? `span.x=${afterScroll.spanX.toFixed(1)} 落在 page 容器 [${afterScroll.pageX.toFixed(1)}, ${(afterScroll.pageX + afterScroll.pageW).toFixed(1)}] 内=${afterScroll.inside}`
      : "无数据"
  );
  await page.evaluate(() => (document.querySelector("#viewerContainer").scrollTop = 0));
  await sleep(700);

  // ---------------------------------------------------------------- HIGHLIGHT
  // Official user flow: select text while in Select (NONE) mode, then trigger
  // Highlight. Entering an editing mode first makes the text layer
  // non-selectable, so order matters.
  await page.evaluate(() => window.__paperai.setTool("select"));
  await sleep(600);

  const dragTarget = await page.evaluate(() => {
    const spans = Array.from(
      document.querySelectorAll(".pdfViewer .page .textLayer span")
    ).filter((s) => (s.textContent || "").trim().length > 30);
    if (!spans.length) return null;
    const s = spans[2];
    const r = s.getBoundingClientRect();
    return {
      x1: r.x + 1, y1: r.y + r.height / 2,
      x2: r.x + Math.min(r.width - 1, 150), y2: r.y + r.height / 2,
      text: s.textContent.slice(0, 40),
    };
  });

  if (dragTarget) {
    await page.mouse.move(dragTarget.x1, dragTarget.y1);
    await page.mouse.down();
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        dragTarget.x1 + ((dragTarget.x2 - dragTarget.x1) * i) / steps,
        dragTarget.y1
      );
      await sleep(20);
    }
    await page.mouse.up();
    await sleep(350);
  }
  const selectedText = await page.evaluate(() => window.getSelection().toString());

  const hlBefore = await page.evaluate(() => window.__paperai.annotationCount);
  const hlRes = await page.evaluate(async () => await window.__paperai.highlight());
  await sleep(500);
  const hlAfter = await page.evaluate(() => window.__paperai.annotationCount);

  record(
    "T2.1",
    "选中文字创建 Highlight",
    selectedText.length > 3 && hlAfter > hlBefore ? "PASS" : "FAIL",
    `选中="${selectedText.slice(0, 34)}" 批注 ${hlBefore} -> ${hlAfter} (highlightSelection=${hlRes})`
  );
  await page.screenshot({ path: path.join(OUT, "03-highlight.png") });

  // ---------------------------------------------------------------- INK
  await page.evaluate(() => window.__paperai.setTool("ink"));
  await sleep(800);
  const box = await page.evaluate(() => {
    const page = document.querySelector(".pdfViewer .page");
    if (!page) return null;
    const r = page.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  const inkBefore = await page.evaluate(() => window.__paperai.annotationCount);
  if (box) {
    const cx = box.x + box.w * 0.3;
    const cy = box.y + Math.min(box.h * 0.5, 300);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(cx + i * 4, cy + Math.sin(i / 3) * 25);
      await sleep(20);
    }
    await page.mouse.up();
    await sleep(800);
  }
  const inkAfter = await page.evaluate(() => window.__paperai.annotationCount);
  record(
    "T3.1",
    "鼠标绘制 Ink 轨迹",
    inkAfter > inkBefore ? "PASS" : "FAIL",
    `批注 ${inkBefore} -> ${inkAfter}`
  );
  await page.screenshot({ path: path.join(OUT, "04-ink.png") });

  // ---------------------------------------------------------------- SAVE + REOPEN VERIFY (Test 4)
  const saved = await page.evaluate(async () => {
    const data = await window.__paperai.save();
    if (!data) return { ok: false };
    const report = await window.__paperai.verify(data);
    return { ok: true, bytes: data.byteLength, report };
  });

  if (saved.ok) {
    fs.writeFileSync(
      path.join(OUT, "verify-report.json"),
      JSON.stringify(saved.report, null, 2)
    );
    const rc = saved.report.annotCountsBySubtype ?? {};
    record(
      "T4.1",
      "saveDocument() 生成 PDF",
      saved.bytes > 1000 ? "PASS" : "FAIL",
      `${saved.bytes} bytes`
    );
    const hasHL = saved.report.hasHighlight;
    const hasInk = saved.report.hasInk;
    record(
      "T4.2",
      "Highlight 写入 PDF Annotation",
      hasHL ? "PASS" : "FAIL",
      `Subtype/Highlight = ${rc["Highlight"] ?? 0}`
    );
    record(
      "T4.3",
      "Ink 写入 PDF Annotation",
      hasInk ? "PASS" : "FAIL",
      `Subtype/Ink = ${rc["Ink"] ?? 0}`
    );
    record(
      "T4.4",
      "重新打开后批注仍存在",
      hasHL && hasInk ? "PASS" : "PARTIAL",
      `全部 subtype: ${JSON.stringify(rc)}`
    );
    // Save the annotated PDF to disk for manual Acrobat/Edge inspection
    const b64 = await page.evaluate(async () => {
      const data = await window.__paperai.save();
      let s = "";
      const chunk = 0x8000;
      for (let i = 0; i < data.length; i += chunk) {
        s += String.fromCharCode.apply(null, Array.from(data.slice(i, i + chunk)));
      }
      return btoa(s);
    });
    const outDir = path.join(ROOT, "output");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "example_annotated.pdf"), Buffer.from(b64, "base64"));
  } else {
    record("T4.1", "saveDocument() 生成 PDF", "FAIL", "saveDocument() 返回 null");
  }

  // ---------------------------------------------------------------- UNICODE / space path
  const uniPath = path.join(ROOT, "test-pdfs", "IEEE期刊 空格测试", "参数提取方法 test.pdf");
  const uniResult = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    try {
      const d = await window.__paperai.loadByArrayBuffer(arr.buffer, "参数提取方法 test.pdf");
      return { ok: true, pages: d.numPages };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }, fs.readFileSync(uniPath).toString("base64"));
  record(
    "T6.1",
    "Unicode + 空格路径读取",
    uniResult.ok ? "PASS" : "FAIL",
    uniResult.ok ? `成功打开 ${uniResult.pages} 页` : String(uniResult.err)
  );

  await page.screenshot({ path: path.join(OUT, "05-unicode-path.png") });

  await browser.close();

  fs.writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify({ pdfjsVersion, results, consoleErrors: consoleErrors.slice(0, 40) }, null, 2)
  );
  console.log("\n=== console errors (first 20) ===");
  consoleErrors.slice(0, 20).forEach((e) => console.log("  " + e));
  console.log(`\nArtifacts -> ${OUT}`);
})().catch((e) => {
  console.error("HARNESS FAILURE:", e);
  process.exit(1);
});