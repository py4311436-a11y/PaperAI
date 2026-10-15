# Diagnose whether this session has an interactive desktop at all.
# K-02 (cross-reader GUI verification) was blocked on the assumption that it
# does not. Establish the facts before trying workarounds.
$ErrorActionPreference = "SilentlyContinue"
$log = @()

$log += "session id      : $([System.Diagnostics.Process]::GetCurrentProcess().SessionId)"
$log += "user interactive: $([Environment]::UserInteractive)"
$log += "PROCESSOR_ARCH  : $env:PROCESSOR_ARCHITECTURE"
$log += "SESSIONNAME     : $env:SESSIONNAME"

# Is the workstation locked? (0x0 = everything ok, 0x1 = locked, 0x2 = no desktop)
Add-Type -AssemblyName System.Windows.Forms
$log += "SystemInformation::UserInteractive : $([System.Windows.Forms.SystemInformation]::UserInteractive)"

# Does the desktop window exist?
$desktop = Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$log += "explorer window  : " + $(if ($desktop) { $desktop.MainWindowTitle } else { "none" })

# Is DWM running? (the compositor)
$dwm = Get-Process -Name dwm -ErrorAction SilentlyContinue
$log += "dwm (compositor) : " + $(if ($dwm) { "running, " + [math]::Round($dwm.WorkingSet64/1MB,1) + " MB" } else { "NOT RUNNING" })

# OpenInputDesktop tells us whether an input desktop is available
$sig = @'
using System;using System.Runtime.InteropServices;
public class D {
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint m);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SwitchDesktop(IntPtr h);
}
'@
try {
  Add-Type -TypeDefinition $sig -ErrorAction Stop
  $h = [D]::OpenInputDesktop(0, false, 0x0100) # GENERIC_ALL
  $log += "OpenInputDesktop : " + $(if ($h -eq [IntPtr]::Zero) { "FAILED (err " + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ")" } else { "OK -> interactive desktop present" })
  if ($h -ne [IntPtr]::Zero) { [void][D]::CloseDesktop($h) }
} catch {
  $log += "OpenInputDesktop : could not probe ($($_.Exception.Message.Split([char]10)[0]))"
}

# Screen metrics
$log += "primary screen    : $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)"
$log += "screen count      : $([System.Windows.Forms.Screen]::AllScreens.Count)"

$log | Set-Content -Path "D:\AIreader\PaperAI-PoC\evidence\stage-d\desktop-diagnosis.txt" -Encoding UTF8
