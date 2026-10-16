# AI test matrix — PaperAI 0.5.0

Generated: 2026-10-16 · Branch `ai-integration` · Version `0.5.0`

Every status below is the outcome of a run recorded in `evidence/`. Where a
check could not be run, it says **BLOCKED** and names the blocker — never PASS.

## How to reproduce

```bash
source scripts/env.sh

# Rust: streaming, provider, secrets, recovery, SSE
cd src-tauri && cargo test --lib              # 65 assertions
cargo test --test save_crash_recovery         # 8 assertions

# Rust against a real local Mock SSE server (real socket, real SSE bytes)
node scripts/run-ai-rust-tests.mjs            # 26 assertions

# Frontend logic (context, state machine, markdown safety, panel pickers,
# interrupted answers)
node scripts/run-ai-unit-tests.mjs            # 108 assertions

# Overlay visibility — REAL chromium, getComputedStyle over CDP (A-12)
# Needs a built stylesheet: run `node scripts/build.mjs --release` first.
node tests/overlay-visibility.mjs             # 15 assertions

# Model picker in the settings dialog — real Chromium, real click/selection
node tests/provider-model-picker.mjs          # 10 assertions

# Panel header provider/model pickers — real Chromium, real stylesheet, real
# change events, plus rendered geometry (A-15)
node tests/panel-model-switch.mjs             # 9 assertions

# Toolbar tool-state + math delimiters — real Chromium. Reads the REAL toolbar
# markup out of index.html, so a regression there fails the suite (A-17)
node tests/toolbar-state.mjs                 # 12 assertions

# Windows integration (installed app, native window title as the observable)
node tests/windows-integration.mjs --installer release/PaperAI_0.5.0_x64-setup.exe

# Upgrade path: oldest -> newest in release/ (currently 0.2.0 -> 0.3.1)
node tests/windows-upgrade.mjs

# K-03: the release bundle must not contain the test bridge
node scripts/build.mjs --release && node scripts/verify-release-bundle.mjs dist
node scripts/build.mjs --automation && node scripts/verify-release-bundle.mjs dist --expect-present
```

**Totals: 273 automated assertions green. 4 BLOCKED, 4 PARTIAL.**

> 0.5.0 delta vs 0.4.4: +35 assertions. Two new frontend suites (6 eraser-policy,
> 19 reading-memory, 4 memory-row) and 4 panel assertions, plus 11 Rust memory
> tests and 2 real-socket tests that a collected answer contains every delta.
> One of those 19 caught a real defect while being written: the memory block was
> injected **without** structural escaping, so a note containing
> `</reading_memory>` could close the block early.
>
> 0.4.4 delta vs 0.4.3: +15 assertions — 7 markdown/math-delimiter assertions
> and a new 8-assertion real-Chromium toolbar suite. Both are negative-controlled:
> dropping the `\[...\]` support fails 3 markdown assertions with exactly the
> reported raw-marker symptom, and removing the `tool` class from Erase plus the
> indicator update in `doHighlight` fails 5 of 8 browser assertions
> (`btn-erase->[]`, i.e. no button lights at all).
>
> 0.4.3 delta vs 0.4.2: +9 assertions. The Rust provider suite gains the two
> A-16 tests — a 21 s stream that must arrive complete, and a stream that dies
> half-way that must be reported as an interruption with its text kept — plus
> the frontend suite gains 7 for the partial-content and error-wording
> behaviour. The long-stream test is negative-controlled: restoring the 15 s
> `.timeout(...)` makes it fail at 15.02 s, reproducing the reported bug.
>
> 0.4.2 delta vs 0.4.1: +21 frontend assertions (12 panel-picker unit + 9 panel
> real-Chromium) and +1 new suite.

---

## AI-01 … AI-05 — configuration and credentials

| ID | Test | Result | Evidence |
|---|---|---|---|
| AI-01 | DeepSeek 预设配置 | **PASS** | `settings::deepseek_preset()`; base URL/model editable, persisted to `ai-profiles.json`; URL normalised on save (`config.rs` tests) |
| AI-02 | 自定义 OpenAI-compatible | **PASS** | `scripts/run-ai-rust-tests.mjs` posts to `/chat/completions` on an arbitrary base URL; 20/20 |
| AI-03 | Credential Manager | **PASS** | `ai_set_key` / `ai_has_key` / `ai_delete_key` + the upgrade test U2.3 reads the credential back with the raw Win32 API after a reinstall; there is **no** `get_api_key` command in `lib.rs` |
| AI-04 | 无 Key | **PASS** | `missing_key_fails_before_any_network_call` — returns `ai_no_key` with **0** requests reaching the mock |
| AI-05 | 连接测试 | **PASS** | `ai_test_connection` is a separate command, only reachable from the explicit 测试连接 button; UI text states it may cost a small amount. Rust side verified against every mock error scenario |

