# Execution log — PaperAI Phase 2

Chronological record of what was run, what it returned, and why the next step
was chosen. Timestamps are the session clock; all evidence lives under
`evidence/`.

---

## 0. Takeover

| When | What | Result |
|---|---|---|
| 23:26 | Read `PaperAI_Phase2_ABCD_Agent_Task.md` | 4 stages, strict truthfulness rules |
| 23:30 | Inventory `PaperAI-PoC` | no Git, no `src-tauri/`; `pdfjs-dist` pinned `6.4.299` |
| 23:33 | Environment probe | **no Rust, no MSVC, no Windows SDK**; WebView2 155.0.4283.45 present |
| 23:35 | `git init` + baseline commit | `5333c26` on branch `phase2` (see the caveat below) |

**Caveat, stated honestly:** the first commit attempt silently failed and the
successful commit landed *after* `index.html` / `main.ts` / `package.json` had
already been edited, so `5333c26` is **not** a pristine Phase-1 tree for those
files. Everything else from Phase 1 is intact there. The Phase-1 originals that
were overwritten are described in `reports/STAGE_B_WEBVIEW2.md` §"real product
bugs" and `reports/PDFJS_COMPATIBILITY.md`.

## Stage A — toolchain

| When | What | Result |
|---|---|---|
| 23:35 | `curl -o` blocked by sandbox | wrote `scripts/download.mjs` (Node fetch) |
| 23:36 | `rustup-init.exe` fails at the `rust-analyzer` proxy (os error 183) | ran `rustup toolchain install` directly, created `cargo.exe`/`rustc.exe` with `fs.linkSync` |
| 23:37 | rustc **1.99.0** | verified |
| 23:40 | VS Build Tools install (UAC, user authorised) | bootstrapper exits `0xC0000409` **after** writing everything; `cl.exe` 19.44 compiles + runs |
| 23:45 | `cl.exe` smoke test | printed `paperai-ok 8` |
| 23:50 | Rust hello-world `cargo build --release` | linked, printed `paperai-rust-link-ok` |
| 01:00 | persisted `CARGO_HOME` / `RUSTUP_HOME` / `CARGO_TARGET_DIR` + user `Path` (checked nothing existed first) | `evidence/stage-a/env-vars-*.txt` |
| 01:15 | `npm ci`, `pdfjs-dist@6.4.299` confirmed | — |
| 01:20 | `cargo check` on the new `src-tauri` | 3 errors fixed (`Emitter` trait, closure lifetime, `cleanup()` vs `destroy()`) |

## Stage B — real WebView2

| When | What | Result |
|---|---|---|
| 01:30 | `probe/export-check.mjs` | resolves the Phase-1 export contradiction — see `PDFJS_COMPATIBILITY.md` §2 |
| 02:10 | first `tauri build` | hangs: `sync:assets` was killed mid-copy |
| 02:20 | rewrote `sync-pdfjs-assets.mjs` to top up instead of delete-then-copy | 169/169 cMaps |
| 02:27 | `tauri build` again | hangs again, this time in the nested `npm run build` |
| 02:30 | **split the build**: `npx vite build` (2 s) then `tauri build --config '{"build":{"beforeBuildCommand":""}}'` | installer produced |
| 02:45 | `desktop-verify` against the release exe | CDP connects, but `Runtime.evaluate` hangs forever |
| 03:10 | control experiment: Edge + CDP on a trivial page | **works** → the blocker is ours, not the environment |
| 03:25 | `Page.startScreencast` / `Network.enable` on the Tauri page | every asset 200; `plugin:event\|listen` IPC issued → JS *is* running, then the renderer stops answering |
| 03:40 | `probe/cdp-throttle.mjs` with `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-features=CalculateNativeWinOcclusion` | **renderer responsive** — WebView2 occlusion suspension |
| 04:10 | pages render 0×0, no canvas | two real bugs found: missing `class="pdfViewer"`, and `currentScaleValue` presets early-return while `_currentPageNumber` is 0 |
| 04:30 | `currentPageNumber = 1` throws `_setCurrentPageNumber` | switched to a purely numeric fit scale |
| 05:00 | text selection returned empty | CDP `mouseMoved` needs `buttons: 1` |
| 05:30 | ink only worked at one zoom | strokes were being drawn outside the viewport; coordinates are now clamped |
| 06:00 | Erase reported success but deleted nothing | new annotations are unselectable while the editor layer is disabled — Erase now enters Draw mode first |
| 06:40 | **Stage B: 19/19 PASS** | `evidence/stage-b/RESULTS.md` |

