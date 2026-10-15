// Native-signal probe: does the real app actually load a PDF?
// The frontend mirrors the open document into the native window title
// (src/main.ts syncTitle), so MainWindowTitle is an observable, no CDP needed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EXE = "D:\\PaperAI-Build\\target\\release\\paperai.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function titles() {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `Get-Process -Name PaperAI -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + ' :: ' + $_.MainWindowTitle + ' :: responding=' + $_.Responding + ' :: cpu=' + [math]::Round($_.CPU,1) }`],
    { encoding: "utf8" }
  );
  return (r.stdout || "").trim();
}

const cases = [
  { label: "no args", file: null },
  { label: "CJK path", file: path.join(ROOT, "test-fixtures", "dual", "IEEE 双栏 论文 副本.pdf") },
  { label: "spaces path", file: path.join(ROOT, "test-fixtures", "single", "报告 中文 空格 copy.pdf") },
];

for (const c of cases) {
  const args = c.file ? [c.file] : [];
  if (c.file && !existsSync(c.file)) { console.log(`${c.label}: FIXTURE MISSING`); continue; }
  const child = spawn(EXE, args, { stdio: "ignore" });
  await sleep(12000);
  console.log(`--- ${c.label} ---`);
  console.log(titles() || "(no PaperAI process)");
  try { child.kill(); } catch {}
  await sleep(3000);
}
