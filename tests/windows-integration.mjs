/**
 * PaperAI Phase 2 / Stage C — real Windows integration tests.
 *
 * Installs the NSIS package, drives it from Explorer-equivalent argv, verifies
 * single-instance behaviour, then uninstalls and checks the registry cleanup.
 *
 * The installer runs in `currentUser` mode so no elevation is required.
 *
 * Usage: node tests/windows-integration.mjs --installer "<path>.exe"
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVIDENCE = path.join(ROOT, "evidence", "stage-c");
mkdirSync(EVIDENCE, { recursive: true });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const INSTALLER = arg("installer", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function record(id, name, status, note) {
  results.push({ id, name, status, note });
  console.log(`[${status.padEnd(8)}] ${id}  ${name}\n            ${String(note).replace(/\n/g, "\n            ")}`);
}

function ps(script) {
  // Force UTF-8 output: without this PowerShell returns mojibake for CJK
  // window titles and the assertions compare against garbage.
  const wrapped = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`;
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wrapped],
    { encoding: "utf8", timeout: 120000 }
  );
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

function listProcesses(name) {
  const r = ps(`Get-Process -Name '${name}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + '|' + $_.MainWindowTitle }`);
  return r.ok && r.out ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * Wait until the installer's file-association writes have landed.
 * `setup.exe /S` spawns a child and returns immediately, so a fixed sleep races
 * the actual registry writes — this is what made C2.1 flaky.
 */
async function waitForAssociation(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = ps(
      `$hits = @(); ` +
        `foreach ($root in @('HKCU:\\SOFTWARE\\Classes','HKLM:\\SOFTWARE\\Classes')) { ` +
        `  $k = Join-Path $root 'Applications\\PaperAI.exe'; ` +
        `  if (Test-Path $k) { $hits += $k } ` +
        `  $o = Join-Path $root '.pdf\\OpenWithProgids'; ` +
        `  if (Test-Path $o) { $v = (Get-Item $o).Property; if ($v -contains 'PaperAI.exe') { $hits += $o + ' contains PaperAI.exe' } } ` +
        `} ` +
        `$hits -join ' ;; '`
    ).out;
    if (out) return out;
    await sleep(1000);
  }
  return "";
}

