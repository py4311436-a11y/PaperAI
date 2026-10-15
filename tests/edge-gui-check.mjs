/**
 * PaperAI Phase 2 / Stage D — cross-reader verification in a REAL GUI reader.
 *
 * Launches Microsoft Edge as a normal desktop window (not headless) on the
 * annotated PDF and captures the rendered window over CDP. GDI screen capture is
 * unusable in this session (no compositor -> it only returns the wallpaper),
 * which is why the first attempt produced blank screenshots.
 *
 * Usage: node tests/edge-gui-check.mjs --pdf "<file.pdf>" [--wait 9000]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { CdpPage, waitBrowserEndpoint, waitPageTarget } from "./lib-cdp.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVIDENCE = path.join(ROOT, "evidence", "stage-d");
mkdirSync(EVIDENCE, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PDF = arg("pdf", path.join(ROOT, "output", "annotated-desktop.pdf"));
const WAIT = Number(arg("wait", "9000"));
const PORT = Number(arg("port", "9600"));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Edge-specific automation args. Do NOT reuse webview2AutomationArgs() here:
 * it adds `--disable-features=...`, and passing that twice makes Edge drop the
 * whole flag set (and never open the debugging port).
 */
const edgeArgs = `--remote-debugging-port=${PORT}`;

const results = [];
function record(id, name, status, note) {
  results.push({ id, name, status, note });
  console.log(`[${status.padEnd(8)}] ${id}  ${name}\n            ${String(note).replace(/\n/g, "\n            ")}`);
}

const shownName = "annotated-EDGE-GUI.pdf";
const shownPath = path.join(EVIDENCE, shownName);

async function main() {
  if (!existsSync(PDF)) {
    record("D1.0", "带批注的测试 PDF 存在", "BLOCKED", `缺少 ${PDF}`);
    writeReport();
    process.exit(2);
  }
  copyFileSync(PDF, shownPath);
  record("D1.0", "带批注的测试 PDF 存在", "PASS", `${PDF} -> ${shownPath}`);

  if (!existsSync(EDGE)) {
    record("D1.1", "Microsoft Edge 可执行文件", "BLOCKED", `未找到 ${EDGE}`);
    writeReport();
    process.exit(2);
  }

  const profile = path.join(EVIDENCE, "edge-profile");
  const child = spawn(
    EDGE,
    [
      `--app=file:///${shownPath.replace(/\\/g, "/")}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      edgeArgs,
    ],
    { stdio: "ignore" }
  );
  record("D1.1", "以 GUI 方式启动 Edge 打开 PDF", "PASS", `pid=${child.pid}, ${shownPath}`);

  await sleep(WAIT);

  try {
    await waitBrowserEndpoint(PORT);
    await waitPageTarget(PORT);
    const page = await CdpPage.attachTauriPage(PORT);
    record("D1.2", "连接到 Edge PDF 阅读器窗口", "PASS", page.appUrl);

    // Keep frames flowing (no compositor in this session).
    await page
      .send("Page.startScreencast", { format: "jpeg", quality: 30, maxWidth: 1100, maxHeight: 800, everyNthFrame: 1 })
      .catch(() => undefined);
    page.on("Page.screencastFrame", async (p) => {
      await page.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
    });
    await sleep(1500);

    const shot = path.join(EVIDENCE, "edge-annotated.png");
    const buf = await page.screenshot();
    writeFileSync(shot, buf);
    record("D1.3", "截图捕获（Edge 内置 PDF 阅读器）", existsSync(shot) ? "PASS" : "FAIL", `${shot} (${buf.length} bytes)`);

    const info = await page.eval(`({ url: location.href, title: document.title })`);
    record("D1.4", "记录所用阅读器与文件", "PASS", `url=${info.url} title=${info.title}`);
  } catch (e) {
    record("D1.2", "连接到 Edge PDF 阅读器窗口", "FAIL", String(e).slice(0, 300));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }

  writeReport();
  console.log(`\nMANUAL STEP REQUIRED: open ${path.join(EVIDENCE, "edge-annotated.png")} and confirm the highlight and ink strokes are visible.`);
}

function writeReport() {
  const md = [
    "# Stage D — cross-reader (Edge GUI) verification",
    "",
    `Generated: ${new Date().toISOString()}`,
    `PDF under test: \`${shownPath}\``,
    `Reader: Microsoft Edge — GUI (\`--app\`), \`${EDGE}\``,
    "",
    "| ID | Check | Result | Notes |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | **${r.status}** | ${String(r.note).replace(/\n/g, " ")} |`),
    "",
    "**Adobe Acrobat Reader: BLOCKED** — not installed on this machine (see `evidence/stage-a/env.txt`).",
    "Manual reproduction steps for a machine that has it are in",
    "`reports/STAGE_D_SAVE_COMPATIBILITY.md`.",
    "",
  ].join("\n");
  writeFileSync(path.join(EVIDENCE, "edge-gui-RESULTS.md"), md, "utf8");
}

main();
