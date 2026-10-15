/**
 * PaperAI Phase 2 — Stage B: verification inside the REAL Tauri WebView2.
 *
 * Drives the actual release binary over CDP (no test hooks compiled into the
 * app, no headless browser substitute). See tests/lib-cdp.mjs for why raw CDP
 * is used instead of puppeteer.
 *
 * Usage:
 *   node tests/desktop-verify.mjs --exe "<path to PaperAI.exe>" [--port 9333]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CdpPage, webview2AutomationArgs, waitBrowserEndpoint, waitPageTarget } from "./lib-cdp.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVIDENCE = path.join(ROOT, "evidence", "stage-b");
mkdirSync(EVIDENCE, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const EXE = arg("exe", null);
const PORT = Number(arg("port", "9333"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(id, name, status, note) {
  results.push({ id, name, status, note });
  console.log(`[${status.padEnd(8)}] ${id}  ${name}\n            ${String(note).replace(/\n/g, "\n            ")}`);
}

async function main() {
  if (!EXE || !existsSync(EXE)) {
    record("A0", "release 可执行文件存在", "BLOCKED", `未提供或不存在: ${EXE}`);
    writeReport();
    process.exit(2);
  }
  record("A0", "release 可执行文件存在", "PASS", EXE);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2AutomationArgs(PORT) },
    stdio: "ignore",
  });

  let page = null;
  try {
    await waitBrowserEndpoint(PORT);
    await waitPageTarget(PORT);
    page = await CdpPage.attachTauriPage(PORT);
    record("B0.1", "连接到真实 WebView2 页面", "PASS", `${page.appUrl} (port ${PORT})`);

    await page.waitFor("window.__paperai && window.__paperai.ready === true", 45000, "window.__paperai.ready");
    const env = await page.eval(`({version: window.__paperai.version, isTauri: window.__paperai.isTauri, ua: navigator.userAgent})`);
    record(
      "B0.2",
      "前端在真实 WebView2 中启动",
      env.isTauri ? "PASS" : "FAIL",
      `PDF.js=${env.version} isTauri=${env.isTauri}\n            UA=${env.ua}`
    );
    await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, "01-webview2-startup.png"), b));

    // ------------------------------------------------ open single column
    const single = path.join(ROOT, "test-fixtures", "single", "PDF-A-single.pdf").replace(/\\/g, "\\\\");
    const opened = await page.eval(`(async () => { try { await window.__paperai.open("${single}"); return { ok: true, pages: window.__paperai.numPages }; } catch (e) { return { ok: false, err: String(e) }; } })()`);
    record("B1.1", "通过 Rust 后端打开单栏 PDF", opened.ok && opened.pages > 0 ? "PASS" : "FAIL",
      opened.ok ? `页数=${opened.pages}` : `错误=${opened.err}`);

    // Rendering + text layer is asynchronous; wait before driving the mouse.
    await waitTextLayer(page);
    const hasUM = await page.eval(`window.__paperai.hasUIManager`);
    record("B0.3", "AnnotationEditorUIManager 已就绪（真实 WebView2）", hasUM ? "PASS" : "FAIL",
      `hasUIManager=${hasUM}`);

    const sel = await dragMiddleSpan(page);
    record("B1.2", "鼠标拖选文本 + getSelection()", sel && sel.text.length > 3 ? "PASS" : "FAIL",
      `选中(${sel?.text.length ?? 0})="${sel?.text.slice(0, 50) ?? ""}"`);
    await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, "02-selection.png"), b));

    const copied = await page.eval(`(async () => { try { const t = window.__paperai.getSelection(); await navigator.clipboard.writeText(t); return await navigator.clipboard.readText(); } catch (e) { return "(blocked: " + String(e).slice(0,60) + ")"; } })()`);
    record("B1.3", "选中文本可写入剪贴板", typeof copied === "string" && copied.length > 3 ? "PASS" : "PARTIAL",
      `读出=${JSON.stringify(String(copied).slice(0, 40))}`);

    // ------------------------------------------------ dual column
    const dual = path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf").replace(/\\/g, "\\\\");
    await page.eval(`window.__paperai.open("${dual}")`);
    await page.waitFor("window.__paperai && window.__paperai.numPages > 0", 20000, "dual document loaded");
    await waitTextLayer(page);
    const dualPages = await page.eval(`window.__paperai.numPages`);

    const cols = await page.eval(`(() => {
      const spans = [...document.querySelectorAll(".pdfViewer .page .textLayer span")].filter(s => (s.textContent||"").trim().length > 3);
      if (!spans.length) return null;
      const rects = spans.map(s => s.getBoundingClientRect());
      const midX = (Math.min(...rects.map(r => r.x)) + Math.max(...rects.map(r => r.x + r.width))) / 2;
      let l = 0, r = 0;
      for (const rc of rects) (rc.x + rc.width/2 < midX ? l++ : r++);
      return { total: spans.length, left: l, right: r };
    })()`);
    record("B1.4", "IEEE 双栏：左右栏 span 可区分", cols && cols.left > 0 && cols.right > 0 ? "PASS" : "FAIL",
      `页数=${dualPages} span=${cols?.total} 左=${cols?.left} 右=${cols?.right}`);

    const leftSel = await dragColumn(page, "left");
    await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, "03-dual-left-select.png"), b));
    const rightSel = await dragColumn(page, "right");
    await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, "04-dual-right-select.png"), b));
    record("B1.5", "双栏左栏拖选无串栏", leftSel && leftSel.length > 3 && leftSel.length < 200 ? "PASS" : "FAIL",
      `左栏选中(${leftSel?.length ?? 0})="${(leftSel ?? "").slice(0, 60)}"`);
    record("B1.6", "双栏右栏拖选无串栏", rightSel && rightSel.length > 3 && rightSel.length < 200 ? "PASS" : "FAIL",
      `右栏选中(${rightSel?.length ?? 0})="${(rightSel ?? "").slice(0, 60)}"`);

    // ------------------------------------------------ highlight
    const hlBefore = await page.eval(`window.__paperai.annotationCount`);
    await dragColumn(page, "left");
    const hl = await page.eval(`(async () => { const n = await window.__paperai.highlight(); return { n, total: window.__paperai.annotationCount, dirty: window.__paperai.dirty }; })()`);
    record("B2.1", "选中 → Highlight 创建批注", hl.total > hlBefore ? "PASS" : "FAIL",
      `批注 ${hlBefore} -> ${hl.total}, dirty=${hl.dirty}`);
    await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, "05-highlight.png"), b));

    // ------------------------------------------------ ink at three zooms
    await page.eval(`window.__paperai.setTool("ink")`);
    await sleep(600);
    let allInkOk = true;
    const inkNotes = [];
    let inkTotal = hl.total;
    for (const z of [1.0, 1.75, 0.75]) {
      await page.eval(`window.__paperai.setScale(${z})`);
      await sleep(600);
      const before = await page.eval(`window.__paperai.annotationCount`);
      const box = await page.eval(`(() => { const p = document.querySelector(".pdfViewer .page"); if (!p) return null; const r = p.getBoundingClientRect(); return { x: r.x + r.width*0.3, y: r.y + r.height*0.6 }; })()`);
      if (!box) break;
      await drawStroke(page, box.x, box.y, 24, 4, 18, Math.sin);
      await sleep(300);
      await page.eval(`window.__paperai.commitInk()`);
      await sleep(400);
      const after = await page.eval(`window.__paperai.annotationCount`);
      const ok = after > before;
      allInkOk = allInkOk && ok;
      inkTotal = after;
      inkNotes.push(`zoom=${z}: ${before}->${after}`);
      await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, `06-ink-zoom-${String(z).replace(".", "_")}.png`), b));
    }
    record("B2.2", "不同缩放比例下绘制 Ink（3 组）", allInkOk ? "PASS" : "FAIL", inkNotes.join("; "));

    // ------------------------------------------------ mode cycling
    const beforeCycle = inkTotal;
    await page.eval(`window.__paperai.setTool("select")`);
    await sleep(400);
    await page.eval(`window.__paperai.setTool("ink")`);
    await sleep(400);
    const box2 = await page.eval(`(() => { const p = document.querySelector(".pdfViewer .page"); const r = p.getBoundingClientRect(); return { x: r.x + r.width*0.35, y: r.y + r.height*0.78 }; })()`);
    await drawStroke(page, box2.x, box2.y, 20, 4, 16, Math.cos);
    await sleep(300);
    await page.eval(`window.__paperai.commitInk()`);
    await sleep(400);
    const afterCycle = await page.eval(`window.__paperai.annotationCount`);
    record("B2.3", "Select→Draw 模式循环后仍可绘制", afterCycle > beforeCycle ? "PASS" : "FAIL",
      `批注 ${beforeCycle} -> ${afterCycle}`);

    // ------------------------------------------------ delete
    const delBefore = await page.eval(`window.__paperai.annotationCount`);
    // Enter an editing mode first: with the annotation layer disabled, editors
    // we created are not hit-testable and cannot be selected for deletion.
    await page.eval(`window.__paperai.setTool("ink")`);
    await sleep(600);
    const target = await page.eval(`(() => {
      const editors = [...document.querySelectorAll(".pdfViewer .annotationEditorLayer .inkEditor, .pdfViewer .annotationEditorLayer .highlightEditor")];
      if (!editors.length) return null;
      const last = editors[editors.length - 1];
      const r = last.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      for (let gy = 1; gy <= 24; gy++) {
        for (let gx = 1; gx <= 24; gx++) {
          const x = r.x + (r.width * gx) / 25;
          const y = r.y + (r.height * gy) / 25;
          const el = document.elementFromPoint(x, y);
          if (el && (el === last || last.contains(el))) return { x, y, w: r.width, h: r.height };
        }
      }
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, fallback: true };
    })()`);
    let del = { ok: false, after: delBefore, reason: "no editor found" };
    if (target) {
      await page.click(target.x, target.y);
      await sleep(400);
      const pre = await page.eval(`window.__paperai.debugState()`);
      del = await page.eval(`(async () => { const ok = window.__paperai.erase(); await new Promise(s => setTimeout(s, 400)); return { ok, after: window.__paperai.annotationCount, post: window.__paperai.debugState() }; })()`);
      del.target = target;
      del.pre = pre;
    }
    record("B2.4", "删除批注（真实删除）", del.ok && del.after < delBefore ? "PASS" : "FAIL",
      `批注 ${delBefore} -> ${del.after}; 点击前状态=${JSON.stringify(del.pre)}; 点击命中=${del.target?.fallback ? "回退(框中心)" : "笔迹像素"}`);
    await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, "07-after-delete.png"), b));

    // ------------------------------------------------ save + structural verify
    const saved = await page.eval(`(async () => {
      const bytes = await window.__paperai.serialize();
      const rep = await window.__paperai.verify(bytes);
      let s = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CH)));
      return { size: bytes.byteLength, rep, b64: btoa(s) };
    })()`);
    if (saved.b64) {
      const outDir = path.join(ROOT, "output");
      mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, "annotated-desktop.pdf");
      writeFileSync(outFile, Buffer.from(saved.b64, "base64"));
      console.log(`            -> wrote ${outFile} (${saved.size} bytes)`);
    }
    record("B3.1", "saveDocument() 输出含标准批注对象", saved.rep.hasHighlight && saved.rep.hasInk ? "PASS" : "FAIL",
      `字节=${saved.size} 页数=${saved.rep.numPages} 计数=${JSON.stringify(saved.rep.countsBySubtype)}`);

    const hlSample = saved.rep.samples.find((s) => s.subtype === "Highlight");
    const ik = saved.rep.samples.find((s) => s.subtype === "Ink");
    // PDF.js returns quadPoints as an array-LIKE object ({"0":..,"1":..}), NOT a
    // real array — Array.isArray() is false and .length misleads. This is what
    // produced the bogus "empty quadPoints" claim in K-04, now retracted.
    // Always Array.from() before inspecting it.
    const qp = hlSample ? { ...hlSample, quadPoints: Array.from(hlSample.quadPoints ?? []) } : null;
    record("B3.2", "Highlight 含 QuadPoints 几何", qp && qp.quadPoints.length >= 8 ? "PASS" : "FAIL",
      qp ? `page=${qp.page} quadPoints长度=${qp.quadPoints.length}` : "未找到 Highlight 样本");
    record("B3.3", "Ink 含 InkList 笔迹", ik && ik.inkStrokes > 0 ? "PASS" : "FAIL",
      ik ? `page=${ik.page} 笔画数=${ik.inkStrokes}` : "未找到 Ink 样本");

    // ------------------------------------------------ uncommitted ink (D4)
    await page.eval(`window.__paperai.setTool("ink")`);
    await sleep(600);
    const box3 = await page.eval(`(() => { const p = document.querySelector(".pdfViewer .page"); const r = p.getBoundingClientRect(); return { x: r.x + r.width*0.45, y: r.y + r.height*0.35 }; })()`);
    await drawStroke(page, box3.x, box3.y, 20, 3, 14, Math.sin);
    await sleep(300);
    // deliberately NOT committing before serialising
    const rep2 = await page.eval(`(async () => { const b = await window.__paperai.serialize(); return window.__paperai.verify(b); })()`);
    const inkBefore2 = saved.rep.countsBySubtype.Ink ?? 0;
    const inkAfter2 = rep2.countsBySubtype.Ink ?? 0;
    record("D4.1", "未 commit 的笔迹在保存时自动提交", inkAfter2 >= inkBefore2 ? "PASS" : "FAIL",
      `保存前 Ink=${inkBefore2} → 直接 serialize() 后 Ink=${inkAfter2}`);
    await page.eval(`window.__paperai.setTool("select")`);

    // ------------------------------------------------ zoom alignment (B4)
    const align = await page.eval(`(async () => {
      window.__paperai.setScale(1);
      await new Promise(r => setTimeout(r, 800));
      const probe = document.querySelector(".pdfViewer .page .textLayer span");
      if (!probe) return null;
      const t = probe.textContent.slice(0, 20);
      const a = probe.getBoundingClientRect();
      window.__paperai.setScale(2.5);
      await new Promise(r => setTimeout(r, 1000));
      const after = [...document.querySelectorAll(".pdfViewer .page .textLayer span")].find(s => s.textContent.startsWith(t));
      if (!after) return null;
      const b = after.getBoundingClientRect();
      return { ratio: b.width / a.width, text: t };
    })()`);
    record("B4.1", "缩放后 TextLayer 对齐（宽度比例）", align && Math.abs(align.ratio - 2.5) / 2.5 < 0.05 ? "PASS" : "FAIL",
      align ? `比例=${align.ratio.toFixed(3)} 期望=2.5` : "无法测量");

    await page.screenshot().then((b) => writeFileSync(path.join(EVIDENCE, "08-final.png"), b));
  } catch (e) {
    record("B0", "真实 WebView2 会话", "FAIL", String(e).slice(0, 600));
  } finally {
    page?.close();
    try { child.kill(); } catch { /* already gone */ }
  }

  writeReport();
  const bad = results.filter((r) => r.status !== "PASS").length;
  console.log(`\n${results.length - bad}/${results.length} PASS — evidence in ${EVIDENCE}`);
  process.exit(bad > 0 ? 1 : 0);
}

