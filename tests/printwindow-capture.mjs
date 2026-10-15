// Capture a window's real content with PrintWindow(PW_RENDERFULLCONTENT).
//
// CopyFromScreen only reads the composited framebuffer, which is why it kept
// returning the desktop wallpaper. PrintWindow instead asks the window to
// render itself, and PW_RENDERFULLCONTENT (Windows 8.1+) makes it render the
// full surface rather than only the visible part — this is the standard way to
// capture a window that is occluded or on a non-interactive session.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "D:\\AIreader\\PaperAI-PoC";
const EVIDENCE = path.join(ROOT, "evidence", "stage-d");
mkdirSync(EVIDENCE, { recursive: true });

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PDF = process.argv[2] ?? path.join(EVIDENCE, "annotated-EDGE-GUI.pdf");
const OUT = process.argv[3] ?? path.join(EVIDENCE, "edge-printwindow.png");
const WAIT_MS = Number(process.argv[4] ?? 15000);

const child = spawn(
  EDGE,
  [
    `--app=file:///${PDF.replace(/\\/g, "/")}`,
    `--user-data-dir=${path.join(EVIDENCE, "edge-pw-profile")}`,
    "--no-first-run",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(WAIT_MS);

const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$src = @"
using System;using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct R { public int Left, Top, Right, Bottom; }
  public const uint PW_RENDERFULLCONTENT = 0x00000002;
}
"@
Add-Type -TypeDefinition $src -ErrorAction Stop

$w = Get-Process -Name msedge -EA SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*annotated-EDGE-GUI*' } |
     Select-Object -First 1
if (-not $w) {
  # Fall back to listing what is there, so the failure is diagnosable.
  $all = (Get-Process -Name msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.MainWindowTitle }) -join ' || '
  Write-Output ("NO_PDF_WINDOW|saw: " + $all)
  exit 1
}
$h = $w.MainWindowHandle
Write-Output ("TITLE|" + $w.MainWindowTitle)

[void][PW]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1200

$r = New-Object PW+R
[void][PW]::GetWindowRect($h, [ref]$r)
$ww = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
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
  { encoding: "utf8", timeout: 180000 }
);
console.log((r.stdout || "").trim());
if (r.stderr) console.log("STDERR:", r.stderr.slice(0, 400));
console.log("file exists:", existsSync(OUT));
try { child.kill(); } catch {}
