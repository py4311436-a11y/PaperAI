// Dump the rendered PDF DOM from the real WebView2 window.
import { spawn } from "node:child_process";
import { CdpPage, webview2AutomationArgs, waitBrowserEndpoint, waitPageTarget } from "../tests/lib-cdp.mjs";
import path from "node:path";

const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9480);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pdf = path.join(ROOT, "test-fixtures", "single", "PDF-A-single.pdf").replace(/\\/g, "\\\\");

const child = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2AutomationArgs(PORT) }, stdio: "ignore" });

try {
  await waitBrowserEndpoint(PORT);
  await waitPageTarget(PORT);
  const page = await CdpPage.attachTauriPage(PORT);
  page.on("Runtime.consoleAPICalled", (p) => {
    const args = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    console.log(`  [console.${p.type}]`, String(args).slice(0, 400));
  });
  page.on("Runtime.exceptionThrown", (p) => {
    const d = p.exceptionDetails;
    console.log("  [exception]", String(d.exception?.description ?? d.text).slice(0, 500));
  });
  page.on("Network.loadingFailed", (p) => console.log("  [loadFailed]", p.errorText, p.type));
  page.on("Network.responseReceived", (p) => console.log("  [resp]", p.response.status, p.response.url.slice(0, 130)));
  await page.send("Network.enable");
  // Force the compositor to produce frames. In a session with no interactive
  // desktop nothing drives rAF, so PDF.js never renders and every page stays
  // 0x0. Starting a screencast is the standard way to make frames happen.
  await page.send("Page.startScreencast", { format: "jpeg", quality: 20, maxWidth: 480, maxHeight: 320, everyNthFrame: 1 }).catch((e) => console.log("  startScreencast failed:", e.message));
  let frames = 0;
  page.on("Page.screencastFrame", async (p) => {
    frames++;
    await page.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
  });
  // Also measure whether requestAnimationFrame runs at all in this window.
  const rafAlive = await page.eval(`new Promise((res) => { let n = 0; const t = setTimeout(() => res(n), 2000); (function tick(){ n++; if (n < 5) requestAnimationFrame(tick); else { clearTimeout(t); res(n); } })(); })`);
  console.log("  rAF ticks in 2s:", rafAlive, "| screencast frames so far:", frames);
  await page.waitFor("window.__paperai && window.__paperai.ready === true", 45000, "ready");
  console.log("--- opening pdf ---");
  await page.eval(`window.__paperai.open("${pdf}")`);
  await sleep(8000);

  const dump = await page.eval(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const viewer = document.querySelector("#viewer");
    const firstPage = viewer ? viewer.firstElementChild : null;
    const vc = document.querySelector("#viewerContainer");
    const rect = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
    return {
      numPages: window.__paperai.numPages,
      viewport: { innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio },
      sizes: { container: rect(vc), viewer: rect(viewer), firstPage: rect(firstPage) },
      scale: window.__paperai.scale,
      counts: {
        "#viewer": q("#viewer"),
        "#viewer > *": q("#viewer > *"),
        ".page": q(".page"),
        ".pdfViewer": q(".pdfViewer"),
        ".textLayer": q(".textLayer"),
        ".textLayer span": q(".textLayer span"),
        "canvas": q("canvas"),
      },
      viewerClasses: viewer ? viewer.className : null,
      viewerParentClasses: viewer ? viewer.parentElement?.className : null,
      firstPageTag: firstPage ? firstPage.tagName + "." + firstPage.className : null,
      firstPageChildren: firstPage ? [...firstPage.children].map(c => c.tagName + "." + c.className).slice(0, 10) : [],
      sampleSpanText: (document.querySelector(".textLayer span") || {}).textContent?.slice(0, 40) ?? null,
      pageInlineStyle: firstPage ? firstPage.getAttribute("style") : null,
      pageComputed: firstPage ? (() => {
        const cs = getComputedStyle(firstPage);
        return { width: cs.width, height: cs.height, display: cs.display, position: cs.position };
      })() : null,
      containerClient: vc ? { w: vc.clientWidth, h: vc.clientHeight } : null,
      pageData: firstPage ? firstPage.dataset ? { ...firstPage.dataset } : null : null,
    };
  })()`);
  console.log(JSON.stringify(dump, null, 2));
} catch (e) {
  console.log("FAILED:", e.message);
} finally {
  try { child.kill(); } catch {}
}
