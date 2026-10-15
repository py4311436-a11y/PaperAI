// Diagnose why the real Tauri window does not expose window.__paperai.
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const PORT = Number(process.argv[3] ?? 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

async function waitBrowser() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("no CDP browser endpoint");
}

async function waitPageUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const hit = list.find((t) => t.type === "page" && !/^about:blank/.test(t.url));
      if (hit) return hit.url;
    } catch {}
    await sleep(500);
  }
  throw new Error("no app page");
}

try {
  const ws = await waitBrowser();
  const url = await waitPageUrl();
  console.log("browser:", ws);
  console.log("app url:", url);

  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 120000 });
  const targets = await browser.targets();
  console.log("targets:", targets.map((t) => `${t.type()}:${t.url()}`).join(" , "));
  const appTarget = targets.find((t) => t.type() === "page" && !/about:blank/.test(t.url()));
  const app = await appTarget.page();

  app.on("console", (m) => console.log(`  [console.${m.type()}]`, m.text().slice(0, 400)));
  app.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 800)));

  await sleep(5000);
  const info = await app.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyLen: document.body ? document.body.innerHTML.length : -1,
    hasPaperai: typeof window.__paperai,
    hasTauriInternals: "__TAURI_INTERNALS__" in window,
    hasTauri: "__TAURI__" in window,
    underscoreKeys: Object.keys(window).filter((k) => k.startsWith("__")),
    scripts: [...document.querySelectorAll("script")].map((s) => s.src || "(inline)"),
    links: [...document.querySelectorAll("link")].map((l) => l.href).slice(0, 6),
  }));
  console.log("page info:", JSON.stringify(info, null, 2));
  await browser.disconnect();
} catch (e) {
  console.log("FAILED:", e.message);
} finally {
  child.kill();
}
