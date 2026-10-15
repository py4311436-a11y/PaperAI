// Last K-13 avenue: does WebView2 honour --remote-debugging-pipe?
// (The TCP port route is dead: WebView2 strips --remote-debugging-port and
// overrides --user-data-dir with its own EBWebView folder.)
import { spawn, spawnSync } from "node:child_process";

const EXE = "D:\\PaperAI-Build\\target\\release\\PaperAI.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
await sleep(1500);

const c = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-pipe" },
  stdio: "ignore",
});
await sleep(9000);

const list = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", "[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | ForEach-Object { $_ }"],
  { encoding: "utf8", timeout: 60000 }
);
const pipes = (list.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
console.log(`named pipes present: ${pipes.length}`);
const interesting = pipes.filter((p) => /devtools|webview|paperai|launcher/i.test(p));
console.log(`matching devtools/webview: ${interesting.length ? interesting.join(", ") : "(none)"}`);
console.log(`all pipes: ${pipes.slice(0, 40).join(", ")}`);

// And confirm the flag still is not on the child command line
const cl = spawnSync(
  "powershell",
  ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | ForEach-Object { $_.CommandLine }"],
  { encoding: "utf8", timeout: 120000 }
);
const cmdlines = (cl.stdout || "").split(/\r?\n/).filter((l) => l.trim());
console.log(`\nmsedgewebview2 cmdlines: ${cmdlines.length}`);
for (const l of cmdlines) {
  console.log(`  has --remote-debugging-pipe: ${l.includes("--remote-debugging-pipe") ? "YES" : "no"}`);
}

try { c.kill(); } catch {}
spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
