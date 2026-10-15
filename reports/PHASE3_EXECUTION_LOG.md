# Phase 3 execution log — AI integration

Chronological record of what was run, what it returned, and why the next step
followed. Timestamps are session time; evidence lives under `evidence/`.

Branches: `phase2` (frozen at `de3e62d`) → **`ai-integration`**.

---

## S0 — baseline and the K-13 investigation

| Step | Result |
|---|---|
| `git status` | clean at `de3e62d`; nothing to stash, no user work at risk |
| `npm ci` / `tsc --noEmit` / `vite build` / `cargo check` | all **PASS** before any edit |
| `pdfjs-dist` | **6.4.299** exact, confirmed from `node_modules`, not just `package.json` |
| Branch `ai-integration` created | `5c199a7` |

### K-13: four experiments

Previous rounds recorded "`--remote-debugging-port` stopped working, cause
unknown". Four experiments settled it:

| # | Experiment | Result |
|---|---|---|
| A | Edge + **fresh** `--user-data-dir` | debug port **up in 1.5 s** |
| A' | Edge + **default** profile | **never up** |
| B | WebView2 + port + fresh dir + anti-throttle | still **down** |
| C | `Win32_Process.CommandLine` for all 24 `msedgewebview2.exe` | `--remote-debugging-port` **stripped**, `--user-data-dir` **overridden** to `com.paperai.desktop\EBWebView`, anti-throttle flags also stripped |
| D | `--remote-debugging-pipe` | stripped; no devtools pipe among 464 |

**Conclusion:** WebView2 does not expose CDP through
`additionalBrowserArguments`. The earlier attempts were not failing for the
reasons assumed (not throttling, not leaked processes, not policy — the policy
keys are empty). Recorded in `AI_S0_BASELINE.md` §4 with the raw output.

Consequence: automation against the real WebView2 is `BLOCKED`, and the round
uses OS-level evidence plus pure-function tests instead.

---

## S1 — provider layer

Built `src-tauri/src/ai/` in one pass, then let the tests find the problems.

| Step | Result |
|---|---|
| `cargo check` | 10 errors on first try: `pub use types::*` missing from `mod.rs`; `CRED_FLAGS`/`HRESULT` type mismatches against the `windows` crate |
| `cargo test --lib` | 30/32 → two failures, both my own assertions (f32→f64 precision; `has_key` matching a naive `key"` substring) |
| Mock SSE server written | `tests/ai-mock/server.mjs`, 16 scenarios, redacts `Authorization` before recording |
| First e2e run | **3/20**, mock saw **0 requests** |
| Diagnosis | the runner used `spawnSync`, which **blocks the Node event loop** — and the mock lives in that same process, so it could never accept a connection. 17 of the failures were manufactured by the harness. |
| Fixed to async `spawn` | **19/20** |
| Last failure | `ai_no_key` surfaced as `ai_secret_store`: `secrets.rs` compared an `HRESULT` against a raw Win32 code (`ERROR_NOT_FOUND` = 1168). The `windows` crate encodes it as `0x8007_0468`. |
| Fixed the comparison | **20/20 PASS** |

Committed as `34bbd20`.

---

## S2 — credentials and settings

Rust side done with S1: `secrets.rs` (Credential Manager, no read-back command),
`settings.rs` (JSON profiles with no secrets, DeepSeek preset). The settings UI
is `provider-settings.ts`, written with S4.

The upgrade test later proved the credential survives a reinstall, reading it
back with the raw Win32 `CredRead`.

---

## S3 + S4 — frontend and safe rendering

| Step | Result |
|---|---|
| `tsc --noEmit` | 12 errors on first run (unused constants, `has_key` on the wrong type, missing `vite/client` types, a missing re-export, a sync/async mismatch) |
| Test harness | Started as a plain `.mjs`, but TypeScript annotations in it are not valid JS. Converting to `.ts` and compiling alongside the sources was cleaner than stripping them — and it means the tests import the **real** sources, so they cannot drift |
| First unit run | **24/27** |
| Failure 1 | markdown: `![alt](url)` was rendered as a **clickable link**, which is not what the model wrote. Now an explicit inert placeholder |
| Failure 2 | wrapping: `2 !== 1` closing tags. Cause: my trailing instruction sentence repeated the tag name in angle brackets, breaking the "exactly one wrapper" invariant the test asserts. Reworded without brackets |
| Failure 3 | **real isolation bug** — switching documents let a queued delta land in the *previous* document's transcript, because `openDocument` cancelled the request but never invalidated the generation counter. Fixed |
| Also fixed | URLs with balanced parentheses were truncated at the first `)` |
| Re-run | **28/28** |
| Markdown suite | **17/19** → two failures, both genuine findings (the image one above, plus the paren truncation). **20/20** after the fixes |

### K-03 in the same pass