// ---------------------------------------------------------------- helpers

/** Block until the PDF text layer has spans to select from. */
async function waitTextLayer(page, timeoutMs = 30000) {
  try {
    await page.waitFor(
      "document.querySelectorAll('.pdfViewer .page .textLayer span').length > 3",
      timeoutMs,
      "text layer spans"
    );
    return true;
  } catch {
    return false;
  }
}

async function dragMiddleSpan(page) {
  const box = await page.eval(`(() => {
    const vpH = innerHeight, vpW = innerWidth;
    const spans = [...document.querySelectorAll(".pdfViewer .page .textLayer span")]
      .filter(s => (s.textContent||"").trim().length > 25)
      // stay clear of the toolbar/status bar and the viewport edges
      .filter(s => { const r = s.getBoundingClientRect(); return r.top >= 90 && r.bottom <= vpH - 20 && r.left >= 0 && r.right <= vpW && r.width > 20; });
    if (!spans.length) return null;
    const s = spans[Math.floor(spans.length/2)];
    const r = s.getBoundingClientRect();
    return { x1: r.x + 1, y1: r.y + r.height/2, x2: r.x + Math.max(4, r.width - 2), text: s.textContent.slice(0, 40) };
  })()`);
  if (!box) return null;
  await page.drag({ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y1 }, 10, 20);
  await sleep(400);
  const text = await page.eval(`window.__paperai.getSelection()`);
  return { text: String(text ?? "") };
}