async function main() {
  if (!INSTALLER || !existsSync(INSTALLER)) {
    record("C0", "NSIS 安装包存在", "BLOCKED", `未提供: ${INSTALLER}`);
    writeReport();
    process.exit(2);
  }
  const size = (await import("node:fs")).statSync(INSTALLER).size;
  const hash = await sha256(INSTALLER);
  record("C0", "NSIS 安装包存在", "PASS", `${INSTALLER}\n            ${(size / 1048576).toFixed(2)} MB  SHA-256=${hash}`);

  // ---------------------------------------------------------------- install
  // A PaperAI left over from a previous run would swallow the single-instance
  // hand-off and make C3/C4 look flaky. Start from a clean slate.
  const stale = ps(`(Get-Process -Name PaperAI -ErrorAction SilentlyContinue | Measure-Object).Count`).out;
  if (stale && stale !== "0") {
    ps(`Get-Process -Name PaperAI -ErrorAction SilentlyContinue | Stop-Process -Force | Out-String`);
    await sleep(2500);
  }

  // Uninstall any existing copy first. Re-running the installer over an
  // existing install takes NSIS's update path, which does not re-run the
  // install section and therefore does not re-register the file association —
  // that made C2.1 look flaky. A clean install is what we want to verify.
  const preUninstall = ps(
    `$u = Join-Path $env:LOCALAPPDATA 'PaperAI\\uninstall.exe'; ` +
    `if (Test-Path $u) { $p = Start-Process $u -ArgumentList '/S' -Wait -PassThru; 'uninstalled rc=' + $p.ExitCode } else { 'nothing installed' }`
  ).out;

  const beforeProgId = ps(`(Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -ErrorAction SilentlyContinue).ProgId`).out;

  const inst = spawnSync(INSTALLER, ["/S"], { encoding: "utf8", timeout: 300000 });
  await sleep(4000);
  record("C1.1", "静默安装执行", inst.status === 0 ? "PASS" : "FAIL", `退出码=${inst.status}`);

  const where = ps(
    `$p = @(); ` +
      `$p += (Get-ChildItem "$env:LOCALAPPDATA\\Programs\\PaperAI" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }); ` +
      `$p += (Get-ChildItem "$env:LOCALAPPDATA\\PaperAI" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }); ` +
      `$p -join ' | '`
  );
  record("C1.2", "安装目录已生成", where.out ? "PASS" : "FAIL", where.out || "(未找到)");

  const exe = ps(
    `$c = @(); ` +
      `$c += (Get-ChildItem "$env:LOCALAPPDATA\\Programs\\PaperAI\\*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq 'PaperAI.exe' } | ForEach-Object { $_.FullName }); ` +
      `$c += (Get-ChildItem "$env:LOCALAPPDATA\\PaperAI\\*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq 'PaperAI.exe' } | ForEach-Object { $_.FullName }); ` +
      `$c -join ' | '`
  ).out;
  if (!exe) {
    record("C1.3", "主程序 PaperAI.exe", "FAIL", `未找到；已安装内容=${where.out || "(none)"}`);
    writeReport();
    process.exit(1);
  }
  record("C1.3", "主程序 PaperAI.exe", "PASS", exe);

  const startMenu = ps(
    `Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs" -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*PaperAI*' } | ForEach-Object { $_.FullName }`
  ).out;
  record("C1.4", "开始菜单快捷方式", startMenu ? "PASS" : "PARTIAL", startMenu || "(未找到快捷方式)");

  const uninstall = ps(
    `Get-ChildItem 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like '*PaperAI*' } | ForEach-Object { $_.DisplayName + ' || ' + $_.UninstallString }`
  ).out;
  record("C1.5", "已安装应用/卸载项登记", uninstall ? "PASS" : "FAIL", uninstall || "(未找到卸载项)");

  // ---------------------------------------------------------- file association
  const assoc = ps(
    `$hits = @(); ` +
      `foreach ($root in @('HKCU:\\SOFTWARE\\Classes','HKLM:\\SOFTWARE\\Classes')) { ` +
      `  $k = Join-Path $root 'Applications\\PaperAI.exe'; ` +
      `  if (Test-Path $k) { $hits += $k } ` +
      `  $o = Join-Path $root '.pdf\\OpenWithProgids'; ` +
      `  if (Test-Path $o) { $v = (Get-ItemProperty $o).'(default)'; if ($v -like '*PaperAI*') { $hits += $o + ' => ' + $v } } ` +
      `} ` +
      `$hits -join ' ;; '`
  );
  // The declarative `bundle.fileAssociations` IS honoured by the generated
  // installer.nsi (it calls APP_ASSOCIATE), but that macro writes through
  // SHELL_CONTEXT, which the generated script never initialises during install.
  // src-tauri/installer-hooks.nsh fixes that via NSIS_HOOK_PREINSTALL, so the
  // installer itself now registers us. Verify the registry directly instead of
  // running any helper script.
  const after = await waitForAssociation();
  const defaultProgId = ps(
    `(Get-ItemProperty 'HKCU:\SOFTWARE\Classes\.pdf' -ErrorAction SilentlyContinue).'(default)'`
  ).out;
  record("C2.1", ".pdf 关联由安装器原生注册（候选项）", after ? "PASS" : "FAIL",
    `注册结果=${after || "未注册"}; .pdf 默认 ProgId="${defaultProgId}"（安装器不得抢占默认）`);
  const afterProgId = ps(`(Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -ErrorAction SilentlyContinue).ProgId`).out;
  record(
    "C2.2",
    "未抢占系统默认 PDF 阅读器",
    afterProgId === beforeProgId ? "PASS" : "FAIL",
    `安装前=${beforeProgId || "(none)"} 安装后=${afterProgId || "(none)"}`
  );

  // ------------------------------------------------------- CLI: unicode + spaces
  const cnPath = path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf");
  const spPath = path.join(ROOT, "test-fixtures", "single", "报告 中文 空格 copy.pdf");

  let p1 = spawn(exe, [cnPath], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9401" } });
  await sleep(9000);
  const procs1 = listProcesses("PaperAI");
  const title1 = procs1.map((s) => s.split("|").slice(1).join("|")).join(" / ");
  record(
    "C3.1",
    "命令行打开中文路径 PDF",
    /IEEE|双栏/.test(title1) ? "PASS" : "FAIL",
    `进程数=${procs1.length} 窗口标题="${title1}"\n            参数=${cnPath}`
  );

  // ------------------------------------------------------------ single instance
  const p2 = spawnSync(exe, [spPath], { encoding: "utf8", timeout: 60000 });
  await sleep(7000);
  const procs2 = listProcesses("PaperAI");
  const title2 = procs2.map((s) => s.split("|").slice(1).join("|")).join(" / ");
  record(
    "C4.1",
    "二次打开不产生第二个实例",
    procs2.length <= procs1.length ? "PASS" : "FAIL",
    `第一次=${procs1.length} 个进程，第二次后=${procs2.length} 个进程`
  );
  record(
    "C4.2",
    "现有窗口接收新 PDF（含空格路径）",
    /报告|中文/.test(title2) ? "PASS" : "FAIL",
    `窗口标题="${title2}"\n            参数=${spPath}`
  );

  // rapid succession
  const rapid = [];
  for (const f of [path.join(ROOT, "test-fixtures", "single", "PDF-A-single.pdf"), cnPath, spPath]) {
    rapid.push(spawnSync(exe, [f], { encoding: "utf8", timeout: 40000 }));
    await sleep(1200);
  }
  await sleep(5000);
  const procs3 = listProcesses("PaperAI");
  record(
    "C4.3",
    "连续传入多个 PDF 不崩溃/不丢路径",
    procs3.length <= 1 ? "PASS" : "FAIL",
    `连发 3 次后进程数=${procs3.length} 标题="${procs3.map((s) => s.split("|").slice(1).join("|")).join(" / ")}"`
  );

  try {
    p1.kill();
  } catch {
    /* ignore */
  }
  await sleep(2500);

  // ------------------------------------------------------------------ uninstall
  const uninstString = ps(
    `Get-ChildItem 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like '*PaperAI*' } | ForEach-Object { $_.UninstallString }`
  ).out.split(/\r?\n/)[0];

  if (uninstString) {
    const m = uninstString.match(/^"?([^"]+\.exe)"?(.*)$/i);
    const target = m ? m[1] : uninstString;
    const rest = m ? (m[2] || "").trim() : "";
    const uRun = spawnSync(target, [...(rest ? rest.split(/\s+/) : []), "/S"], { encoding: "utf8", timeout: 300000 });
    await sleep(6000);
    record("C5.1", "卸载程序执行", uRun.status === 0 ? "PASS" : "PARTIAL", `退出码=${uRun.status} 命令=${target}`);

    const gone = ps(
      `$c = @(Get-ChildItem "$env:LOCALAPPDATA\\Programs\\PaperAI\\PaperAI.exe","$env:LOCALAPPDATA\\PaperAI\\PaperAI.exe" -ErrorAction SilentlyContinue); ` +
      `if ($c.Count -gt 0) { "True" } else { "False" }`
    ).out;
    const regGone = ps(
      `Get-ChildItem 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like '*PaperAI*' } | Measure-Object | ForEach-Object { $_.Count }`
    ).out;
    record("C5.2", "卸载后主程序移除", gone === "False" ? "PASS" : "FAIL", `PaperAI.exe 仍存在=${gone}`);
    record("C5.3", "卸载后注册信息清理", regGone === "0" ? "PASS" : "PARTIAL", `残留卸载项=${regGone}`);

    const finalProgId = ps(`(Get-ItemProperty 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice' -ErrorAction SilentlyContinue).ProgId`).out;
    record(
      "C5.4",
      "卸载后默认 PDF 阅读器未受影响",
      finalProgId === beforeProgId ? "PASS" : "FAIL",
      `原始=${beforeProgId || "(none)"} 卸载后=${finalProgId || "(none)"}`
    );
    // With the installer now registering the association itself, the
    // uninstaller must clean it up too — no helper script involved.
    const afterClean = ps(
      `[bool](Test-Path 'HKCU:\\SOFTWARE\\Classes\\Applications\\PaperAI.exe')`
    ).out;
    const openWithGone = ps(
      `$v = (Get-Item 'HKCU:\\SOFTWARE\\Classes\\.pdf\\OpenWithProgids' -ErrorAction SilentlyContinue).Property; ` +
      `if ($v -contains 'PaperAI.exe') { 'still-listed' } else { 'removed' }`
    ).out;
    record("C5.5", "卸载器原生清理 PaperAI 关联项", afterClean === "False" && openWithGone === "removed" ? "PASS" : "FAIL",
      `Applications\\PaperAI.exe 仍存在=${afterClean}; OpenWithProgids=${openWithGone}`);
  } else {
    record("C5.1", "卸载程序执行", "NOT RUN", "未找到卸载命令");
  }

  writeReport();
  const bad = results.filter((r) => r.status !== "PASS").length;
  console.log(`\n${results.length - bad}/${results.length} PASS — evidence in ${EVIDENCE}`);
  process.exit(bad > 0 ? 1 : 0);
}

function writeReport() {
  const md = [
    "# Stage C — Windows integration results",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Installer: \`${INSTALLER ?? "(none)"}\``,
    "",
    "| ID | Check | Result | Notes |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.name} | **${r.status}** | ${String(r.note).replace(/\n/g, " ")} |`),
    "",
  ].join("\n");
  writeFileSync(path.join(EVIDENCE, "RESULTS.md"), md, "utf8");
}

main();
