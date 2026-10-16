# S0 — 环境核对、版本快照、Git 基线

日期：2026-10-15 · 工程：`%PROJECT_PARENT%\PaperAI-PoC` · 本轮目标版本：`0.3.0`

---

## 1. Git 状态

| 项 | 值 |
|---|---|
| 当前分支 | `phase2` |
| 工作树 | **干净**（`git status --short` 无输出） |
| HEAD | `de3e62d` — verify: cross-reader annotation evidence, retract bogus K-04 |
| 上一提交 | `82b987f` — Phase 2 wrap-up: clear both blockers |
| 本轮分支 | `ai-integration`（在干净树上创建，见 §4） |

未覆盖任何用户改动：工作树在开始前即干净，所有既有 `output/`、安装包与
`test-fixtures/` 原样保留。

## 2. 工具链与版本（实测）

| 组件 | 版本 | 来源 |
|---|---|---|
| Rust / cargo / rustup | 1.99.0 / 1.99.0 / 1.29.1 | `rustc --version` |
| MSVC `cl.exe` | 19.44.35229 (v143) | `%BUILD_ROOT%\VS2022BT` |
| Windows SDK | 10.0.26100.0 | `C:\Program Files (x86)\Windows Kits\10` |
| Node / npm | v22.22.2 / 10.9.7 | — |
| Tauri CLI / tauri / tauri-build | 2.12.2 / 2.12.3 / 2.7.2 | `package.json` / `Cargo.toml` |
| @tauri-apps/api | 2.12.3 | `package.json` |
| **pdfjs-dist** | **6.4.299（精确锁定，无 `^`/`~`）** | `package.json` + `node_modules` 实测 |
| WebView2 Runtime | 155.0.4283.45 | `HKLM\...\EdgeUpdate\Clients\{F3017226-…}` |
| Microsoft Edge | 155.0.4283.45 | `msedge.exe` |
| WPS Office | 12.1.0.28505 | 第三方阅读器（独立引擎） |
| Acrobat Reader | **未安装** | — |

当前 `tauri.conf.json`：`version 0.2.0`、`productName PaperAI`、
`mainBinaryName PaperAI`、`fileAssociations: null`（关联由
`installer-hooks.nsh` 负责）、`installerHooks: installer-hooks.nsh`。

## 3. 基线构建与测试现状

| 步骤 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `npm ci` | **PASS** |
| 类型检查 | `npx tsc --noEmit` | **PASS**（0 错误） |
| 前端构建 | `npx vite build` | **PASS**（`index-DVF4JdAj.js` 457.34 kB） |
| Rust 检查 | `cargo check` | **PASS**（0 错误） |
| Phase-2 回归 | `tests/desktop-verify.mjs` 等 | **BLOCKED** — 见 §4 |

### 4. K-13 根因已定位（本轮新结论）

前一轮只记录了"`--remote-debugging-port` 失效，原因不明"。本轮做了三级实验，
根因现在完全清楚：

**实验 A — Edge 本身能否开调试端口？**（`scripts/probe-cdp-rootcause.mjs`）

| 场景 | 结果 |
|---|---|
| Edge + **全新** `--user-data-dir` + `--remote-debugging-port=9600` | **1.5 秒即通**，`Edg/155.0.4283.45` |
| Edge + **默认** user-data-dir + `--remote-debugging-port=9601` | 15 秒仍不通 |

→ Chromium 136+ 的安全加固：**使用默认用户数据目录时忽略 `--remote-debugging-port`**。

**实验 B — WebView2 能否用同样办法救活？**（`scripts/probe-cdp-fix.mjs`）

| 场景 | 结果 |
|---|---|
| 仅 `--remote-debugging-port` | DOWN |
| `--remote-debugging-port` + 全新 `--user-data-dir` | DOWN |
| 上述 + 反节流参数 | DOWN |

**实验 C — 参数到底有没有到子进程？**（`scripts/probe-wv2-cmdline.mjs`，决定性）

对全部 24 个 `msedgewebview2.exe` 抓 `Win32_Process.CommandLine`：

