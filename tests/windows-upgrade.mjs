/**
 * Upgrade-path verification: oldest available -> newest available.
 *
 * What "upgrade must not break the user" means here, concretely:
 *   1. the installer completes silently and the new version is what runs;
 *   2. existing provider settings survive (they live in
 *      %LOCALAPPDATA%\PaperAI\ai-profiles.json, not in the install dir);
 *   3. stored credentials survive — they are in Windows Credential Manager, and
 *      the installer must not touch them;
 *   4. the user's PDFs are untouched, and so is their default PDF reader;
 *   5. PaperAI is still registered as a .pdf "Open with" candidate.
 *
 * Usage: node tests/windows-upgrade.mjs \
 *          --old "<old setup.exe>" --new "<new setup.exe>"
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVIDENCE = path.join(ROOT, "evidence", "windows-release");
mkdirSync(EVIDENCE, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

/**
 * Pick installers out of `release/`, which is where shipped setups live.
 *
 * They used to sit in `dist/installer/`, but `dist/` is Tauri's frontendDist —
 * keeping them there made every build nest the previous installers inside the
 * new one (A-13). Nothing here should hardcode a version either: this test is
 * run against whatever is current.
 */
const RELEASE_DIR = path.join(ROOT, "release");

/** All PaperAI_x.y.z_x64-setup.exe in release/, oldest version first. */
function availableVersions() {
  if (!existsSync(RELEASE_DIR)) return [];
  return readdirSync(RELEASE_DIR)
    .map((f) => /^PaperAI_(\d+\.\d+\.\d+)_x64-setup\.exe$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ version: m[1], file: path.join(RELEASE_DIR, m[0]) }))
    .sort((a, b) => cmpVersion(a.version, b.version));
}

function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const available = availableVersions();
const newest = available[available.length - 1];
const oldest = available[0];

const OLD = arg("old", oldest?.file);
const NEW = arg("new", newest?.file);
const NEW_VERSION = NEW ? /PaperAI_(\d+\.\d+\.\d+)_/.exec(path.basename(NEW))?.[1] : null;

if (!OLD || !NEW) {
  console.error(
    `need at least two installers in ${RELEASE_DIR} (found ${available.length}).\n` +
      `build one with:  npx tauri build --config '{"build":{"beforeBuildCommand":""}}' && node scripts/collect-release.mjs`
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(id, name, status, note) {
  results.push({ id, name, status, note });
  console.log(`[${status.padEnd(8)}] ${id}  ${name}\n            ${String(note).replace(/\n/g, "\n            ")}`);
}

/* ===========================================================================
 * Non-destructive by construction.
 *
 * This suite must overwrite the user's provider settings and write a
 * Credential Manager entry — that is the only way to prove they survive an
 * upgrade. Two things are therefore mandatory:
 *
 *  1. The REAL settings file is copied aside and put back on exit. Registered
 *     through process.on("exit"), which fires for process.exit() and for an
 *     uncaught throw alike; a try/finally around main() would miss a hard exit
 *     buried in a helper.
 *
 *  2. The test uses a profile id of its own (TEST_PROFILE) rather than a real
 *     one. This is not cosmetic: the credential target is
 *     `PaperAI/AIProvider/<profile_id>`, so a test that writes
 *     `PaperAI/AIProvider/deepseek` SILENTLY OVERWRITES the user's actual
 *     DeepSeek key with a marker string — and the previous version of this file
 *     never deleted it afterwards. Anyone who ran it lost their key. A
 *     throwaway id cannot collide, and the entry is deleted at the end.
 * ===========================================================================
 */
const TEST_PROFILE = "paperai-upgrade-test";

/** Full Credential Manager target for a profile, mirroring src-tauri/src/ai/secrets.rs. */
const credTarget = (id) => `PaperAI/AIProvider/${id}`;

const REAL_CONFIG = path.join(process.env.LOCALAPPDATA, "PaperAI", "ai-profiles.json");
const realConfigBackup = existsSync(REAL_CONFIG) ? readFileSync(REAL_CONFIG) : null;
let configRestored = false;
process.on("exit", () => {
  if (configRestored || !realConfigBackup) return;
  try {
    mkdirSync(path.dirname(REAL_CONFIG), { recursive: true });
    writeFileSync(REAL_CONFIG, realConfigBackup);
    console.log(`\n[restore] 已还原你的 ai-profiles.json（${realConfigBackup.length} 字节）`);
  } catch (e) {
    console.error(`\n[restore] 还原 ai-profiles.json 失败：${e.message}`);
  }
});

function ps(script) {
  const wrapped = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapped],
    { encoding: "utf8", timeout: 180000 }
  );
  return (r.stdout || r.stderr || "").trim();
}

