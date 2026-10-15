# Stage C — NSIS install, file association, CLI paths, single instance

Raw log: `evidence/stage-c/windows-integration.log`,
table: `evidence/stage-c/RESULTS.md`,
registry dumps: `evidence/stage-c/assoc-dump.txt`, `assoc-detail.txt`.

## Result: 17 / 17 PASS

| ID | Check | Result | Notes |
|---|---|---|---|
| C0 | NSIS 安装包存在 | PASS | 3.67 MB, SHA-256 `c29f9dae…` |
| C1.1 | 静默安装 (`/S`) | PASS | exit 0 |
| C1.2 | 安装目录已生成 | PASS | `%LOCALAPPDATA%\PaperAI\` |
| C1.3 | 主程序 `PaperAI.exe` | PASS | `…\PaperAI\PaperAI.exe` |
| C1.4 | 开始菜单快捷方式 | PASS | `%APPDATA%\…\Start Menu\Programs\PaperAI.lnk` |
| C1.5 | 已安装应用 / 卸载项登记 | PASS | `DisplayName = PaperAI` |
| C2.1 | `.pdf` 关联注册（候选项） | PASS | 见下方「关联是脚本注册的」 |
| C2.2 | 未抢占系统默认 PDF 阅读器 | PASS | 安装前后 `UserChoice` 均为 `MSEdgePDF` |
| C3.1 | 命令行打开中文路径 PDF | PASS | 标题 `PaperAI — IEEE 双栏 论文 副本.pdf` |
| C4.1 | 二次打开不产生第二个实例 | PASS | 始终 1 个进程 |
| C4.2 | 现有窗口接收新 PDF（含空格路径） | PASS | 标题变为 `PaperAI — 报告 中文 空格 copy.pdf` |
| C4.3 | 连续传入 3 个 PDF | PASS | 不崩溃、不多开、标题跟随最新 |
| C5.1 | 卸载程序执行 | PASS | exit 0 |
| C5.2 | 卸载后主程序移除 | PASS | — |
| C5.3 | 卸载后注册信息清理 | PASS | 卸载项 0 |
| C5.4 | 卸载后默认 PDF 阅读器未受影响 | PASS | 仍为 `MSEdgePDF` |
| C5.5 | PaperAI 关联项清理 | PASS | 运行 `-Unregister` 后清除 |

Evidence for C3/C4 is deliberately **native**: the frontend mirrors the open
document into the OS window title (`src/main.ts` → `syncTitle`), and the test
reads `MainWindowTitle` from outside the process. That proves which file the
installed binary is really showing without trusting in-process state.

Rust writes an audit line to `%LOCALAPPDATA%\PaperAI\paperai.log` recording the
raw `argv` it received and any path it rejected — release builds are GUI-subsystem
so `println!` is invisible.

---

## Finding: the declarative file association did not register

`bundle.fileAssociations` is present in `src-tauri/tauri.conf.json`:

```json
"fileAssociations": [{ "ext": ["pdf"], "name": "PDF Document", "role": "Viewer" }]
```

After a silent `currentUser` install, **nothing** was written:

```
HKCU\SOFTWARE\Classes\Applications\PaperAI.exe   -> 不存在
HKCU\SOFTWARE\Classes\.pdf\OpenWithProgids       -> 只有 KWPS.PDF.9, workbuddyai.pdf
HKLM\SOFTWARE\Classes\Applications\PaperAI.exe   -> 不存在
```

(`evidence/stage-c/assoc-detail.txt`.)

Things that were tried and did **not** change it:

* `role: "Viewer"` — the config reference shows `BundleTypeRole` values map to
  `CFBundleTypeRole`, which is **macOS-only**. It has no effect on Windows.
* `bundle.windows.nsis.hooks` — rejected by the config schema in 2.12.3.
* `bundle.windows.nsis.installerHooks` — accepted by the schema, but the
  generated installer still wrote nothing.

**What ships instead:** `scripts/register-file-association.ps1`, which writes the
same entries by hand (and has `-Unregister`). It is invoked by the test suite and
its result is asserted, so the end state is verified rather than assumed.

The user-visible consequence today: after installing, run

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-file-association.ps1
```

and PaperAI appears under **right-click → Open with**. It is a *candidate*; the
script never touches `…\FileExts\.pdf\UserChoice`.

**Still open:** whether Tauri's built-in registration works with
`installMode: "perMachine"` was not tested — that needs an elevated install and
would move the app to `Program Files`. Recorded as a known issue.

## Single instance

`tauri-plugin-single-instance` 2.5.3, registered before the other plugins. On a
second launch the callback:

1. parses `argv` (paths validated by `resolve_pdf_path`: exists, is a file,
   `%PDF-` magic, ≤ 512 MB),
2. pushes them into a `PendingFiles` mutex **and** emits
   `paperai://open-files`,
3. `unminimize()` + `show()` + `set_focus()` on the `main` window.

The queue exists because the event can fire before the WebView finishes booting;
the frontend drains it with `take_pending_files` once ready and again on every
hand-off. This is what makes C4.3 (three files in a row) pass instead of racing.

Focus-stealing on Windows is best-effort — the window is restored and asked to
focus, but Windows may refuse if the foreground process owns focus. **Not
verified** in this environment (no interactive desktop); recorded honestly.

## Dirty-document protection on hand-off

Opening a second file goes through `guardedOpen`, which shows the three-way
保存 / 不保存 / 取消 prompt when `dirty` is true, and genuinely aborts on 取消.
The prompt is an in-app modal (`#dirty-modal`) because the dialog plugin only
offers ok/cancel.
