import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const b = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  defaultViewport: { width: 1400, height: 1000 },
});
const p = await b.newPage();
p.on("console", (m) => console.log(`[console.${m.type()}]`, m.text()));
p.on("pageerror", (e) => console.log("[pageerror]", e.message, "\n", e.stack?.split("\n").slice(0, 6).join("\n")));
p.on("requestfailed", (r) => console.log("[reqfail]", r.url().slice(0, 120), r.failure()?.errorText));
p.on("response", (r) => { if (r.status() >= 400) console.log("[http]", r.status(), r.url().slice(0, 140)); });

await p.goto("http://localhost:5180/", { waitUntil: "networkidle2", timeout: 45000 });
await new Promise((r) => setTimeout(r, 3000));

console.log("\n=== __paperai present? ===");
console.log(await p.evaluate(() => ({ has: !!window.__paperai, keys: Object.keys(window).filter(k => k.startsWith("__paper")) })));
await b.close();