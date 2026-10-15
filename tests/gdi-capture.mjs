// GDI window capture for a launched process (Edge app-window on a PDF).
// Node -> powershell, because the PowerShell *tool* blocks Add-Type.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const OUT = process.argv[2] ?? path.join(ROOT, "evidence", "stage-d", "edge-gdi.png");
const EXE = process.argv[3] ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URLARG = process.argv[4] ?? "";
const PROFILE = process.argv[5] ?? path.join(ROOT, "evidence", "stage-d", "edge-gdi-profile");
const WAIT = Number(process.argv[6] ?? 14000);
const PROCNAME = path.basename(EXE, ".exe");
mkdirSync(path.dirname(OUT), { recursive: true });

const args = URLARG ? [`--app=${URLARG}`, `--user-data-dir=${PROFILE}`, "--no-first-run"] : [];
const child = spawn(EXE, args, { stdio: "ignore" });
await new Promise((r) => setTimeout(r, WAIT));

const script = `
$w = Get-Process -Name '${PROCNAME}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $w) { Write-Output 'NO_WINDOW'; exit 1 }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); public struct R { public int Left, Top, Right, Bottom; } }
"@
[void][W]::SetForegroundWindow($w.MainWindowHandle)
Start-Sleep -Milliseconds 1500
$r = New-Object W+R
[void][W]::GetWindowRect($w.MainWindowHandle, [ref]$r)
$ww = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
Write-Output ("TITLE|" + $w.MainWindowTitle)
Write-Output ("RECT|{0},{1}|{2}x{3}" -f $r.Left,$r.Top,$ww,$hh)
if ($ww -le 0 -or $hh -le 0) { exit 1 }
$b = New-Object System.Drawing.Bitmap($ww,$hh)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($r.Left,$r.Top,0,0,(New-Object System.Drawing.Size($ww,$hh)))
$b.Save('${OUT.replace(/\\/g, "\\\\")}')
$g.Dispose(); $b.Dispose()
Write-Output 'SAVED'
`;

const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 120000 });
console.log((r.stdout || "").trim());
if (r.stderr) console.log("stderr:", r.stderr.slice(0, 300));
try { child.kill(); } catch {}
