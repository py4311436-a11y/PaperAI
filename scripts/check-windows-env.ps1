# PaperAI Phase 2 — non-destructive Windows toolchain inventory.
# Collects the versions Stage A/B/C/D depend on. Reads only; installs nothing.
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-windows-env.ps1
#         .\scripts\check-windows-env.ps1 -Json | Out-File reports\env.json

param([switch]$Json)

$ErrorActionPreference = "Continue"
$r = [ordered]@{}

function Cmd-Version($exe, $args) {
    try {
        $p = & $exe @args 2>&1 | Out-String
        return $p.Trim() -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1
    } catch { return $null }
}

# --- OS -------------------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
$r.os_caption  = $os.Caption
$r.os_version  = $os.Version
$r.os_build    = $os.BuildNumber
$r.arch        = $env:PROCESSOR_ARCHITECTURE

# --- disks ----------------------------------------------------------------
$disks = @()
foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
    $disks += [ordered]@{
        drive      = $d.DeviceID
        size_gb    = [math]::Round($d.Size / 1GB, 1)
        free_gb    = [math]::Round($d.FreeSpace / 1GB, 1)
        filesystem = $d.FileSystem
    }
}
$r.disks = $disks

# --- node / npm -----------------------------------------------------------
$r.node = Cmd-Version "node" @("--version")
$r.npm  = Cmd-Version "npm"  @("--version")

# --- rust -----------------------------------------------------------------
$r.cargo_home    = $env:CARGO_HOME
$r.rustup_home   = $env:RUSTUP_HOME
$r.target_dir    = $env:CARGO_TARGET_DIR
$r.rustc         = Cmd-Version "rustc" @("--version")
$r.cargo         = Cmd-Version "cargo" @("--version")
if (-not $r.rustc) {
    $alt = "D:\.cargo\bin\rustc.exe"
    if (Test-Path $alt) { $r.rustc = Cmd-Version $alt @("--version") }
}
if (-not $r.cargo) {
    $alt = "D:\.cargo\bin\cargo.exe"
    if (Test-Path $alt) { $r.cargo = Cmd-Version $alt @("--version") }
}

# --- MSVC / Windows SDK ---------------------------------------------------
$msvcRoots = @(
    "D:\PaperAI-Build\VS2022BT\VC\Tools\MSVC",
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Tools\MSVC",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC"
)
$r.msvc_cl = @()
foreach ($root in $msvcRoots) {
    if (Test-Path $root) {
        Get-ChildItem "$root\*\bin\Hostx64\x64\cl.exe" -ErrorAction SilentlyContinue |
            ForEach-Object { $r.msvc_cl += $_.FullName }
    }
}
$r.winsdk = @()
$kits = "C:\Program Files (x86)\Windows Kits\10"
if (Test-Path "$kits\Include") {
    $r.winsdk = (Get-ChildItem "$kits\Include" | ForEach-Object { $_.Name })
}
$r.winsdk_rc = @()
if (Test-Path "$kits\bin") {
    Get-ChildItem "$kits\bin\*\x64\rc.exe" -ErrorAction SilentlyContinue |
        ForEach-Object { $r.winsdk_rc += $_.FullName }
}

# --- WebView2 --------------------------------------------------------------
$wv = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$r.webview2_runtime = if (Test-Path $wv) { (Get-ItemProperty $wv).pv } else { $null }
$r.webview2_dirs = @()
if (Test-Path "C:\Program Files (x86)\Microsoft\EdgeWebView\Application") {
    $r.webview2_dirs = Get-ChildItem "C:\Program Files (x86)\Microsoft\EdgeWebView\Application" -Directory |
                       ForEach-Object { $_.Name }
}

# --- Edge -----------------------------------------------------------------
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$r.edge_exe = if (Test-Path $edge) { $edge } else { $null }
$ev = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{56EB18F8-8008-4CBD-B6D2-8C97FE7E9062}" -ErrorAction SilentlyContinue
$r.edge_version = if ($ev) { $ev.pv } else { $null }

# --- Acrobat Reader -------------------------------------------------------
$acro = @()
$acro += (Get-ChildItem "C:\Program Files\Adobe\Acrobat*\Reader\AcroRd32.exe" -ErrorAction SilentlyContinue).FullName
$acro += (Get-ChildItem "C:\Program Files (x86)\Adobe\Acrobat*\Reader\AcroRd32.exe" -ErrorAction SilentlyContinue).FullName
$r.acrobat_reader = $acro | Where-Object { $_ }

# --- current PDF default handler -----------------------------------------
$progid = $null
$key = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice"
if (Test-Path $key) { $progid = (Get-ItemProperty $key).ProgId }
$r.pdf_default_progid = $progid

if ($Json) {
    $r | ConvertTo-Json -Depth 5
} else {
    "=== PaperAI environment ==="
    foreach ($k in $r.Keys) {
        $v = $r[$k]
        if ($v -is [array]) { "{0,-22}: {1}" -f $k, ($(if ($v.Count) { $v -join ", " } else { "(none)" })) }
        else { "{0,-22}: {1}" -f $k, $(if ($v) { $v } else { "(none)" }) }
    }
}