const LOCAL = "%LOCALAPPDATA%\\PaperAI";
const localDir = () => path.join(process.env.LOCALAPPDATA, "PaperAI");

/** Run an installer and wait for it, without blocking this process's loop. */
function install(setup) {
  return new Promise((resolve) => {
    // setup.exe /S spawns and returns immediately; poll the uninstaller instead.
    const c = spawn(setup, ["/S"], { stdio: "ignore" });
    c.on("close", () => resolve(null));
    c.on("error", () => resolve(null));
  });
}

/** Wait until a file exists (the installer writes it near the end). */
async function waitForFile(p, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Where the app's BINARY lives — not where its settings live.
 *
 * These are different directories. Settings are always
 * `%LOCALAPPDATA%\PaperAI\ai-profiles.json`, but the installer puts the
 * executable wherever NSIS was told to on the very first install and then
 * silently reuses that path forever. On this machine that is
 * `D:\Program Files\PaperAI`, so assuming %LOCALAPPDATA% made U1.1 and U2.7 read
 * "(none)" from a perfectly good install. The uninstall registry entry is the
 * authoritative source.
 */
function installDir() {
  return ps(
    `$u = Get-ChildItem 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ` +
      `  Get-ItemProperty | Where-Object { $_.DisplayName -like '*PaperAI*' } | Select-Object -First 1; ` +
      `if ($u -and $u.InstallLocation) { $u.InstallLocation.Trim('"') } else { '' }`
  );
}

function readInstalledVersion() {
  const dir = installDir();
  if (!dir) return "(none)";
  return ps(
    `$p = Join-Path ${JSON.stringify(dir)} 'PaperAI.exe'; ` +
      `if (Test-Path $p) { (Get-Item $p).VersionInfo.ProductVersion } else { '(none)' }`
  );
}

async function main() {
  if (!existsSync(OLD) || !existsSync(NEW)) {
    record("U0.1", "两个安装包都存在", "BLOCKED", `old=${existsSync(OLD)} new=${existsSync(NEW)}\n            ${OLD}\n            ${NEW}`);
    writeReport();
    process.exit(2);
  }
  record("U0.1", "两个安装包都存在", "PASS", `${OLD.split(/[\\/]/).pop()}\n            ${NEW.split(/[\\/]/).pop()}`);

  // ---- clean slate -------------------------------------------------------
  // Uninstall first: re-running the installer over an existing install takes
  // NSIS's update path, which skips the install section entirely.
  const priorDir = installDir();
  if (priorDir) {
    const un = path.join(priorDir, "uninstall.exe");
    if (existsSync(un)) {
      await install(un);
      await sleep(4000);
    }
  }
  ps(`Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'PaperAI\\ai-profiles.json') -Force -EA SilentlyContinue`);
  record(
    "U0.2",
    "清空已有安装与配置",
    "PASS",
    `原安装目录=${priorDir || "(无)"} 配置目录=${existsSync(localDir())}（配置已备份，退出时还原）`
  );

  const defaultReaderBefore = ps(
    `(Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -EA SilentlyContinue).ProgId`
  );

  // ---- install the OLD version -------------------------------------------
  await install(OLD);
  await waitForFile(path.join(installDir(), "PaperAI.exe"));
  const vOld = readInstalledVersion();
  record("U1.1", "安装旧版 0.2.0", vOld !== "(none)" ? "PASS" : "FAIL", `安装目录版本=${vOld}`);

  // Simulate a user who has configured a provider. The key goes into the real
  // Credential Manager (so we can prove it survives) and the profile into the
  // app's own JSON. Both use TEST_PROFILE, and the URL is under `.invalid` — a
  // reserved TLD that cannot resolve — so nothing here can be mistaken for, or
  // collide with, a real configuration.
  const marker = "sk-upgrade-marker-not-a-real-key";
  const profiles = {
    profiles: [
      {
        id: TEST_PROFILE,
        display_name: "升级测试 Provider（临时）",
        base_url: "https://upgrade-test.invalid",
        model: "test-model",
        credential_id: TEST_PROFILE,
        is_default: true,
      },
    ],
  };
  mkdirSync(localDir(), { recursive: true });
  writeFileSync(path.join(localDir(), "ai-profiles.json"), JSON.stringify(profiles, null, 2));
  const keyWrite = ps(
    `
$sig = @"
using System;using System.Runtime.InteropServices;
public class C {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL c, uint f);
}
"@
Add-Type -TypeDefinition $sig
$t = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni('${credTarget(TEST_PROFILE)}')
$u = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni('PaperAI')
$bytes = [Text.Encoding]::UTF8.GetBytes('${marker}')
$blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$c = New-Object C+CREDENTIAL
$c.Type = 1; $c.TargetName = $t; $c.UserName = $u
$c.CredentialBlobSize = $bytes.Length; $c.CredentialBlob = $blob; $c.Persist = 2
'wrote=' + [C]::CredWrite([ref]$c, 0)
`
  );
  record("U1.2", "写入升级前的用户配置（模拟真实用户）", keyWrite.includes("True") ? "PASS" : "PARTIAL",
    `凭据写入=${keyWrite}\n            配置：1 个 Provider，凭据 ${credTarget(TEST_PROFILE)}`);

  const pdfsBefore = ps(
    `(Get-ChildItem 'D:\\AIreader\\PaperAI-PoC\\test-fixtures' -Recurse -Filter *.pdf -EA SilentlyContinue | Measure-Object).Count`
  );
  const fixtureHash = ps(
    `(Get-FileHash 'D:\\AIreader\\PaperAI-PoC\\test-fixtures\\dual\\IEEE 双栏 论文 副本.pdf' -Algorithm SHA256 -EA SilentlyContinue).Hash`
  );

  // ---- install the NEW version over it -----------------------------------
  await install(NEW);
  await sleep(8000);
  const vNew = readInstalledVersion();
  record("U2.1", `覆盖安装 ${NEW_VERSION}`, vNew.includes(NEW_VERSION) ? "PASS" : "FAIL",
    `覆盖前=${vOld} 覆盖后=${vNew}`);

  // ---- settings survive ---------------------------------------------------
  // NOTE: `Get-Content` defaults to the system ANSI codepage (GBK here), which
  // mangles UTF-8 Chinese and produced a false failure. Force UTF8 for both the
  // read and the PowerShell output.
  const cfg = ps(
    `$p = Join-Path $env:LOCALAPPDATA 'PaperAI\\ai-profiles.json'; ` +
      `if (Test-Path $p) { [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) } else { '(missing)' }`
  );
  // ASCII markers prove the file is intact regardless of console encoding; the
  // Chinese check then confirms it is *our* content rather than a stub.
  const cfgKept = cfg.includes("upgrade-test.invalid") && cfg.includes("test-model");
  const cfgIsOurs = cfg.includes("升级测试 Provider");
  record("U2.2", "Provider 设置升级后保留", cfgKept && cfgIsOurs ? "PASS" : "FAIL",
    cfgKept && cfgIsOurs
      ? "ai-profiles.json 仍在，display_name / base_url / model 均未被覆盖"
      : `base_url+model 完整=${cfgKept} 中文 display_name 完整=${cfgIsOurs}`);

  const hasSecret = ps(
    `
$sig2 = @"
using System;using System.Runtime.InteropServices;
public class R {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);
}
"@
Add-Type -TypeDefinition $sig2
$p = [IntPtr]::Zero
$ok = [R]::CredRead('${credTarget(TEST_PROFILE)}', 1, 0, [ref]$p)
if ($ok) { [R]::CredFree($p); 'present' } else { 'absent' }
`
  );
  record("U2.3", "API Key 在凭据管理器中保留", hasSecret === "present" ? "PASS" : "FAIL",
    `CredRead(${credTarget(TEST_PROFILE)}) -> ${hasSecret}`);

  // ---- system state -------------------------------------------------------
  const assoc = ps(
    `$hits=@(); foreach ($root in @('HKCU:\\SOFTWARE\\Classes','HKLM:\\SOFTWARE\\Classes')) { ` +
      `$k = Join-Path $root 'Applications\\PaperAI.exe'; if (Test-Path $k) { $hits += $k } } ; $hits -join ' ;; '`
  );
  record("U2.4", "升级后 .pdf 关联仍在", assoc ? "PASS" : "FAIL", assoc || "未找到");

  const defaultReaderAfter = ps(
    `(Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -EA SilentlyContinue).ProgId`
  );
  record("U2.5", "默认 PDF 阅读器未被改变", defaultReaderAfter === defaultReaderBefore ? "PASS" : "FAIL",
    `升级前=${defaultReaderBefore || "(none)"} 升级后=${defaultReaderAfter || "(none)"}`);

  const pdfsAfter = ps(
    `(Get-ChildItem 'D:\\AIreader\\PaperAI-PoC\\test-fixtures' -Recurse -Filter *.pdf -EA SilentlyContinue | Measure-Object).Count`
  );
  const fixtureHashAfter = ps(
    `(Get-FileHash 'D:\\AIreader\\PaperAI-PoC\\test-fixtures\\dual\\IEEE 双栏 论文 副本.pdf' -Algorithm SHA256 -EA SilentlyContinue).Hash`
  );
  record("U2.6", "用户 PDF 未被安装/升级改动",
    pdfsBefore === pdfsAfter && fixtureHash === fixtureHashAfter ? "PASS" : "FAIL",
    `pdf 文件数 ${pdfsBefore} -> ${pdfsAfter}; 样本 SHA256 ${fixtureHash.slice(0, 12)}… -> ${fixtureHashAfter.slice(0, 12)}…`);

  // ---- the new build actually runs ---------------------------------------
  const exe = path.join(installDir(), "PaperAI.exe");
  const fixture = path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf");
  const child = spawn(exe, [fixture], { stdio: "ignore", detached: true });
  child.unref();
  await sleep(12000);
  const title = ps(
    `$p = Get-Process PaperAI -EA SilentlyContinue | Select-Object -First 1; if ($p) { $p.MainWindowTitle } else { 'NOT RUNNING' }`
  );
  ps(`Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force`);
  record("U2.7", `升级后的 ${NEW_VERSION} 能正常打开 PDF`, /PaperAI — .+\.pdf/.test(title) ? "PASS" : "FAIL",
    `原生窗口标题="${title}"`);

  // ---- leave no trace -----------------------------------------------------
  // The test credential must not outlive the run: leaving it behind would
  // occupy a real Credential Manager slot and, under a colliding name, would
  // have replaced a working key with a marker.
  const cleaned = ps(
    `$sig3 = @"
using System;using System.Runtime.InteropServices;
public class D {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
}
"@
Add-Type -TypeDefinition $sig3
'deleted=' + [D]::CredDelete('${credTarget(TEST_PROFILE)}', 1, 0)
`
  );
  record("U3.1", "测试凭据已清理（不污染用户凭据管理器）", cleaned.includes("True") ? "PASS" : "PARTIAL",
    `${cleaned}  target=${credTarget(TEST_PROFILE)}`);

  // Put the user's own settings back before anything else runs.
  if (realConfigBackup) {
    writeFileSync(REAL_CONFIG, realConfigBackup);
    configRestored = true;
  }
  const restoredNow = ps(
    `$p = Join-Path $env:LOCALAPPDATA 'PaperAI\\ai-profiles.json'; ` +
      `if (Test-Path $p) { [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8) } else { '(missing)' }`
  );
  record(
    "U3.2",
    "用户原有设置已还原",
    realConfigBackup ? (restoredNow.includes("upgrade-test.invalid") ? "FAIL" : "PASS") : "PASS",
    realConfigBackup
      ? `已写回 ${realConfigBackup.length} 字节；文件中不含测试数据=${!restoredNow.includes("upgrade-test.invalid")}`
      : "（运行前本就没有配置文件，无需还原）"
  );

  writeReport();
  const bad = results.filter((r) => r.status !== "PASS").length;
  console.log(`\n${results.length - bad}/${results.length} PASS — evidence in ${path.relative(ROOT, EVIDENCE)}`);
  process.exit(bad ? 1 : 0);
}

function writeReport() {
  const md = [
    `# Windows upgrade path — ${path.basename(OLD)} -> ${path.basename(NEW)}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Old: \`${OLD}\``,
    `New: \`${NEW}\``,
    "",
    "| ID | Check | Result | Notes |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | **${r.status}** | ${String(r.note).replace(/\n/g, " ")} |`),
    "",
  ].join("\n");
  writeFileSync(path.join(EVIDENCE, "upgrade-RESULTS.md"), md, "utf8");
}

main().catch((e) => {
  record("U", "升级测试", "FAIL", String(e).slice(0, 400));
  writeReport();
  process.exit(1);
});
