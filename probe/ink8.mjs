import puppeteer from "puppeteer-core";
import fs from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: EDGE, headless: true, defaultViewport: { width: 1400, height: 1000 } });
const p = await b.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));

await p.goto("http://localhost:5180/", { waitUntil: "networkidle2" });
await p.waitForFunction(() => !!window.__paperai, { timeout: 20000 });
const b64 = fs.readFileSync("D:/AIreader/PaperAI-PoC/test-pdfs/PDF-B.pdf").toString("base64");
await p.evaluate(async (s) => {
  const bin = atob(s); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  await window.__paperai.loadByArrayBuffer(a.buffer, "PDF-B.pdf");
}, b64);
await p.waitForFunction(() => window.__paperai.hasUIManager === true, { timeout: 45000 });
await sleep(1500);

// Reach the layer, then use its own getter to prove what currentEditorType is.
console.log("=== runtime truth: #editorTypes map contents ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  const layer = um.getLayer(0);
  const Ctor = layer.constructor;

  // Bracket-notation access to the static private field works because
  // private static fields are NOT accessible at all; but we can infer the map
  // by testing behaviour per mode. Instead, capture via a probe instance.
  const results = {};
  for (const [name, mode] of [["NONE",0],["FREETEXT",3],["HIGHLIGHT",9],["STAMP",13],["INK",15],["SIGNATURE",101]]) {
    await um.updateMode(mode);
    await new Promise((r) => setTimeout(r, 100));
    let curType = "n/a";
    try {
      // canCreateNewEmptyEditor() reads #currentEditorType internally
      const can = !!layer.canCreateNewEmptyEditor();
      curType = can ? "resolved+canCreate" : "resolved+cannotCreate";
      // isDrawer affects pointerdown -> startDrawingSession
      curType += ` | layerClass="${layer.div.className}"`;
    } catch (e) { curType = "ERR " + e.message; }
    results[name + "(" + mode + ")"] = curType;
  }
  return results;
}));

console.log("\n=== does InkEditor need a DrawLayer / canvas that is absent? ===");
console.log(await p.evaluate(async () => {
  const um = window.__paperaiUM;
  await um.updateMode(15);
  await new Promise((r) => setTimeout(r, 200));
  const layer = um.getLayer(0);
  return {
    layerKeys: Object.keys(layer),
    hasDiv: !!layer.div,
    divChildren: layer.div.children.length,
    drawingSessionActive: !!um.currentLayer && um.currentLayer === layer,
    // check for a drawLayer sibling (InkEditor renders into canvas)
    pageChildren: [...layer.div.parentElement.children].map(
      (c) => c.className || c.tagName
    ),
  };
}));

console.log("\n=== check AnnotationEditorUIManager #isEnabled / enableWaiting ===");
console.log(await p.evaluate(() => {
  const um = window.__paperaiUM;
  return {
    hasEnableWaiting: typeof um.enableWaiting,
    isEditingMode: um.isEditingMode(),
    getMode: um.getMode(),
    hasSomethingToControl: typeof um.hasSomethingToControl === "function" ? um.hasSomethingToControl() : "n/a",
  };
}));

await b.close();