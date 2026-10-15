// Launch the real PaperAI window and capture the desktop, so the actual UI
// state can be inspected (used when CDP evaluation hangs).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const OUT = process.argv[3] ?? path.join(ROOT, "evidence", "stage-b", "app-window.png");
const EXE = process.argv[2] ?? "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const WAIT = Number(process.argv[4] ?? 9000);
mkdirSync(path.dirname(OUT), { recursive: true });

const child = spawn(EXE, [], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(WAIT);

const ps1 = spawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
   `Get-Process -Name PaperAI -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + ' | ' + $_.MainWindowTitle + ' | responding=' + $_.Responding }`],
  { encoding: "utf8" }
);
console.log("processes:\n" + (ps1.stdout || "").trim());

const ps2 = spawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `

Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process -Name PaperAI -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'no window'; exit 1 }
$h = $p.MainWindowHandle
[void][Win32]::ShowWindow($h, 9)          # SW_RESTORE
[void][Win32]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 800
$r = New-Object Win32+RECT
[void][Win32]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
Write-Output ("rect {0},{1} {2}x{3}" -f $r.Left,$r.Top,$w,$ht)
if ($w -le 0 -or $ht -le 0) { exit 1 }
$b = New-Object System.Drawing.Bitmap($w,$ht)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($r.Left,$r.Top,0,0,(New-Object System.Drawing.Size($w,$ht)))
$b.Save('${OUT.replace(/\\/g, "\\\\")}')
$g.Dispose(); $b.Dispose()
Write-Output 'saved'
`],
  { encoding: "utf8", timeout: 90000 }
);
console.log("window capture:", (ps2.stdout || "").trim(), ps2.status === 0 ? "" : (ps2.stderr || "").slice(0, 300));
console.log("file:", OUT);

try { child.kill(); } catch {}
