# PaperAI Phase 2 / Stage A
# Install the minimal MSVC toolchain Tauri 2 requires on Windows:
#   * MSVC v143 C++ x64/x86 build tools (link.exe, cl.exe)
#   * Windows 11 SDK (rc.exe, windows.h, import libs)
#
# The main install path is pinned to D: to honour the user's constraint, but
# Visual Studio shared components and the Windows SDK are ALWAYS installed
# under C:\Program Files (x86) by the VS installer (Microsoft limitation).
#
# Requires administrator rights -> launched with -Verb RunAs (UAC prompt).
# Non-destructive: adds components only, removes nothing.

$ErrorActionPreference = "Stop"

$Bootstrapper = "D:\PaperAI-Build\tools\vs_BuildTools.exe"
$InstallPath  = "D:\PaperAI-Build\VS2022BT"

if (-not (Test-Path $Bootstrapper)) {
    throw "Bootstrapper not found: $Bootstrapper"
}

$args = @(
    "--quiet"
    "--wait"
    "--norestart"
    "--nocache"
    "--installPath", $InstallPath
    "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
    "--add", "Microsoft.VisualStudio.Component.Windows11SDK.26100"
)

Write-Host "Launching elevated VS Build Tools installer..."
Write-Host "  bootstrapper : $Bootstrapper"
Write-Host "  installPath  : $InstallPath"
Write-Host "  components   : VC.Tools.x86.x64, Windows11SDK.26100"
Write-Host "  (approve the UAC prompt to continue)"

$p = Start-Process -FilePath $Bootstrapper -ArgumentList $args -Verb RunAs -Wait -PassThru
Write-Host "Installer exit code: $($p.ExitCode)"

# Report what landed on disk
$cl = Get-ChildItem "$InstallPath\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe" -ErrorAction SilentlyContinue
Write-Host "cl.exe under installPath: $(if ($cl) { $cl.FullName } else { 'NOT FOUND' })"

$sdk = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\rc.exe" -ErrorAction SilentlyContinue |
       Sort-Object FullName | Select-Object -Last 1
Write-Host "rc.exe (Windows SDK)    : $(if ($sdk) { $sdk.FullName } else { 'NOT FOUND' })"

exit $p.ExitCode
