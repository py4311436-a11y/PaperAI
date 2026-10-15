// Open the annotated PDF in WPS Office's PDF component (an independent,
// non-PDFium engine) and capture the window with PrintWindow.
//
// This is the real cross-reader check: the file was produced by PDF.js and is
// now being rendered by somebody else's parser.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\AIreader\\PaperAI-PoC";
const EVIDENCE = path.join(ROOT, "evidence", "stage-d");
mkdirSync(EVIDENCE, { recursive: true });

const WPS = "D:\\Program Files\\WPS Office\\12.1.0.28505\\office6\\wps.exe";
const PDF = process.argv[2] ?? path.join(ROOT, "output", "annotated-desktop.pdf");
const OUT = process.argv[3] ?? path.join(EVIDENCE, "wps-annotated.png");
const TITLE_HINT = process.argv[4] ?? "annotated-desktop";
const WAIT_MS = Number(process.argv[5] ?? 22000);
const SCROLL_STEPS = Number(process.argv[6] ?? 10);

if (!existsSync(WPS)) {
  console.log("WPS not found at", WPS);
  process.exit(2);
}
if (!existsSync(PDF)) {
  console.log("PDF not found at", PDF);
  process.exit(2);
}

// WPS writes a lock/meta file next to the document; work on a copy so we never
// touch the artefact under test.
const local = path.join(EVIDENCE, "annotated-WPS-GUI.pdf");
rmSync(local, { force: true });
copyFileSync(PDF, local);
console.log("opening:", local);

const child = spawn(WPS, ["/prometheus", "/pdf", local], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(WAIT_MS);

const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$src = @"
using System;using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
  public struct R { public int Left, Top, Right, Bottom; }
  public const uint PW_RENDERFULLCONTENT = 0x00000002;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
}
"@
Add-Type -TypeDefinition $src -ErrorAction Stop

$cands = Get-Process -EA SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${TITLE_HINT}*' }
if (-not $cands) {
  $titles = (Get-Process -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName + ' :: ' + $_.MainWindowTitle }) -join ' || '
  Write-Output ("NO_MATCH|hint=${TITLE_HINT}|saw: " + $titles)
  exit 1
}
$w = $cands | Select-Object -First 1
$h = $w.MainWindowHandle
Write-Output ("MATCH|" + $w.ProcessName + " | " + $w.MainWindowTitle)

[void][PW]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1500

# Scroll down so the annotated region is in view. The Highlight/Ink objects sit
# roughly 40% down page 1 (PDF y ~464-477 of a 792pt page, i.e. from the top
# 792-477 .. 792-464). Click the page area first so the view has focus —
# without it the wheel events go nowhere.
$r0 = New-Object PW+R
[void][PW]::GetWindowRect($h, [ref]$r0)
$cx = $r0.Left + [int](($r0.Right - $r0.Left) / 2)
$cy = $r0.Top + [int](($r0.Bottom - $r0.Top) / 2)

$sig2 = @"
using System;using System.Runtime.InteropServices;
public class PW2 {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraPoint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
}
"@
Add-Type -TypeDefinition $sig2 -ErrorAction Stop

[void][PW2]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 400
[PW2]::mouse_event([PW2]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
[PW2]::mouse_event([PW2]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 700

# Home returns to the top of the document so the scroll count is reproducible
# (otherwise a previous run's position leaks into this one).
$wshell = New-Object -ComObject WScript.Shell
[void]$wshell.AppActivate($w.MainWindowTitle)
Start-Sleep -Milliseconds 600
[void]$wshell.SendKeys('{HOME}')
Start-Sleep -Milliseconds 900

for ($i = 0; $i -lt ${SCROLL_STEPS}; $i++) {
  [PW2]::mouse_event([PW2]::MOUSEEVENTF_WHEEL, 0, 0, -240, 0)
  Start-Sleep -Milliseconds 250
}
Start-Sleep -Milliseconds 1200

$r = New-Object PW+R
[void][PW]::GetWindowRect($h, [ref]$r)
$ww = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
Write-Output ("RECT|{0}x{1}" -f $ww, $hh)
if ($ww -le 0 -or $hh -le 0) { Write-Output 'BAD_RECT'; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($ww, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PW]::PrintWindow($h, $hdc, [PW]::PW_RENDERFULLCONTENT)
$g.ReleaseHdc($hdc)
Write-Output ("PRINTWINDOW_OK|" + $ok)
$bmp.Save('${OUT.replace(/\\/g, "\\\\")}')
$g.Dispose(); $bmp.Dispose()
Write-Output 'SAVED'
`;

const r = spawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
  { encoding: "utf8", timeout: 240000 }
);
console.log((r.stdout || "").trim());
if (r.stderr) console.log("STDERR:", r.stderr.slice(0, 400));
console.log("file exists:", existsSync(OUT));

// leave WPS open for the human; the caller can close it
if (process.env.KEEP_OPEN !== "1") {
  spawnSync("powershell", ["-NoProfile", "-Command", "Get-Process wps -EA SilentlyContinue | Stop-Process -Force"], { encoding: "utf8" });
}
try { child.kill(); } catch {}
