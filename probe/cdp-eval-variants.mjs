// Focused probe using the shared CDP helper, to see the exact failure.
import { spawn } from "node:child_process";
import { CdpPage, webview2AutomationArgs, waitBrowserEndpoint, waitPageTarget } from "../tests/lib-cdp.mjs";

const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9460);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2AutomationArgs(PORT) },
  stdio: "ignore",
});

try {
  await waitBrowserEndpoint(PORT);
  await waitPageTarget(PORT);
  const page = await CdpPage.attachTauriPage(PORT);
  console.log("attached:", page.appUrl, "session:", page.sessionId);

  // raw send variants
  const variants = [
    ["expression+returnByValue", { expression: "1+1", returnByValue: true }],
    ["+awaitPromise:false", { expression: "1+1", returnByValue: true, awaitPromise: false }],
    ["+awaitPromise:true", { expression: "1+1", returnByValue: true, awaitPromise: true }],
    ["app probe", { expression: "typeof window.__paperai", returnByValue: true }],
    ["app ready", { expression: "window.__paperai && window.__paperai.ready === true", returnByValue: true }],
    ["ready with await", { expression: "window.__paperai && window.__paperai.ready === true", returnByValue: true, awaitPromise: true }],
  ];
  for (const [name, params] of variants) {
    try {
      const r = await page.send("Runtime.evaluate", params);
      console.log(`  ${name.padEnd(24)} => ${JSON.stringify(r.result?.value)}`);
    } catch (e) {
      console.log(`  ${name.padEnd(24)} => ERROR ${e.message}`);
    }
    await sleep(300);
  }
} catch (e) {
  console.log("FAILED:", e.message);
} finally {
  try { child.kill(); } catch {}
}
