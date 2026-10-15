// Install the freshly built package detached, wait, then report whether the
// NSIS hook's diagnostic file appeared.
// Written as a file because the shell keeps eating backslashes in -e strings.
import { spawn } from "node:child_process";
import { existsSync, statSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SETUP = "D:\\PaperAI-Build\\target\\release\\bundle\\nsis\\PaperAI_0.2.0_x64-setup.exe";
const marker = path.join(os.tmpdir(), "paperai-hook-ran.txt");

if (existsSync(marker)) rmSync(marker);

const child = spawn(SETUP, ["/S"], { stdio: "ignore", detached: true });
child.on("error", (e) => console.log("spawn error:", e.message));
child.unref();
console.log("launched:", SETUP);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 30; i++) {
  await sleep(2000);
  if (existsSync(marker)) break;
}

console.log("--- hook marker ---");
if (existsSync(marker)) {
  console.log("EXISTS:", statSync(marker).size, "bytes");
  console.log(readFileSync(marker, "utf8"));
} else {
  console.log("MISSING -> the NSIS_HOOK_PREINSTALL macro did not run");
}

console.log("--- registry-relevant state ---");
const { spawnSync } = await import("node:child_process");
const q = (ps1) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps1], { encoding: "utf8" }).stdout.trim();
console.log("Apps\\PaperAI.exe      :", q("[bool](Test-Path 'HKCU:\\SOFTWARE\\Classes\\Applications\\PaperAI.exe')"));
console.log("OpenWithProgids entry :", q("(((Get-Item 'HKCU:\\SOFTWARE\\Classes\\.pdf\\OpenWithProgids' -EA SilentlyContinue).Property) -contains 'PaperAI.exe')"));
console.log(".pdf default          :", q("(Get-ItemProperty 'HKCU:\\SOFTWARE\\Classes\\.pdf' -EA SilentlyContinue).'(default)'"));
console.log("installed exe         :", existsSync(path.join(os.homedir(), "AppData\\Local\\PaperAI\\PaperAI.exe")));