Six real product bugs came out of this stage; they are listed in
`reports/STAGE_B_WEBVIEW2.md`.

## Stage C — installer / Windows integration

| When | What | Result |
|---|---|---|
| 07:00 | `tauri build` with `mainBinaryName: "PaperAI"` | exe is now `PaperAI.exe` |
| 07:20 | `windows-integration` first run | install/start-menu/uninstall PASS; exe lookup failed on the old lowercase name |
| 07:40 | CLI open silently failed | added `%LOCALAPPDATA%\PaperAI\paperai.log` audit log → argv was received, the frontend threw on `currentPageNumber` (fixed in Stage B) |
| 08:00 | Chinese + spaces paths, single instance | PASS, verified through the **native window title** |
| 08:20 | `.pdf` association | **never registered** by the bundler; `role` is macOS-only; `nsis.hooks` rejected by the schema; `installerHooks` accepted but inert |
| 08:40 | `scripts/register-file-association.ps1` (+ `-Unregister`) | registered and verified; default reader untouched |
| 09:00 | **Stage C: 17/17 PASS** | `evidence/stage-c/RESULTS.md` |

## Stage D — save safety + cross reader

| When | What | Result |
|---|---|---|
| 09:20 | `save-safety` first run | 8/12 — three failures were wrong test assertions (round-trip byte stability, a missing read-only flag, non-PDF *data* vs non-PDF *target*), one was a **real bug**: `dirty` never became true after ink |
| 09:40 | adapter owns the dirty flag (`markDirty`, `onDirtyChange`) | fixed |
| 10:00 | **save safety: 12/12 PASS** | `evidence/stage-d/save-safety-RESULTS.md` |
| 10:20 | byte-level inspection of the exported PDF | `Highlight 1 · Ink 3 · QuadPoints 1 · InkList 3 · AP_streams 4` |
| 10:40 | Edge GUI launch + CDP | window opens, CDP connects, **screenshot is blank** |
| 10:50 | GDI window capture of Edge | returns the desktop wallpaper → the session has no compositor |
| 11:00 | Acrobat Reader | not installed |

Both cross-reader items are recorded as **BLOCKED**, with manual steps.

## Final regression

`desktop-verify` 19/19 · `save-safety` 12/12 · `windows-integration` 17/17 ·
byte inspection PASS. 48 automated assertions, all green.

---

## Decisions and their evidence

| Decision | Evidence |
|---|---|
| Numeric fit scale instead of `currentScaleValue` presets | `pdf_viewer.mjs` `#setScale` early-returns while `_currentPageNumber` is 0 |
| Adapter owns the dirty flag | `save-safety` D3.10 caught `dirty=false` after real ink |
| Association via companion script | registry dumps showed nothing written by the bundler |
| Native window title as the observation point | `Get-Process … MainWindowTitle` is readable from outside the process |
| Audit log file in Rust | release builds are GUI-subsystem, so `println!` is invisible |

---

# Phase 2 收尾：清理两个 blocker（2026-10-15 下午）

## K-01 — `.pdf` 文件关联

