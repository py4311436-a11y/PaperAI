# Clean up what the instrumented experiment installer left behind:
#   - the version it installed
#   - the `.pdf` default value that Tauri's APP_ASSOCIATE had hijacked
#   - every PaperAI association key
# Restores the machine to a state where the user's own PDF handler is untouched.
$ErrorActionPreference = "SilentlyContinue"
$log = @()

$u = Join-Path $env:LOCALAPPDATA "PaperAI\uninstall.exe"
if (Test-Path $u) {
    $p = Start-Process -FilePath $u -ArgumentList "/S" -Wait -PassThru
    $log += "uninstall exit=$($p.ExitCode)"
} else {
    $log += "nothing installed"
}
Start-Sleep -Seconds 3

$pdfKey = 'HKCU:\SOFTWARE\Classes\.pdf'
$before = (Get-ItemProperty $pdfKey).'(default)'
$log += ".pdf default before: '$before'"

# The stray ProgID created by APP_ASSOCIATE
if (Test-Path 'HKCU:\SOFTWARE\Classes\PDF Document') {
    Remove-Item 'HKCU:\SOFTWARE\Classes\PDF Document' -Recurse -Force
    $log += "removed stray ProgID 'PDF Document'"
}

# If APP_ASSOCIATE hijacked the default, drop our claim so the user's handler wins again
if ($before -eq 'PDF Document') {
    Remove-ItemProperty -Path $pdfKey -Name '(default)'
    $log += "cleared hijacked .pdf default value"
}

# Association keys this project creates
Remove-ItemProperty -Path (Join-Path $pdfKey 'OpenWithProgids') -Name 'PaperAI.exe'
Remove-ItemProperty -Path (Join-Path $pdfKey 'OpenWithList') -Name 'PaperAI.exe'
Remove-Item 'HKCU:\SOFTWARE\Classes\Applications\PaperAI.exe' -Recurse -Force

$after = (Get-ItemProperty $pdfKey).'(default)'
$log += ".pdf default after: '$after'"
$log += "UserChoice ProgId: " + (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice').ProgId
$log += "PaperAI.exe still installed: " + (Test-Path (Join-Path $env:LOCALAPPDATA 'PaperAI\PaperAI.exe'))

$log | Set-Content -Path "D:\AIreader\PaperAI-PoC\evidence\stage-c\cleanup-before-final.txt" -Encoding UTF8