| Step | Result |
|---|---|
| First `build:release` + verify | **FAIL** — 3 markers found |
| Inspection | the bridge block *was* tree-shaken; the hits were `__paperaiReady` (a boolean) and `__paperaiPickFile` (the browser fallback) |
| Fixes | the browser fallback is now automation-only; `getSpanRects` moved out of the adapter into the automation block so it is truly absent, not merely unreachable; the verifier tightened to `window.__paperai` with a word boundary |
| Re-verify | release **0 markers**, automation **markers present** — both PASS |

Committed as `c423598`.

---

## S5 — K-07 crash recovery

| Step | Result |
|---|---|
| `recovery.rs` written | read-only `scan`, idempotent `apply` with three actions |
| Crash hooks added to `save_service.rs` | `crash_before_stage`, `crash_after_stage`, `crash_after_replace` |
| `cargo test --lib` | **43/43** |
| `cargo test --test save_crash_recovery` | **5/8** |
| Failure 1 | I placed `crash_before_stage` **after** the staging rename, so it reproduced the wrong state. Moved |
| Failure 2 | tests mutate a process-wide env var while cargo runs them in parallel → `tests/support` serialisation |
| Failure 3 | assertion error of mine: `.bak` is a legitimate candidate; only `.old` is a leftover |
| Re-run | **8/8 PASS**, including the real data-loss window: target gone → restore → byte-identical → second restore is a no-op |

Committed as `6cd27db`.

---

## S7 — release build and upgrade

| Step | Result |
|---|---|
| Version → `0.3.0` in `package.json`, `tauri.conf.json`, `Cargo.toml` | done |
| `build.mjs --release` + verify | **PASS**, 0 bridge markers |
| `tauri build` | `PaperAI_0.3.0_x64-setup.exe`, 5,726,436 bytes |
| Installer hook check | `!include installer-hooks.nsh` present in the generated script — the K-01 fix survived |
| `tests/windows-upgrade.mjs` | **10/11** |
| Failure | U2.2 reported mojibake. Cause: PowerShell `Get-Content` decodes UTF-8 with the system ANSI codepage (GBK here), so the Chinese `display_name` was mangled **in the test's view only**. The file was fine. Fixed by reading with `[IO.File]::ReadAllText(..., UTF8)` and asserting on ASCII markers plus the Chinese |
| Re-run | **11/11 PASS** |
| `tests/windows-integration.mjs` on 0.3.0 | **17/17 PASS** |

---

## Totals

| Suite | Count |
|---|---|
| `cargo test --lib` | 43 |
| `cargo test --test save_crash_recovery` | 8 |
| `run-ai-rust-tests.mjs` (vs Mock SSE) | 20 |
| `run-ai-unit-tests.mjs` | 48 |
| `windows-integration.mjs` | 17 |
| `windows-upgrade.mjs` | 11 |
| **Total** | **119** |

Blocked: `desktop-verify.mjs` (19), `save-safety.mjs` (12) — CDP, K-13.
Their Rust-level equivalents pass.

## Bugs found by the tests, and fixed

| # | Bug | Where |
|---|---|---|
| 1 | A document switch let a queued delta land in the previous document's transcript | `chat-controller.ts` |
| 2 | `![alt](url)` rendered as a clickable link | `markdown-renderer.ts` |
| 3 | URLs with balanced parentheses truncated | `markdown-renderer.ts` |
| 4 | Wrapper invariant broken by my own instruction sentence | `context-builder.ts` |
| 5 | `HRESULT` vs Win32 code → wrong error for a missing key | `secrets.rs` |
| 6 | `crash_before_stage` hook placed after the staging rename | `save_service.rs` |
| 7 | Harness: `spawnSync` froze the in-process Mock server | `run-ai-rust-tests.mjs` |
| 8 | Harness: parallel tests sharing an env var | `tests/support` |
| 9 | Harness: `Get-Content` encoding produced a false failure | `windows-upgrade.mjs` |

Bugs 7–9 are test-harness defects, not product defects. They are recorded
because a harness bug that manufactures a red result is exactly as misleading as
one that manufactures a green one.

---

## 交付后复查：构建脚本会删掉安装包

收尾时执行 `npm run build:release` 复核 K-03，随后发现
`dist/installer/PaperAI_0.3.0_x64-setup.exe` **不见了**。

原因：Vite 默认 `emptyOutDir`，会清空整个 `dist/` —— 而安装包按交付约定就放在
`dist/installer/`。第一次修复把暂存目录放在 `dist/.installer-stash`，同样被一起
删掉（又一次验证了"目录被整体清空"这一点）。最终把暂存目录移到项目根的
`.installer-stash/`（已加入 .gitignore），构建脚本在 vite 前后搬运安装包，并在
输出里报告搬了几个。

