// Diagnose whether this session has an interactive desktop / compositor.
// Run via Node -> powershell because the PowerShell *tool* blocks Add-Type,
// and we need P/Invoke for OpenInputDesktop.
import { spawnSync } from "node:child_process";

const script = `
$ErrorActionPreference = 'SilentlyContinue'
$log = @()
$log += "session id       : " + $PID
$log += "SESSIONNAME      : $env:SESSIONNAME"
$log += "UserInteractive  : " + [Environment]::UserInteractive
$log += "explorer window  : " + ((Get-Process -Name explorer -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowTitle)
$dwm = Get-Process -Name dwm -EA SilentlyContinue
$log += "dwm (compositor) : " + $(if ($dwm) { "running (" + [math]::Round($dwm.WorkingSet64/1MB,1) + " MB)" } else { "NOT RUNNING" })
$screens = [System.Windows.Forms.Screen]::AllScreens
$log += "screens          : " + $screens.Count
$log += "primary bounds   : " + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$src = @"
using System;using System.Runtime.InteropServices;
public class Dsk {
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint m);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
}
"@
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
  $h = [Dsk]::OpenInputDesktop(0, $false, 0x0100)
  if ($h -eq [IntPtr]::Zero) {
    $log += "OpenInputDesktop : FAILED err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  } else {
    $log += "OpenInputDesktop : OK (interactive input desktop present)"
    [void][Dsk]::CloseDesktop($h)
  }
} catch {
  $log += "OpenInputDesktop : probe failed - " + $_.Exception.Message.Split([char]10)[0]
}

$log | Set-Content -Path "D:\\AIreader\\PaperAI-PoC\\evidence\\stage-d\\desktop-diagnosis.txt" -Encoding UTF8
$log -join [Environment]::NewLine
`;

const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 120000 });
console.log(r.stdout || "");
if (r.stderr) console.log("STDERR:", r.stderr.slice(0, 500));
