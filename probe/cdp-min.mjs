// Minimal probe: is the renderer responsive at all over CDP?
import { spawn } from "node:child_process";
import { CdpPage, waitBrowserEndpoint, waitPageTarget } from "../tests/lib-cdp.mjs";

const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9390);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

const t0 = Date.now();
const dt = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

try {
  await waitBrowserEndpoint(PORT);
  console.log(dt(), "browser endpoint up");
  const target = await waitPageTarget(PORT);
  console.log(dt(), "page target:", target.url);
  const page = await CdpPage.connect(target.webSocketDebuggerUrl);
  console.log(dt(), "connected, Runtime+Page enabled");

  // The target may still be about:blank right after attach; poll until the
  // real document (tauri.localhost) is the one we are evaluating in.
  for (let i = 0; i < 60; i++) {
    const v = await page.send("Runtime.evaluate", { expression: "location.href", returnByValue: true, awaitPromise: false });
    const href = v.result?.value;
    console.log(dt(), `poll ${i}: href=${href}`);
    if (href && !/about:blank/.test(href)) break;
    await sleep(1000);
  }

  // Re-list targets too, in case the app page got a NEW target id after nav.
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log(dt(), "targets now:", list.map((t) => `${t.type}:${t.url}`).join(" , "));

  for (const [name, expr] of [["title", "document.title"], ["bodyLen", "document.body ? document.body.innerHTML.length : -1"], ["paperai", "typeof window.__paperai"], ["hasTauri", "'__TAURI_INTERNALS__' in window"]]) {
    try {
      const v = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: false });
      console.log(dt(), `${name} =`, JSON.stringify(v.result?.value));
    } catch (e) {
      console.log(dt(), `${name} FAILED:`, e.message);
    }
  }

  try {
    const shot = await page.screenshot();
    console.log(dt(), "screenshot bytes:", shot.length);
  } catch (e) {
    console.log(dt(), "screenshot FAILED:", e.message);
  }
} catch (e) {
  console.log(dt(), "FAILED:", e.message);
} finally {
  child.kill();
}
