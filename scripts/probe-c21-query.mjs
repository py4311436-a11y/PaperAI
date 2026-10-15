// Reproduce the exact C2.1 query used by tests/windows-integration.mjs, run
// right after a fresh install, so we can see whether the query or the install
// is at fault.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SETUP = "D:\\AIreader\\PaperAI-PoC\\dist\\installer\\PaperAI_0.2.0_x64-setup.exe";
const marker = path.join(os.tmpdir(), "paperai-hook-ran.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(script) {
  const wrapped = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapped], { encoding: "utf8", timeout: 120000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

console.log("--- uninstall any existing copy ---");
console.log(ps(`$u = Join-Path $env:LOCALAPPDATA 'PaperAI\\uninstall.exe'; if (Test-Path $u) { $p = Start-Process $u -ArgumentList '/S' -Wait -PassThru; "exit=" + $p.ExitCode } else { "not installed" }`).out);
await sleep(3000);

console.log("--- install (exactly like Stage C does) ---");
if (existsSync(marker)) rmSync(marker);
const r = spawnSync(SETUP, ["/S"], { encoding: "utf8", timeout: 300000 });
console.log("spawnSync status =", r.status, "| error =", r.error ? r.error.message : "none");
await sleep(3000);

console.log("--- exact C2.1 query ---");
const after = ps(
  `$hits = @(); ` +
    `foreach ($root in @('HKCU:\\SOFTWARE\\Classes','HKLM:\\SOFTWARE\\Classes')) { ` +
    `  $k = Join-Path $root 'Applications\\PaperAI.exe'; ` +
    `  if (Test-Path $k) { $hits += $k } ` +
    `  $o = Join-Path $root '.pdf\\OpenWithProgids'; ` +
    `  if (Test-Path $o) { $v = (Get-Item $o).Property; if ($v -contains 'PaperAI.exe') { $hits += $o + ' contains PaperAI.exe' } } ` +
    `} ` +
    `$hits -join ' ;; '`
);
console.log("out   :", JSON.stringify(after.out));
console.log("err   :", JSON.stringify(after.err));

console.log("--- simpler direct checks ---");
for (const [label, q] of [
  ["Test-Path HKCU Apps\\PaperAI.exe", `Test-Path 'HKCU:\\SOFTWARE\\Classes\\Applications\\PaperAI.exe'`],
  ["OpenWithProgids values", `((Get-Item 'HKCU:\\SOFTWARE\\Classes\\.pdf\\OpenWithProgids' -EA SilentlyContinue).Property) -join ','`],
  ["reg query", `reg query "HKCU\\Software\\Classes\\Applications\\PaperAI.exe" 2>&1`],
]) {
  const res = ps(q);
  console.log(`${label}: ${JSON.stringify(res.out)} ${res.err ? "ERR:" + res.err : ""}`);
}
