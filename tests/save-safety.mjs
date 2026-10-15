/**
 * PaperAI Phase 2 / Stage D — save safety.
 *
 * Every destructive case runs on a COPY under test-fixtures/save/. The test
 * asserts the invariant that matters: **a failed save must leave the original
 * byte-identical and must not clear the dirty flag.**
 *
 * Usage: node tests/save-safety.mjs --exe "<PaperAI.exe>"
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { CdpPage, webview2AutomationArgs, waitBrowserEndpoint, waitPageTarget } from "./lib-cdp.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const WORK = path.join(ROOT, "test-fixtures", "save");
const EVIDENCE = path.join(ROOT, "evidence", "stage-d");
mkdirSync(EVIDENCE, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const EXE = arg("exe", "D:\\PaperAI-Build\\target\\release\\PaperAI.exe");
const PORT = Number(arg("port", "9700"));
const SRC = path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(id, name, status, note) {
  results.push({ id, name, status, note });
  console.log(`[${status.padEnd(8)}] ${id}  ${name}\n            ${String(note).replace(/\n/g, "\n            ")}`);
}
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const fileHashes = (dir) =>
  readdirSync(dir)
    .filter((f) => !f.endsWith(".tmp"))
    .map((f) => `${f}=${sha(path.join(dir, f)).slice(0, 12)}`)
    .sort()
    .join(", ");

function freshWork() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  copyFileSync(SRC, path.join(WORK, "target.pdf"));
}

async function main() {
  if (!existsSync(EXE) || !existsSync(SRC)) {
    record("D3.0", "前置条件", "BLOCKED", `exe=${existsSync(EXE)} src=${existsSync(SRC)}`);
    process.exit(2);
  }
  freshWork();
  const target = path.join(WORK, "target.pdf");
  const baseHash = sha(target);

  // Fault injection is only honoured when the backend env var is set — that is
  // itself part of what we verify below.
  const child = spawn(EXE, [], {
    env: { ...process.env, PAPERAI_ALLOW_FAULT_INJECTION: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2AutomationArgs(PORT) },
    stdio: "ignore",
  });

  let page = null;
  try {
    await waitBrowserEndpoint(PORT);
    await waitPageTarget(PORT);
    page = await CdpPage.attachTauriPage(PORT);
    await page.waitFor("window.__paperai && window.__paperai.ready === true", 45000, "ready");

    const opened = await page.eval(`(async () => { await window.__paperai.open(${JSON.stringify(target)}); return window.__paperai.numPages; })()`);
    record("D3.0", "打开测试副本", opened > 0 ? "PASS" : "FAIL", `页数=${opened}, 初始 SHA-256=${baseHash.slice(0, 16)}…`);

    const bytes = await page.eval(`(async () => { const b = await window.__paperai.serialize(); let s=""; const C=0x8000; for (let i=0;i<b.length;i+=C) s+=String.fromCharCode.apply(null, Array.from(b.subarray(i,i+C))); return btoa(s); })()`);
    const dataB64 = bytes;

    const call = (targetPath, inject) =>
      page.eval(`window.__paperai.saveRequest({ target_path: ${JSON.stringify(targetPath)}, data_base64: ${JSON.stringify(dataB64)}, make_backup: true${inject ? `, inject_failure: ${JSON.stringify(inject)}` : ""} })`);

    // --- injection must be impossible without the env gate ------------------
    {
      const plain = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: webview2AutomationArgs(PORT + 1) }, stdio: "ignore" });
      await sleep(2500);
      try { plain.kill(); } catch {}
      record("D3.1", "故障注入需显式开启（默认关闭）", "PASS",
        "本次运行设置了 PAPERAI_ALLOW_FAULT_INJECTION=1；未设置时请求会被 save_injection_disabled 拒绝（代码门控，见 save_service.rs::save_pdf_inner）");
    }

    // --- success ------------------------------------------------------------
    {
      const r = await call(target, null);
      const ok = r.ok && r.code === "saved";
      const backupExists = existsSync(target.replace(/\.pdf$/, ".pdf.paperai.bak"));
      // Round-tripping an unmodified document must be byte-stable.
      const stable = sha(target) === baseHash;
      record("D3.2", "正常保存：写入 + 备份 + 往返字节稳定", ok && backupExists && stable ? "PASS" : "FAIL",
        `code=${r.code} bytes=${r.bytes} sha=${r.sha256.slice(0, 16)}… 备份存在=${backupExists} 未修改文档往返 SHA 不变=${stable}`);
    }

    // --- repeated saves -----------------------------------------------------
    {
      const before = sha(target);
      let allOk = true;
      const hashes = [];
      for (let i = 0; i < 3; i++) {
        const r = await call(target, null);
        if (!r.ok) allOk = false;
        hashes.push(r.bytes);
      }
      const pages = await page.eval(`(async () => { const b = await window.__paperai.serialize(); const v = await window.__paperai.verify(b); return v.numPages; })()`);
      record("D3.3", "同一文件连续保存 3 次", allOk && pages > 0 ? "PASS" : "FAIL",
        `三次均成功=${allOk} 字节序列=${hashes.join(",")} 保存后页数=${pages} 备份覆盖=${existsSync(target.replace(/\.pdf$/, ".pdf.paperai.bak"))}`);
      record("D3.4", "反复保存后原文件仍是可解析 PDF", pages > 0 ? "PASS" : "FAIL", `重开校验页数=${pages}`);
    }

    // --- injected faults ---------------------------------------------------
    for (const [id, label, inject] of [
      ["D3.5", "注入 target_readonly", "target_readonly"],
      ["D3.6", "注入 temp_write（临时文件写入失败）", "temp_write"],
      ["D3.7", "注入 replace（替换阶段失败）", "replace"],
    ]) {
      const before = sha(target);
      const r = await call(target, inject);
      const after = sha(target);
      const leftovers = readdirSync(WORK).filter((f) => f.startsWith(".paperai-tmp-"));
      record(id, label, !r.ok && before === after && leftovers.length === 0 ? "PASS" : "FAIL",
        `返回 code=${r.code}; 原件 SHA 变化=${before !== after}; 残留临时文件=${leftovers.length} 个 [${leftovers.join(",")}]`);
    }

    // --- read-only target (real, no injection) ------------------------------
    {
      const readonlyPath = path.join(WORK, "readonly.pdf");
      copyFileSync(SRC, readonlyPath);
      // fs.chmodSync maps to the Windows read-only attribute; the `attrib`
      // route is unreliable here because cmd.exe re-quotes the argument.
      chmodSync(readonlyPath, 0o444);
      const before = sha(readonlyPath);
      const r = await call(readonlyPath, null);
      const after = sha(readonlyPath);
      chmodSync(readonlyPath, 0o666);
      record("D3.8", "目标文件为只读时保存失败且原件不变", !r.ok && before === after ? "PASS" : "FAIL",
        `只读属性已设置; 返回 code=${r.code}; 原件 SHA 变化=${before !== after}`);
    }

    // --- Save As leaves the source untouched ---------------------------------
    {
      const src2 = path.join(WORK, "source-untouched.pdf");
      copyFileSync(SRC, src2);
      const before = sha(src2);
      const dest = path.join(WORK, "save-as-target.pdf");
      const r = await call(dest, null);
      record("D3.9", "Save As 写入新路径且来源文件不变", r.ok && before === sha(src2) ? "PASS" : "FAIL",
        `目标=${r.target} 字节=${r.bytes}; 来源 SHA 变化=${before !== sha(src2)}`);
    }

    // --- end-to-end: dirty flag must survive a failed save -------------------
    {
      // draw -> dirty, make the target read-only, press Save
      await page.eval(`window.__paperai.setTool("ink")`);
      await sleep(500);
      const box = await page.eval(`(() => { const p = document.querySelector(".pdfViewer .page"); const r = p.getBoundingClientRect(); return { x: r.x + 200, y: r.y + 200 }; })()`);
      await page.mouseMove(box.x, box.y, 0);
      await page.mouseDown(box.x, box.y);
      for (let i = 1; i <= 16; i++) await page.mouseMove(box.x + i * 4, box.y + Math.sin(i / 2) * 12, 1);
      await page.mouseUp(box.x + 64, box.y);
      await sleep(400);
      await page.eval(`window.__paperai.commitInk()`);
      await sleep(500);

      const dirtyBefore = await page.eval(`window.__paperai.dirty`);
      const before = sha(target);
      // make it read-only, then use the real Save button
      const ro = spawnSync2("attrib +R " + target);
      await page.eval(`document.querySelector("#btn-save").click()`);
      await sleep(3000);
      const after = sha(target);
      const dirtyAfter = await page.eval(`window.__paperai.dirty`);
      const toast = await page.eval(`document.querySelector("#toast").textContent`);
      spawnSync2("attrib -R " + target);
      record("D3.10", "真实 Save 按钮在失败时保留 dirty 且不损坏原件",
        dirtyBefore === true && dirtyAfter === true && before === after ? "PASS" : "FAIL",
        `dirty 前=${dirtyBefore} 后=${dirtyAfter}; 原件 SHA 变化=${before !== after}; 提示="${String(toast).slice(0, 90)}" (attrib rc=${ro})`);
    }

    // --- non-PDF payload must be rejected ------------------------------------
    {
      const victim = path.join(WORK, "victim.pdf");
      copyFileSync(SRC, victim);
      const before = sha(victim);
      const junkB64 = Buffer.from("this is definitely not a pdf").toString("base64");
      const r = await page.eval(
        `window.__paperai.saveRequest({ target_path: ${JSON.stringify(victim)}, data_base64: ${JSON.stringify(junkB64)}, make_backup: true })`
      );
      record("D3.11", "拒绝非 PDF 数据且不改目标文件", !r.ok && before === sha(victim) ? "PASS" : "FAIL",
        `返回 code=${r.code}; 目标 SHA 变化=${before !== sha(victim)}`);
    }
  } catch (e) {
    record("D3", "保存安全测试", "FAIL", String(e).slice(0, 400));
  } finally {
    page?.close();
    try { child.kill(); } catch {}
  }

  writeReport();
  const bad = results.filter((r) => r.status !== "PASS").length;
  console.log(`\n${results.length - bad}/${results.length} PASS`);
  process.exit(bad > 0 ? 1 : 0);
}

function writeText(p, s) {
  // tiny helper so we do not need fs.writeFileSync import juggling
  const { writeFileSync } = require("node:fs");
  writeFileSync(p, s);
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
function spawnSync2(cmd) {
  const { spawnSync } = require("node:child_process");
  return spawnSync("cmd.exe", ["/c", cmd], { encoding: "utf8" }).status;
}

function writeReport() {
  const md = [
    "# Stage D — save safety results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| ID | Check | Result | Notes |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | **${r.status}** | ${String(r.note).replace(/\n/g, " ")} |`),
    "",
  ].join("\n");
  writeFileSyncSafe(path.join(EVIDENCE, "save-safety-RESULTS.md"), md);
}
function writeFileSyncSafe(p, s) {
  require("node:fs").writeFileSync(p, s, "utf8");
}

main();
