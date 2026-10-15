# PaperAI — register PaperAI as a .pdf "Open with" candidate (per user).
#
# WHY THIS EXISTS
#   `bundle.fileAssociations` is declared in src-tauri/tauri.conf.json, but with
#   NSIS `installMode: "currentUser"` the Tauri 2.12.3 bundler wrote NO
#   association registry entries at all on this machine (verified by dumping
#   HKCU/HKLM\SOFTWARE\Classes after a silent install — see
#   evidence/stage-c/assoc-detail.txt). `role` is a macOS-only field and has no
#   effect on Windows.
#
# WHAT IT DOES
#   Adds PaperAI to the *candidate* lists only:
#     HKCU\Software\Classes\Applications\PaperAI.exe        (shows in "Open with")
#     HKCU\Software\Classes\.pdf\OpenWithProgids\PaperAI.exe
#     HKCU\Software\Classes\.pdf\OpenWithList\PaperAI.exe
#   It never writes UserChoice, so the user's default PDF reader is untouched.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-file-association.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-file-association.ps1 -Unregister
param([switch]$Unregister)

$ErrorActionPreference = "Stop"

$exe = Join-Path $env:LOCALAPPDATA "PaperAI\PaperAI.exe"
if (-not (Test-Path $exe)) {
    $exe = Join-Path $env:LOCALAPPDATA "Programs\PaperAI\PaperAI.exe"
}
# Unregistering must work even after the app itself was removed.
if (-not $Unregister -and -not (Test-Path $exe)) {
    Write-Error "PaperAI.exe not found. Install PaperAI first."
    exit 1
}

$classes = "HKCU:\Software\Classes"

if ($Unregister) {
    Remove-Item -Path "$classes\Applications\PaperAI.exe" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "$classes\.pdf\OpenWithProgids" -Name "PaperAI.exe" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "$classes\.pdf\OpenWithList"   -Name "PaperAI.exe" -ErrorAction SilentlyContinue
    Write-Host "PaperAI removed from the .pdf candidate list."
    exit 0
}

New-Item -Path "$classes\Applications\PaperAI.exe" -Force | Out-Null
Set-ItemProperty -Path "$classes\Applications\PaperAI.exe" -Name "(default)" -Value "PaperAI"
New-Item -Path "$classes\Applications\PaperAI.exe\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$classes\Applications\PaperAI.exe\DefaultIcon" -Name "(default)" -Value "$exe,0"
New-Item -Path "$classes\Applications\PaperAI.exe\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$classes\Applications\PaperAI.exe\shell\open\command" -Name "(default)" -Value ('"' + $exe + '" "%1"')

New-Item -Path "$classes\.pdf\OpenWithProgids" -Force | Out-Null
New-ItemProperty -Path "$classes\.pdf\OpenWithProgids" -Name "PaperAI.exe" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "$classes\.pdf\OpenWithList" -Force | Out-Null
New-ItemProperty -Path "$classes\.pdf\OpenWithList" -Name "PaperAI.exe" -Value "" -PropertyType String -Force | Out-Null

Write-Host "Registered: $exe"
Write-Host "PaperAI is now offered in 'Open with' for .pdf. The default reader was not changed."
