// Find a way to attach puppeteer to the real tauri.localhost page target.
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9350);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {}
    if (Date.now() > end) throw new Error("timeout waiting");
    await sleep(500);
  }
}

try {
  const ver = await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json());
  const target = await waitFor(async () => {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return l.find((t) => t.type === "page" && !/about:blank/.test(t.url));
  });
  console.log("browser ws:", ver.webSocketDebuggerUrl);
  console.log("page ws   :", target.webSocketDebuggerUrl, target.url);

  // Attempt A: connect to the browser endpoint and enumerate targets()
  const b = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null, protocolTimeout: 60000 });
  const tg = await b.targets();
  console.log("targets():", tg.map((t) => `${t.type()}:${t.url()}`).join(" | "));
  await b.disconnect();

  // Attempt B: connect straight to the page-level endpoint
  const b2 = await puppeteer.connect({ browserWSEndpoint: target.webSocketDebuggerUrl, defaultViewport: null, protocolTimeout: 60000 });
  const p2 = await b2.pages();
  console.log("direct-connect pages:", p2.map((p) => p.url()).join(" | "));
  const page = p2[0];
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 400)));
  page.on("console", (m) => console.log(`  [console.${m.type()}]`, m.text().slice(0, 300)));
  await sleep(3000);
  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    hasPaperai: typeof window.__paperai,
    hasTauriInternals: "__TAURI_INTERNALS__" in window,
    bodyLen: document.body ? document.body.innerHTML.length : -1,
  }));
  console.log("info:", JSON.stringify(info));
  console.log("ATTACH OK via direct page endpoint");
  await b2.disconnect();
} catch (e) {
  console.log("FAILED:", e.message);
} finally {
  child.kill();
}
