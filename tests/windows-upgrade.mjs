/**
 * Upgrade-path verification: 0.2.0 -> 0.3.0.
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
 *          --old "<0.2.0 setup.exe>" --new "<0.3.0 setup.exe>"
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVIDENCE = path.join(ROOT, "evidence", "windows-release");
mkdirSync(EVIDENCE, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const OLD = arg("old", path.join(ROOT, "dist", "installer", "PaperAI_0.2.0_x64-setup.exe"));
const NEW = arg("new", path.join(ROOT, "dist", "installer", "PaperAI_0.3.0_x64-setup.exe"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(id, name, status, note) {
  results.push({ id, name, status, note });
  console.log(`[${status.padEnd(8)}] ${id}  ${name}\n            ${String(note).replace(/\n/g, "\n            ")}`);
}

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

function readInstalledVersion() {
  return ps(
    `$p = Join-Path $env:LOCALAPPDATA 'PaperAI\\PaperAI.exe'; ` +
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
  const un = path.join(localDir(), "uninstall.exe");
  if (existsSync(un)) {
    await install(un);
    await sleep(4000);
  }
  ps(`Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'PaperAI\\ai-profiles.json') -Force -EA SilentlyContinue`);
  record("U0.2", "清空已有安装与配置", "PASS", `install dir exists=${existsSync(localDir())}`);

  const defaultReaderBefore = ps(
    `(Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -EA SilentlyContinue).ProgId`
  );

  // ---- install the OLD version -------------------------------------------
  await install(OLD);
  await waitForFile(path.join(localDir(), "PaperAI.exe"));
  const vOld = readInstalledVersion();
  record("U1.1", "安装旧版 0.2.0", vOld !== "(none)" ? "PASS" : "FAIL", `安装目录版本=${vOld}`);

  // Simulate a user who has configured a provider. The key goes into the real
  // Credential Manager (so we can prove it survives) and the profile into the
  // app's own JSON. The key value is a throwaway marker, not a real secret.
  const marker = "sk-upgrade-marker-not-a-real-key";
  const profiles = {
    profiles: [
      {
        id: "deepseek",
        display_name: "DeepSeek（升级前配置）",
        base_url: "https://api.deepseek.com",
        model: "deepseek-chat",
        credential_id: "deepseek",
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
$t = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni('PaperAI/AIProvider/deepseek')
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
    `凭据写入=${keyWrite}\n            配置：1 个 Provider「DeepSeek（升级前配置）」`);

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
  record("U2.1", "覆盖安装 0.3.0", vNew.includes("0.3") ? "PASS" : "FAIL",
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
  const cfgKept = cfg.includes("api.deepseek.com") && cfg.includes("deepseek-chat");
  const cfgIsOurs = cfg.includes("升级前配置");
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
$ok = [R]::CredRead('PaperAI/AIProvider/deepseek', 1, 0, [ref]$p)
if ($ok) { [R]::CredFree($p); 'present' } else { 'absent' }
`
  );
  record("U2.3", "API Key 在凭据管理器中保留", hasSecret === "present" ? "PASS" : "FAIL",
    `CredRead(PaperAI/AIProvider/deepseek) -> ${hasSecret}`);

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
  const exe = path.join(localDir(), "PaperAI.exe");
  const fixture = path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf");
  const child = spawn(exe, [fixture], { stdio: "ignore", detached: true });
  child.unref();
  await sleep(12000);
  const title = ps(
    `$p = Get-Process PaperAI -EA SilentlyContinue | Select-Object -First 1; if ($p) { $p.MainWindowTitle } else { 'NOT RUNNING' }`
  );
  ps(`Get-Process PaperAI -EA SilentlyContinue | Stop-Process -Force`);
  record("U2.7", "升级后的 0.3.0 能正常打开 PDF", /PaperAI — .+\.pdf/.test(title) ? "PASS" : "FAIL",
    `原生窗口标题="${title}"`);

  writeReport();
  const bad = results.filter((r) => r.status !== "PASS").length;
  console.log(`\n${results.length - bad}/${results.length} PASS — evidence in ${path.relative(ROOT, EVIDENCE)}`);
  process.exit(bad ? 1 : 0);
}

function writeReport() {
  const md = [
    "# Windows upgrade path — 0.2.0 -> 0.3.0",
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