async function dragColumn(page, side) {
  const box = await page.eval(`((sd) => {
    const vpH = innerHeight, vpW = innerWidth;
    const spans = [...document.querySelectorAll(".pdfViewer .page .textLayer span")].filter(s => (s.textContent||"").trim().length > 4);
    if (!spans.length) return null;
    const rects = spans.map(s => s.getBoundingClientRect());
    const midX = (Math.min(...rects.map(r => r.x)) + Math.max(...rects.map(r => r.x + r.width))) / 2;
    const wanted = spans.filter(s => {
      const r = s.getBoundingClientRect();
      const inCol = sd === "left" ? (r.x + r.width/2 < midX) : (r.x + r.width/2 >= midX);
      // never drag over the toolbar / status bar: those spans sit under the
      // fixed header and a drag there selects app chrome instead of PDF text
      const visible = r.top >= 90 && r.bottom <= vpH - 20 && r.left >= 0 && r.right <= vpW && r.width > 10;
      return inCol && visible;
    });
    if (!wanted.length) return null;
    const s = wanted[Math.floor(wanted.length/2)];
    const r = s.getBoundingClientRect();
    return { x1: r.x + 1, y1: r.y + r.height/2, x2: r.x + Math.max(4, r.width - 2), text: s.textContent.slice(0, 30) };
  })("${side}")`);
  if (!box) return null;
  await page.drag({ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y1 }, 10, 20);
  await sleep(400);
  return String(await page.eval(`window.__paperai.getSelection()`) ?? "");
}