```
--remote-debugging-port            : no      ← 被剥离
--user-data-dir                    : YES，但值是
     %USERPROFILE%\AppData\Local\com.paperai.desktop\EBWebView   ← 被 WebView2 覆盖
--disable-renderer-backgrounding   : no      ← 同样被剥离
```

**实验 D — 换管道？**（`scripts/probe-wv2-pipe.mjs`）
`--remote-debugging-pipe` 同样被剥离；464 个命名管道中无 devtools 管道。

### 结论

> **WebView2 不通过 `additionalBrowserArguments` 暴露 CDP。** 它剥离
> `--remote-debugging-port` / `--remote-debugging-pipe`，并把 `--user-data-dir`
> 强制改为自己的 `EBWebView` 目录。这与 Chromium 对默认 profile 的限制叠加，
> 导致前一轮所有 WebView2 CDP 尝试必然失败——不是时序竞争、不是进程泄漏、
> 不是策略注册表（已查 `HKLM/HKCU\SOFTWARE\Policies\Microsoft\Edge`，均为空）。

**影响与处置**：真实 WebView2 上的 CDP 自动化在本机不可实现 → 按任务书 §8.2
标记自动化 `BLOCKED`，改用下列**可复跑、OS 层可核查**的替代路径：

| 替代手段 | 用途 | 脚本 |
|---|---|---|
| 原生窗口标题 | 证明"哪个文件真的被打开了" | `tests/windows-integration.mjs` C3/C4 |
| `PrintWindow(PW_RENDERFULLCONTENT)` | GUI 截图（GDI/CDP 在此环境均不可用） | `tests/wps-capture.mjs`、`tests/printwindow-capture.mjs` |
| 纯 Node 读回 | 批注几何与覆盖文字，不经浏览器 | `tests/readback-annotations.mjs` |
| 像素级检测 | 高亮/墨迹是否真的渲染出来了 | `tools/detect_annotations.py`、`tools/count_highlights.py` |
| 纯函数单测 | AI 上下文构建 / prompt / SSE 解析 | `tests/ai-unit/`（本轮新增） |
| 本地 Mock SSE | 端到端 Provider 行为 | `tests/ai-mock/`（本轮新增） |

明确**不**做：用 `npm run dev` 或 headless Edge 冒充桌面回归。

### 5. 进程泄漏（K-14）复核

前一轮泄漏过 30 个 `msedgewebview2.exe`。本轮所有探针脚本都在 `finally` 中
按 PID 回收自己启动的进程；需要全局清理时单独说明影响，不再一把
`Stop-Process msedgewebview2 -Force` 扫掉用户其他应用的 WebView。

## 6. 既有源码审查结论

| 文件 | 结论 |
|---|---|
| `src-tauri/src/lib.rs` | 单实例 / pending-files / audit log 清晰，命令表集中，可直接扩展 |
| `src-tauri/src/commands.rs` | 最小权限 IPC，**无**任何返回 API Key 的路径 —— AI 凭据必须延续这一形状 |
| `src-tauri/src/save_service.rs` | 唯一写入口，temp→verify→backup→双 rename→cleanup；K-07 恢复机制加在这里 |
| `src-tauri/src/paths.rs` | argv 校验（`%PDF-` 魔数、512 MB 上限、canonicalize、去 `\\?\`） |
| `src/bridge.ts` | 前端唯一 IPC 出口，类型齐全；AI 调用沿用 |
| `src/main.ts` | shell 层：工具栏 / dirty 策略 / guarded open-save |
| `src/pdf/pdfjs-adapter.ts` | 所有 PDF.js 版本脆弱调用集中在此；选区快照加在这里 |
| `src-tauri/installer-hooks.nsh` | `.pdf` 候选注册（不抢默认）+ 卸载清理，**必须保留** |

`src/ai/` 与 `src-tauri/src/ai/` 当前不存在，本轮新建。

## 7. 进入 S1 的条件

满足：原工程可读、可编译、有干净回退点（`de3e62d`）、版本锁确认、
K-13 根因已明确且替代验证路径已定义。

证据目录：`evidence/ai-s0/`（版本快照、构建日志、K-13 四级实验输出）。