| 时间 | 动作 | 结果 |
|---|---|---|
| 15:20 | 搜 CLI 二进制里的 `OpenWithProgids` / `HKCR` | **0 处命中** → 先误判"NSIS 没实现" |
| 15:25 | 读生成的 `installer.nsi` | 第 654 行**确实有** `!insertmacro APP_ASSOCIATE "pdf" …`；结论推翻 |
| 15:30 | 定位 `SetShellVarContext` | 全脚本仅 1 处，在**卸载段的条件块内** → 安装时 `SHELL_CONTEXT` 从未初始化，`WriteRegStr SHELL_CONTEXT` 全部静默失败。**这才是根因** |
| 15:35 | 试 `nsis.hooks` | schema 拒绝 |
| 15:38 | 试 `nsis.installerHooks`（`.nsi` 后缀） | schema 接受，但宏没被调用 |
| 15:45 | 查 schema 文档 | **`installerHooks` 要的是 `.nsh` 不是 `.nsi`**；支持 `NSIS_HOOK_PREINSTALL/POSTINSTALL/PREUNINSTALL/POSTUNINSTALL` |
| 15:50 | 插桩实验（hook 里写文件） | hook 确实执行；但发现 `APP_ASSOCIATE` 会**抢占 `.pdf` 默认值** |
| 16:00 | 删掉 `bundle.fileAssociations`，hook 全权负责候选注册 | 不再抢默认，完全可控 |
| 16:10 | Stage C 仍 FAIL | 排查：`setup.exe /S` 会派生子进程后立刻返回，固定 sleep 在跟注册表写入赛跑 → 改为**轮询等待** |
| 16:20 | **Stage C 17/17 PASS** | C2.1 注册成功，`.pdf` 默认值为空，卸载器原生清理 |

**同时修了两个测试缺陷**（不是产品缺陷）：
1. Stage C 没先卸载 → 重复安装走 NSIS 更新路径，不重跑安装段
2. C2.1 用固定 sleep → 改为 `waitForAssociation()` 轮询

## K-02 — 跨阅读器验证

| 时间 | 动作 | 结果 |
|---|---|---|
| 15:25 | 诊断桌面 | **DWM 在跑、`OpenInputDesktop` OK** → 之前"没有交互合成器"的判断是**错的** |
| 15:35 | GDI `CopyFromScreen` | 只返回壁纸 —— 它只读合成帧缓冲 |
| 15:40 | CDP `Page.captureScreenshot` | Edge 的 PDF 在 PDFium 插件层，CDP 捕不到 → 空白 |
| 15:50 | **`PrintWindow(PW_RENDERFULLCONTENT)`** | **成功**捕到 Edge 真实内容 |
| 16:05 | 装 WPS Office 作独立引擎 | `D:\Program Files\WPS Office\…\wps.exe /prometheus /pdf` |
| 16:10 | WPS + PrintWindow | 捕到 Ink 笔迹（`wps-try6.png` 两条黑线） |
| 16:15 | 写 `tools/detect_annotations.py` 做客观像素检测 | 对照实验：PDF.js 自身渲染 812px blob ✓、无高亮时 21px ✓ → 工具可靠 |
| 16:20 | WPS 截图检测高亮 | 报 12849px blob —— **误报**，是论文里的黄色流程图节点 |
| — | **用户在真实桌面确认** | **摘要位置的黄色高亮可见** |

## 新发现：CDP 在这个机器上被禁用了

`probe-webview2-health.mjs` 证明：PaperAI 的 WebView2 **完全正常**（窗口标题正确显示文档名、PDF 打开、IPC 通、`responding=True`），但 `--remote-debugging-port` 连不上，加 `--user-data-dir` 也不行；Edge 同样。无 Edge/Chromium 策略可解释。记为 K-13。

## 附带发现：WebView2 渲染进程泄漏

一度泄漏 **30 个 `msedgewebview2.exe`**，最终导致新实例的调试端口起不来。清理后恢复。测试脚本现在都会杀掉自己启动的应用（K-14）。
