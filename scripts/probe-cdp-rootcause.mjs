// Minimal reproduction for K-13: can Edge itself open a debug port right now?
// If Edge fails too it is system-wide; if Edge works but WebView2 does not, it
// is WebView2's additionalBrowserArguments handling.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probePort(port, label) {
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      console.log(`${label}: UP after ${(i + 1) * 1.5}s -> ${j.Browser}`);
      return true;
    } catch {
      /* keep waiting */
    }
  }
  console.log(`${label}: DOWN after 15s`);
  return false;
}

function kill(name) {
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-Process -Name ${name} -EA SilentlyContinue | Stop-Process -Force`], { encoding: "utf8" });
}

// --- Case A: Edge with --remote-debugging-port and a FRESH user-data-dir
{
  kill("msedge");
  await sleep(2000);
  const profile = "D:\\PaperAI-Build\\edge-dbg-a";
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const c = spawn(EDGE, ["--remote-debugging-port=9600", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  const ok = await probePort(9600, "A: Edge + fresh user-data-dir");
  try { c.kill(); } catch {}
  await sleep(1500);
}

// --- Case B: Edge with --remote-debugging-port and NO user-data-dir
{
  kill("msedge");
  await sleep(2000);
  const c = spawn(EDGE, ["--remote-debugging-port=9601", "--no-first-run", "about:blank"], { stdio: "ignore" });
  const ok = await probePort(9601, "B: Edge, default user-data-dir");
  try { c.kill(); } catch {}
  await sleep(1500);
}

// --- Case C: does the flag survive at all? Ask Edge to dump its own switches
{
  kill("msedge");
  await sleep(1500);
  const profile = "D:\\PaperAI-Build\\edge-dbg-c";
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  // chrome://version lists the command line the process actually received
  const c = spawn(EDGE, [`--user-data-dir=${profile}`, "--no-first-run", "chrome://version"], { stdio: "ignore" });
  await sleep(7000);
  const shot = "D:\\AIreader\\PaperAI-PoC\\evidence\\stage-b\\edge-version.png";
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `
    Add-Type -AssemblyName System.Drawing
    $src = @"
using System;using System.Runtime.InteropServices;
public class PW { [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); public struct R { public int L,T,Ri,B; } }
"@
    Add-Type -TypeDefinition $src
    $w = Get-Process msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*version*' } | Select-Object -First 1
    if (-not $w) { 'NO_WINDOW'; exit 1 }
    $r = New-Object PW+R; [void][PW]::GetWindowRect($w.MainWindowHandle, [ref]$r)
    $ww = $r.Ri - $r.L; $hh = $r.B - $r.T
    $b = New-Object System.Drawing.Bitmap($ww, $hh)
    $g = [System.Drawing.Graphics]::FromImage($b); $hdc = $g.GetHdc()
    [void][PW]::PrintWindow($w.MainWindowHandle, $hdc, 2)
    $g.ReleaseHdc($hdc); $b.Save('${shot}')
    'SAVED ' + $ww + 'x' + $hh
  `], { encoding: "utf8", timeout: 120000 });
  console.log("C: chrome://version capture ->", (r.stdout || "").trim());
  try { c.kill(); } catch {}
}

kill("msedge");
