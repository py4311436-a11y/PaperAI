// Does the WebView2 in PaperAI still work at all, or only the CDP endpoint?
// Passing a PDF makes the app set its window title, which we can read from
// outside the process — that proves the WebView2 rendered our bundle.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const ROOT = "D:\\AIreader\\PaperAI-PoC";
const EXE = "D:\\PaperAI-Build\\target\\release\\PaperAI.exe";
const PDF = path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf");

const variants = [
  { label: "no CDP args", env: {} },
  { label: "port 9500", env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9500" } },
  { label: "port 9502 + user-data-dir", env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9502 --user-data-dir=D:\\PaperAI-Build\\wv2-dbg" } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const v of variants) {
  // kill leftovers first
  spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
  await sleep(1500);

  const child = spawn(EXE, [PDF], { env: { ...process.env, ...v.env }, stdio: "ignore" });
  await sleep(9000);

  const q = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `$p = Get-Process PaperAI -EA SilentlyContinue | Select-Object -First 1; if ($p) { $p.Id.ToString() + ' | ' + $p.MainWindowTitle + ' | responding=' + $p.Responding } else { 'NOT RUNNING' }`],
    { encoding: "utf8" }
  ).stdout.trim();

  const port = v.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?.match(/--remote-debugging-port=(\d+)/)?.[1];
  let cdp = "n/a";
  if (port) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      cdp = "UP " + j.Browser;
    } catch {
      try {
        const j = await (await fetch(`http://[::1]:${port}/json/version`)).json();
        cdp = "UP(v6) " + j.Browser;
      } catch (e) {
        cdp = "DOWN";
      }
    }
  }

  console.log(`${v.label.padEnd(28)} | ${q} | cdp=${cdp}`);
  try { child.kill(); } catch {}
  await sleep(1500);
}
