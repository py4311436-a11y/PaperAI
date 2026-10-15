// Confirm the K-13 fix on WebView2 specifically.
//
// Root cause established by scripts/probe-cdp-rootcause.mjs:
//   Chromium 136+ IGNORES --remote-debugging-port when the browser runs on the
//   DEFAULT user-data-dir. Edge + fresh --user-data-dir -> port up in 1.5s;
//   Edge + default profile -> never up. Tauri's WebView2 uses the default data
//   dir, which is why every WebView2 CDP attempt failed.
//
// So the fix is to hand WebView2 a fresh --user-data-dir alongside the port.
// This script proves it does (or does not) work.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const EXE = "D:\\PaperAI-Build\\target\\release\\PaperAI.exe";
const PDF = "D:\\AIreader\\PaperAI-PoC\\test-fixtures\\dual\\IEEE 双栏 论文 副本.pdf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cases = [
  {
    label: "port only (the old, broken recipe)",
    args: "--remote-debugging-port=9700",
    dir: null,
  },
  {
    label: "port + FRESH user-data-dir",
    args: "--remote-debugging-port=9701 --user-data-dir=D:\\PaperAI-Build\\wv2-dbg-9701",
    dir: "D:\\PaperAI-Build\\wv2-dbg-9701",
  },
  {
    label: "port + fresh dir + anti-throttle",
    args:
      "--remote-debugging-port=9702 --user-data-dir=D:\\PaperAI-Build\\wv2-dbg-9702 " +
      "--disable-renderer-backgrounding --disable-backgrounding-occluded-windows " +
      "--disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion",
    dir: "D:\\PaperAI-Build\\wv2-dbg-9702",
  },
];

for (const c of cases) {
  spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
  await sleep(1500);
  if (c.dir) {
    rmSync(c.dir, { recursive: true, force: true });
    mkdirSync(c.dir, { recursive: true });
  }

  const port = c.args.match(/--remote-debugging-port=(\d+)/)[1];
  const child = spawn(EXE, [PDF], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: c.args }, stdio: "ignore" });

  let up = false;
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      console.log(`${c.label}\n   => UP after ${(i + 1) * 1.5}s : ${j.Browser}`);
      up = true;
      break;
    } catch {
      /* retry */
    }
  }
  if (!up) console.log(`${c.label}\n   => DOWN after 18s`);

  // Also confirm the app itself is still healthy
  const q = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `$p = Get-Process PaperAI -EA SilentlyContinue | Select-Object -First 1; if ($p) { $p.MainWindowTitle } else { 'NOT RUNNING' }`],
    { encoding: "utf8" }
  ).stdout.trim();
  console.log(`   window title: ${q}`);
  try { child.kill(); } catch {}
  await sleep(1500);
}

spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
