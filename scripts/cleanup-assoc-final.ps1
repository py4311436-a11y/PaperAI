# Final cleanup of the `.pdf` default value hijacked by the instrumented
# experiment build. Uses reg.exe because PowerShell's Remove-ItemProperty does
# not remove a key's default (unnamed) value.
$ErrorActionPreference = "SilentlyContinue"
$log = @()

$log += "before: '" + (Get-ItemProperty 'HKCU:\SOFTWARE\Classes\.pdf').'(default)' + "'"

# Remove the unnamed default value of HKCU\Software\Classes\.pdf
& reg.exe delete "HKCU\Software\Classes\.pdf" /ve /f 2>&1 | ForEach-Object { $log += $_ }

# Drop the stray ProgID the experiment's APP_ASSOCIATE created
& reg.exe delete "HKCU\Software\Classes\PDF Document" /f 2>&1 | ForEach-Object { $log += $_ }

# And any leftover candidate entries from earlier rounds
& reg.exe delete "HKCU\Software\Classes\.pdf\OpenWithProgids" /v PaperAI.exe /f 2>&1 | ForEach-Object { $log += $_ }
& reg.exe delete "HKCU\Software\Classes\.pdf\OpenWithList" /v PaperAI.exe /f 2>&1 | ForEach-Object { $log += $_ }
& reg.exe delete "HKCU\Software\Classes\Applications\PaperAI.exe" /f 2>&1 | ForEach-Object { $log += $_ }

$log += "after: '" + (Get-ItemProperty 'HKCU:\SOFTWARE\Classes\.pdf').'(default)' + "'"
$log += "UserChoice ProgId: " + (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice').ProgId
$log | Set-Content -Path "D:\AIreader\PaperAI-PoC\evidence\stage-c\cleanup-final.txt" -Encoding UTF8
