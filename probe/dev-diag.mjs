// Diagnose the frontend against the Vite dev server (fastest way to see the
// real console error).
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
p.on("console", (m) => console.log("[console." + m.type() + "]", m.text().slice(0, 400)));
p.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 600)));
p.on("requestfailed", (r) => console.log("[reqfail]", r.url().slice(0, 160), r.failure() && r.failure().errorText));
await p.goto("http://localhost:5180/", { waitUntil: "networkidle2", timeout: 45000 });
await new Promise((r) => setTimeout(r, 4000));
const info = await p.evaluate(() => ({
  paperai: typeof window.__paperai,
  ready: window.__paperai ? window.__paperai.ready : null,
  title: document.title,
  bodyLen: document.body.innerHTML.length,
  logs: window.__paperai ? window.__paperai.logs.slice(-8) : [],
}));
console.log("info:", JSON.stringify(info, null, 2));
await b.close();
