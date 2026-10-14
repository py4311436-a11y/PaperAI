import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
await p.goto("http://localhost:5180/", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

console.log(await p.evaluate(() => {
  const c = document.querySelector("#viewerContainer");
  const v = document.querySelector("#viewer");
  const cs = getComputedStyle(c);
  return {
    containerTag: c?.tagName,
    viewerTag: v?.tagName,
    position: cs.position,
    offsetParent: c?.offsetParent ? c.offsetParent.tagName + "#" + c.offsetParent.id : null,
    offsetParentNull: c?.offsetParent === null,
    // which CSS rules apply
    matched: [...document.styleSheets].flatMap((sh) => {
      try { return [...sh.cssRules]; } catch { return []; }
    }).filter((r) => r.selectorText && /viewerContainer|#viewer\b/.test(r.selectorText))
     .map((r) => r.selectorText + " { " + r.style.cssText.slice(0, 120) + " }"),
  };
}));
await b.close();