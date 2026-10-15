// Decisive test for K-13 on WebView2: does the msedgewebview2 child process
// actually RECEIVE --remote-debugging-port? If not, WebView2 strips it from
// additionalBrowserArguments and no amount of user-data-dir juggling helps.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const EXE = "D:\\PaperAI-Build\\target\\release\\PaperAI.exe";
const PDF = "D:\\AIreader\\PaperAI-PoC\\test-fixtures\\dual\\IEEE 双栏 论文 副本.pdf";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
await sleep(1500);

const dir = "D:\\PaperAI-Build\\wv2-cmdline";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const args =
  "--remote-debugging-port=9800 --user-data-dir=" + dir + " " +
  "--disable-renderer-backgrounding --disable-background-timer-throttling";

const child = spawn(EXE, [PDF], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args }, stdio: "ignore" });
await sleep(10000);

const r = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ForEach-Object { $_.CommandLine }",
  ],
  { encoding: "utf8", timeout: 120000 }
);

const lines = (r.stdout || "").split(/\r?\n/).filter((l) => l.trim());
console.log(`msedgewebview2 processes: ${lines.length}`);
for (const l of lines) {
  // Print the flags we care about, and whether they survived
  const has = (f) => (l.includes(f) ? "YES" : "no");
  console.log(`  --remote-debugging-port : ${has("--remote-debugging-port")}`);
  console.log(`  --user-data-dir         : ${has("--user-data-dir")}`);
  console.log(`  --disable-renderer-backgrounding : ${has("--disable-renderer-backgrounding")}`);
  const m = l.match(/--remote-debugging-port=(\d+)/);
  console.log(`  port value              : ${m ? m[1] : "(absent)"}`);
  console.log(`  full cmdline (first 400): ${l.slice(0, 400)}`);
}

// Port check for completeness
let up = false;
for (let i = 0; i < 6; i++) {
  await sleep(1500);
  try {
    await (await fetch("http://127.0.0.1:9800/json/version")).json();
    up = true;
    break;
  } catch {}
}
console.log(`port 9800: ${up ? "UP" : "DOWN"}`);

try { child.kill(); } catch {}
spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