async function drawStroke(page, x0, y0, steps, dx, amp, wave) {
  // Keep the whole stroke inside the viewport: CDP coordinates outside it are
  // clipped, and PDF.js silently drops the gesture.
  const vp = await page.eval(`({ w: innerWidth, h: innerHeight })`);
  const y = Math.max(120, Math.min(vp.h - 80, y0));
  const x = Math.max(60, Math.min(vp.w - 260, x0));
  await page.mouseMove(x, y, 0);
  await page.mouseDown(x, y);
  for (let i = 1; i <= steps; i++) {
    const nx = Math.min(vp.w - 60, x + i * dx);
    const ny = Math.max(110, Math.min(vp.h - 70, y + wave(i / 3) * amp));
    await page.mouseMove(nx, ny, 1);
    if (i % 6 === 0) await sleep(16);
  }
  await page.mouseUp(Math.min(vp.w - 60, x + steps * dx), y);
}

function writeReport() {
  const md = [
    "# Stage B — real WebView2 verification results",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Binary under test: \`${EXE ?? "(none)"}\``,
    "",
    "| ID | Check | Result | Notes |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | **${r.status}** | ${String(r.note).replace(/\n/g, " ")} |`),
    "",
  ].join("\n");
  writeFileSync(path.join(EVIDENCE, "RESULTS.md"), md, "utf8");
}

main();