产物已从 `D:/PaperAI-Build/target/release/bundle/nsis/` 恢复，SHA-256 与报告中
记录的一致（`cfabb175…`），说明恢复的是同一个字节序列，不是重新构建的新文件。

这类问题值得记下来：**一个会静默删除交付物的构建脚本，比一个构建失败的脚本
危险得多** —— 构建失败会立刻发现，删除不会。

---

# 0.3.1 补丁：用户报的一个 bug，牵出三个已发布缺陷（2026-10-15 晚）

用户装上 0.3.0 后反馈：**AI 设置对话框的「关闭」按钮点了没反应**。

## A-12 — 报的那个 bug

`element.hidden = true` 本身不隐藏任何东西，它依赖浏览器默认样式表的
`[hidden] { display: none }`。而那条规则在 **user-agent 源**，所以**任何**作者样式
都能覆盖它 —— **优先级根本不参与比较**。`#ai-settings { display: flex }` 就赢了。
属性一直设对了，屏幕上就是不走。

`#ai-panel` 和 `#selection-bar` 一模一样，而且三个都是模块加载时就 `hidden = true`
创建的 —— 也就是说聊天面板的开关按钮、选区栏的 hide() **从启动起就是空操作**。

一行修好：`[hidden] { display: none !important; }`（`!important` 是必须的，得压过
ID 选择器）。顺带给设置对话框加了 Escape 关闭 —— 之前完全没有键盘路径。

**已有 119 个断言为什么没抓到**：它们测逻辑，不测渲染。DOM 是对的，屏幕是错的。
这必须要有真正的排版引擎才能发现。

新增 `tests/overlay-visibility.mjs`：用 **headless Edge + CDP** 读
`getComputedStyle().display`，每个浮层三种状态。**在修复前的产物上跑是 4/12 失败**
（四个全卡在 `display: flex`），修好后 15/15。加了一个 `control/ai-stop` 对照组
（它本来就没有 `display` 规则、一直是好的）来锁定真正诱因是「作者样式设了 display」。

注意这就是 K-13 挡住的那条 CDP 路径：**独立的** Edge 用全新 `--user-data-dir`
启动时 CDP 完全正常。K-13 只针对 WebView2 宿主，因为它会剥掉那个参数。

## A-13 — 安装包把之前的安装包装了进去

核对新包体积时发现：22.25 MiB，而应该是 ~5 MiB。

`tauri.conf.json` 的 `frontendDist` 指向 `../dist`，所以 `dist/` 里**所有东西**都会
被嵌进 setup.exe。A-11 的修法把交付物放进 `dist/installer/` 以免被 `vite build` 删掉
—— 正好送进了下一个打包器的输入口。

顺带发现 `vite.config.ts` 无条件 `sourcemap: true`，于是 3.3 MiB 的 `.map`（连带
原始 TypeScript）进了每个安装包。

| | 修复前 | 修复后 |
|---|---|---|
| `dist/` | 25.97 MiB | 6.14 MiB |
| 安装包 | 22.25 MiB | **4.76 MiB** |

交付物移到 `release/`。`scripts/build.mjs` 现在会在 `dist/` 出现非前端文件时
**直接让构建失败** —— 这道守卫才是真正的修复，因为这三个错误**全都是静默的**。
验证方式：故意在 `public/installer/` 放个杂物，确认构建拒绝。

## 测试框架自身的缺陷（也会伤到用户，但不是产品问题）

- `tests/windows-upgrade.mjs` 往 `PaperAI/AIProvider/deepseek` 写凭据 ——
  **那是用户真实 Key 的位置** —— 而且从不删除。跑一次就会把可用的 API Key
  永久替换成 marker 字符串。现在用自己的 profile id、自己清理、经
  `process.on("exit")` 备份并还原 `ai-profiles.json`，并把两件事都记进结果。
- `src-tauri/tests/ai_provider.rs` 每次运行都留下
  `PaperAI/AIProvider/rust-test-profile`；在真实凭据库里确实扫到了残留。
  改用 `Drop` 守卫清除，panic 展开的情况也覆盖。
- 两个测试都假设安装目录是 `%LOCALAPPDATA%\PaperAI`。NSIS 会记住首次安装时选的
  目录并一直复用，这台机器上是 `D:/Program Files\PaperAI` —— 于是一个完全正常的
  安装被 C1.3 / U1.1 读成 "(none)"。现在都从卸载注册表项解析。

## 结果

164 个断言全绿（43 + 8 + 20 + 48 + 15 + 17 + 13）。C1.3 现在还会校验安装后的
`PaperAI.exe` 版本号与安装包文件名一致，能抓到"装上去的是旧二进制"。

事后独立核对用户机器：`ai-profiles.json` 运行前后 SHA-256 **完全一致**；
凭据管理器里 `PaperAI` 相关只剩用户自己的 `deepseek`，测试垃圾已清干净。
