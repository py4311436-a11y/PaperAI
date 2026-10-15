// Find the command line WPS registered for .pdf, plus any other third-party
// PDF reader on this machine, so we can drive one as an independent
// (non-PDFium) reader.
import { spawnSync } from "node:child_process";

const script = `
$ErrorActionPreference = 'SilentlyContinue'
$log = @()

foreach ($key in @(
  'HKCU:\\SOFTWARE\\Classes\\KWPS.PDF.9\\shell\\open\\command',
  'HKLM:\\SOFTWARE\\Classes\\KWPS.PDF.9\\shell\\open\\command'
)) {
  if (Test-Path $key) { $log += "$key => " + (Get-ItemProperty $key).'(default)' }
}

foreach ($p in @(
  "$env:LOCALAPPDATA\\Programs\\Kingsoft\\WPS Office",
  "C:\\Program Files\\Kingsoft\\WPS Office",
  "$env:LOCALAPPDATA\\Kingsoft\\WPS Office",
  "D:\\Program Files\\Kingsoft\\WPS Office"
)) {
  if (Test-Path $p) {
    $log += "dir: $p"
    Get-ChildItem $p -Recurse -Filter 'wps.exe' -EA SilentlyContinue |
      Select-Object -First 3 | ForEach-Object { $log += "  exe: " + $_.FullName }
  }
}

Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs" -Recurse -Filter '*.lnk' -EA SilentlyContinue |
  Where-Object { $_.Name -match 'PDF|WPS|Acrobat|Foxit|Sumatra' } |
  Select-Object -First 8 | ForEach-Object { $log += "shortcut: " + $_.Name }

$log | Set-Content -Path 'D:\\AIreader\\PaperAI-PoC\\evidence\\stage-d\\reader-inventory.txt' -Encoding UTF8
$log -join [Environment]::NewLine
`;

const r = spawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
  { encoding: "utf8", timeout: 240000 }
);
console.log(r.stdout || "");
if (r.stderr) console.log("STDERR:", r.stderr.slice(0, 400));
