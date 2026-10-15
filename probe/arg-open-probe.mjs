// Launch the real app WITH a file argument and inspect what the frontend did.
import { spawn } from "node:child_process";
import path from "node:path";
import { CdpPage, webview2AutomationArgs, waitBrowserEndpoint, waitPageTarget } from "../tests/lib-cdp.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9530);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pdf = process.argv[4] ?? path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf");
console.log("arg:", pdf);

const child = spawn(EXE, [pdf], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2AutomationArgs(PORT) },
  stdio: "ignore",
});

try {
  await waitBrowserEndpoint(PORT);
  await waitPageTarget(PORT);
  const page = await CdpPage.attachTauriPage(PORT);
  page.on("Runtime.consoleAPICalled", (p) => {
    const args = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    console.log(`  [console.${p.type}]`, String(args).slice(0, 300));
  });
  page.on("Runtime.exceptionThrown", (p) => {
    console.log("  [exception]", String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 400));
  });
  await page.waitFor("window.__paperai && window.__paperai.ready === true", 45000, "ready");
  await sleep(6000);

  const state = await page.eval(`({
    numPages: window.__paperai.numPages,
    currentPath: window.__paperai.currentPath,
    status: document.querySelector("#status-file")?.textContent,
    toast: document.querySelector("#toast")?.textContent,
    title: document.title,
    pages: document.querySelectorAll(".pdfViewer .page").length,
    canvases: document.querySelectorAll(".pdfViewer canvas").length,
    logs: window.__paperai.logs.slice(-10),
  })`);
  console.log("STATE:", JSON.stringify(state, null, 2));
} catch (e) {
  console.log("FAILED:", e.message);
} finally {
  try { child.kill(); } catch {}
}