Not covered: the settings dialog's **visual** behaviour (layout, that the
password field is cleared after save) — GUI-only, see AI-21.

## AI-06 … AI-12 — context and selection

| ID | Test | Result | Evidence |
|---|---|---|---|
| AI-06 | 纯文本提问 | **PASS** | `mode none sends no document text at all` — asserts the request contains no `<document_context>` and no page body |
| AI-07 | 选中文字解释 | **PASS** | `mode selection sends exactly the selected text and its pages`; `only the display title is sent, never a filesystem path` asserts no `C:\` and no user name |
| AI-08 | 选中文字翻译 | **PASS** (prompt level) | `PRESET_PROMPTS.translate` demands 保留所有技术术语、变量名、单位、引用编号与 LaTeX 公式. Whether the *model* complies is a model property, not testable without a real key (see AI-28) |
| AI-09 | UI 抢焦点 | **PASS** (code level) | `selection-bar.ts` calls `preventDefault()` on both `pointerdown` and `mousedown` for every control; `askWithPreset` re-captures the selection at click time. **Not** verified with a real mouse — that needs a GUI session (AI-22) |
| AI-10 | 当前页 | **PASS** | `mode current-page sends only that page` — asserts the getter is called for exactly `[4]` and no neighbouring body appears |
| AI-11 | 相邻页 | **PASS** | `mode nearby-pages sends p-1, p, p+1 and clamps at the edges` — page 1 yields `[1,2]`, page 10 yields `[9,10]` |
| AI-12 | 文档切换 | **PASS** | `switching documents isolates the transcript` + `a late delta cannot leak into the document the user switched to` |

## AI-13 … AI-15 — streaming and failures

| ID | Test | Result | Evidence |
|---|---|---|---|
| AI-13 | SSE 分包 | **PASS** | Mock scenarios `batched`, `splitUtf8`, `crlfAndComments`, `emptyThenUsage`, `noDone`; plus 15 pure unit tests in `stream.rs` including a CJK character split mid-sequence |
| AI-14 | 停止生成 | **PASS** | `cancel_stops_the_stream_promptly` — cancel takes effect mid-stream and the full scripted answer is *not* consumed. Cancellation drops the HTTP body (closing the connection) rather than polling a flag |
| AI-15 | 网络失败 | **PASS** | 401/403 → `ai_unauthorized`, 404 → `ai_not_found`, 429 → `ai_rate_limited`, 500 → `ai_provider_error`, 400 → `ai_bad_config`; timeouts → `ai_timeout` / `ai_first_token_timeout`. No automatic retry, so a billable completion is never silently re-sent |

## AI-16 … AI-20 — content safety

| ID | Test | Result | Evidence |
|---|---|---|---|
| AI-16 | 空/扫描页 | **PARTIAL** | `pageHasText()` exists and `sendWithMode` refuses with "当前页没有可提取的文字（可能是扫描页）". Unit-tested for the empty case. **Not** exercised against a real scanned PDF — no such fixture was produced |
| AI-17 | 大片段 | **PASS** | `oversized context is truncated at a boundary and flagged`; the stats (chars + estimated tokens + page list) are shown on every turn |
| AI-18 | Prompt injection | **PASS** | Document text containing `</document_context>`, a fake `system:` line, or a code fence cannot escape the wrapper; **exactly one** opening and one closing tag survive in the payload |
| AI-19 | 渲染安全 | **PASS** | 20 markdown tests: no `script`/`iframe`/`img`/`object`/`embed`/`svg`/`style`/`form`/`input` element is ever *constructed* from model output; images render as an inert placeholder; `javascript:`/`data:` URLs become blocked text; no `on*` attribute is ever set |
| AI-20 | Markdown + 数学 | **PARTIAL** | Structure (headings, lists, bold, italics, code blocks, blockquotes, rules) is asserted structurally. KaTeX is wired and its fonts are bundled locally (no CDN reference in the built CSS). **Visual** math rendering was not verified — GUI-only |

## AI-21 … AI-23 — interaction

| ID | Test | Result | Evidence |
|---|---|---|---|
| AI-21 | UI 响应 | **BLOCKED** | Requires a real WebView2 session with an interactive desktop. CDP automation is unavailable on this machine (K-13) |
| AI-22 | 交互完整 | **BLOCKED** | Same: 框选→解释→流式→复制→追问→停止 needs a real mouse and a real window |
| AI-23 | 多轮对话 | **PASS** | `history is bounded and ordered oldest-first`, `history excludes turns with no usable answer`, `new conversation clears the transcript but keeps the context mode`, per-document isolation (AI-12). History is capped at 6 turns so cost does not grow quadratically |

## AI-24 … AI-28 — privacy, transport, encoding

| ID | Test | Result | Evidence |
|---|---|---|---|
| AI-24 | 隐私网络审计 | **PASS** | `evidence/ai-tests/rust-provider-requests.json` is the full request log the mock saw. In `none` mode the only body is the user's question; the per-test request counts are in `rust-provider-RESULTS.md` (all 20 tests, 19 requests, none carrying document text unless the mode asked for it) |
| AI-25 | 重定向/非 TLS | **PASS** | `redirect_is_not_followed` — `reqwest` redirect policy is `none()`, so the `Authorization` header can never be replayed to another host. Plain HTTP to a non-loopback host is refused before any socket (`ai_insecure_refused`) |
| AI-26 | Provider 兼容 | **PASS** | `non_sse_200_is_reported_as_bad_stream` — a 200 that is not SSE yields `ai_bad_stream`, never a fake empty answer. The request body is minimal (`messages`, `model`, `stream`), asserted by a unit test that lists the banned fields |
| AI-27 | 中文 PDF | **PASS** | Stage C C3.1/C4.2 open CJK + space paths via CLI and confirm the native window title; the SSE parser has a dedicated mid-character-split test; the AI panel renders Chinese through `textContent` |
| AI-28 | 无真实 API Key | **PASS / BLOCKED** | All 28 checks above ran against the local Mock SSE server — **no real key was used anywhere**. The real DeepSeek/online path is **BLOCKED: NO_USER_KEY** and must be confirmed by the user (see `PHASE3_FINAL_VALIDATION.md` §Manual acceptance) |

---

## Phase-2 regression (re-run on 0.4.1, not inherited)

| Suite | Result | Evidence |
|---|---|---|
| `cargo test --lib` | **43/43 PASS** | 2026-10-15, includes all 32 carried-over AI/stream tests |
| `tests/windows-integration.mjs` (install / CLI / single instance / uninstall / association) | **17/17 PASS** | `evidence/windows-release/stage-c-0.4.0.log` |
| `tests/windows-upgrade.mjs` (0.2.0 → 0.3.1) | **13/13 PASS** | `evidence/windows-release/upgrade-run-0.3.1.log` |
| `tests/overlay-visibility.mjs` (headless Edge + CDP, computed style) | **15/15 PASS** | `evidence/ai-tests/overlay-visibility.txt` |
| `tests/save-safety.mjs` (12 cases) | **BLOCKED** | Needs the automation build + CDP; K-13. The Rust-level equivalents all pass in `cargo test --test save_crash_recovery` (8/8) |
| `tests/desktop-verify.mjs` (19 cases) | **BLOCKED** | Same |
| `tests/readback-annotations.mjs` | **PASS** | Pure Node, no browser |

> The Phase-2 numbers (19/19, 12/12) are **not** reused as evidence for 0.4.1.
> The two suites that need CDP are re-run only in the automation build, and that
> is currently blocked by K-13 — recorded as BLOCKED, not as PASS.

---

## K-03 / K-07 / K-13 status

| Item | Status | Evidence |
|---|---|---|
| **K-03** test bridge removed from releases | **FIXED** | `build:release` → 0 markers; `build:automation` → markers present. `scripts/verify-release-bundle.mjs` scans the emitted JS |
| **K-07** save crash recovery | **MITIGATED → recoverable** | `recovery.rs` + 8 injected-crash tests. It is **not** an atomic save and the reports say so |
| **K-13** CDP not reproducible | **ROOT-CAUSED, alternative path provided** | Four experiments in `AI_S0_BASELINE.md` §4. WebView2 strips `--remote-debugging-port`. Automation of the real WebView2 stays BLOCKED; OS-level evidence is used instead |
| **K-14** test process leakage | **FIXED** | Every probe kills the process tree it started; no global `Stop-Process msedgewebview2` |
