# Known issues — PaperAI 0.3.1 (AI round)

Severity: **P0** blocks release · **P1** serious · **P2** cosmetic.

Phase-2 issues are carried in `KNOWN_ISSUES_UPDATED.md`; this file covers what
changed or was found in the AI round.

0.3.1 is a single-bug patch over the shipped 0.3.0: **A-12**, reported by the
user against the installed build. Everything else here is unchanged from 0.3.0.

---

## P0

*(none open)*

The three P0-class risks the task named are all closed:

| Risk | Status |
|---|---|
| Key leaking to the frontend or logs | **closed** — no read-back command exists; see `AI_PROVIDER_SECURITY.md` §1 |
| User PDF damaged by a failed save | **closed** — 7 injected failure paths + 8 crash-recovery tests; see `AI_TEST_MATRIX.md` |
| Installer stealing the `.pdf` default | **closed** — candidate-only registration, asserted by Stage C C2.2/C5.4 |

---

## P1

### A-01 — The full AI interaction loop is not automatically verified

`框选 → 解释 → 流式 → 复制 → 追问 → 停止` needs a real mouse in a real window.
CDP against the real WebView2 is unavailable on this machine (K-13), so
`AI-21`, `AI-22` and the visual half of `AI-05`/`AI-09`/`AI-20` are **BLOCKED**,
not PASS.

* What *is* verified: the logic behind every step (48 unit assertions), the
  provider behaviour over a real socket (20 assertions), and that the installed
  app boots and opens a document (upgrade test U2.7).
* Mitigation: `PHASE3_FINAL_VALIDATION.md` §Manual acceptance gives the exact
  click-through for a person to run.
* Blocks: claiming "verified end to end". Does not block daily personal use.

### A-02 — No real-API verification was possible

No DeepSeek key was available, so the online path is **BLOCKED: NO_USER_KEY**.
Everything was verified against the local Mock SSE server, which speaks the same
protocol over a real socket.

* Not a defect: the task explicitly says to mark this BLOCKED rather than fake a
  pass.
* The user can confirm in two minutes: configure a key, click 测试连接, ask a
  question about a selection.

### A-03 — `window.__paperai_ready` still exists in release builds

A read-only boolean, set once at boot so the automated desktop suites can tell
"frontend booted" from "blank window". It exposes no callable surface, and
`scripts/verify-release-bundle.mjs` asserts that nothing *else* survives.

* Accepted deliberately rather than removed: without it, a blank window is
  indistinguishable from a slow one, which is exactly the failure mode that cost
  the most time in Phase 2.
* If a release must have zero observable surface, gate it behind the automation
  flag too and find another readiness signal (the window title works).

### A-04 — Model output rendering is unverified visually

The renderer's *structure* is tested (no forbidden element is ever constructed).
Whether a KaTeX matrix looks right, or whether a long table overflows, needs
eyes. GUI-only; same blocker as A-01.

### A-05 — Empty / scanned pages: no real fixture

`pageHasText()` and the "当前页没有可提取的文字（可能是扫描页）" path exist and
are unit-tested for the empty case, but no actual scanned PDF was prepared. The
claim "handles scanned pages" would be stronger with one.

### A-06 — Chat history is not persisted

By design for this round: closing the app discards the conversation. A user who
expects to reopen a paper and find yesterday's questions will be surprised.

* Mitigation: the panel says 仅本次会话 at the top of an empty transcript.
* If persistence is added, it must be opt-in and must not write paper text to
  disk without saying so.

---

## P2

### A-07 — Model field starts empty for a custom provider

Adding "OpenAI-compatible Custom" pre-fills `https://` and an empty model, so
the first save fails validation with `ai_bad_config`. Correct but abrupt.

### A-08 — Panel width is not remembered

Resizing the AI panel resets on restart.

### A-09 — Only one provider can be default

The schema allows several profiles but the UI always uses the default. Multiple
profiles exist for switching, not for simultaneous use.

### A-10 — Link clicks use `window.open`

Safe (the renderer strips `href` and only an explicit click reaches
`onOpenLink`), but it opens a browser tab rather than the system default browser
via a Tauri shell API. Cosmetically inconsistent on machines where the default
browser is not Edge.

### A-11 — A frontend-only rebuild used to delete the shipped installer

`vite build` empties `dist/`, and the deliverable lives in `dist/installer/`.
Running `npm run build:release` therefore removed
`PaperAI_0.3.0_x64-setup.exe` with no error at all.

* Fixed: `scripts/build.mjs` moves `dist/installer` to `.installer-stash/`
  (outside `dist/`) before bundling and restores it afterwards, reporting how
  many files it preserved. A first attempt stashed inside `dist/.installer-stash`
  and Vite deleted that too.
* **Superseded by A-13**: this kept the files alive, but keeping them in `dist/`
  at all meant the bundler picked them up. Deliverables now live in `release/`
  and the stash is gone. The lesson is the same one twice — protecting a file
  from one process is not enough if another process reads that directory.
* Why it earns an entry despite being fixed: a build step that silently deletes
  an artefact is more dangerous than one that fails, because failure is noticed
  and deletion is not.

### A-12 — FIXED in 0.3.1: `hidden` did nothing on three overlays (user-reported)

**Reported by the user against the shipped 0.3.0 build:** the AI settings dialog's
关闭 button was clicked and the dialog stayed on screen.

Root cause is a CSS cascade rule that is easy to get wrong and hard to see:

* `element.hidden = true` does not hide anything by itself. It relies on the
  user-agent stylesheet's `[hidden] { display: none }`.
* That rule lives in the **user-agent origin**, so *every* author declaration
  beats it — **specificity is never even consulted**. The author rule
  `#ai-settings { display: flex }` therefore won, and the "hidden" overlay
  rendered at `display: flex`.
* The same held for `#ai-panel` and `#selection-bar`. All three are constructed
  at module load with `hidden = true`, so all three were **visible from launch
  and could not be dismissed** — the chat panel's toggle button and the
  selection bar's hide() were both no-ops on screen.

Fixed by one global rule in `src/style.css`:

```css
[hidden] { display: none !important; }
```

`!important` is load-bearing here: it has to outrank ID selectors. `#recovery-modal`
is covered too, though it currently dismisses itself with `.remove()` rather than
`hidden` — it is listed as *latent* rather than *live* in the test for that reason.

Regression test: `tests/overlay-visibility.mjs` (`npm run test:ui-overlay`).
A DOM shim cannot catch this class of bug, because cascade and computed style are
exactly what a shim does not implement. So it drives a **real headless Chromium**
(`getComputedStyle` over CDP) and asserts, for every overlay, that hidden→`none`,
unhidden→visible again, and hidden→`none` once more. It was confirmed to FAIL
(4/12, all four stuck at `display: flex`) before the fix and PASS (15/15) after.

Why it reached a shipped build: all 119 prior assertions tested logic, not
rendering. The `hidden` attribute was set correctly — the DOM was right and the
screen was wrong. Nothing short of a real layout engine could have caught it.

Also in this fix: Escape now closes the settings dialog. It previously had only
the backdrop-click and the button, and the Escape path was missing entirely.

### A-13 — FIXED in 0.3.1: the installer was nesting previous installers

`tauri.conf.json` sets `frontendDist: "../dist"`, so **everything** in `dist/`
is embedded into the binary and then into the setup.exe. The A-11 fix (below)
had moved the shipped setup files to `dist/installer/` to protect them from
`vite build` — which put them straight into the next bundler's input.

Consequence: `PaperAI_0.3.1_x64-setup.exe` came out at **22.25 MiB**, containing
`PaperAI_0.3.0_x64-setup.exe` and `PaperAI_0.2.0_x64-setup.exe` nested inside it.
Each release would have swallowed all the previous ones.

Two further things fell out of the size investigation:

* **Source maps were in the release bundle.** `vite.config.ts` had
  `build.sourcemap: true` unconditionally — 3.3 MiB of `*.map` shipped inside
  the installer, and with them the original TypeScript. Maps are now produced
  only when `VITE_PAPERAI_AUTOMATION=1`, i.e. for test builds that are never
  distributed.
* `dist/` was 25.97 MiB of which only ~6 MiB was ever frontend.

Fixes:

* Deliverables moved to `release/`, outside every directory the bundler reads.
* `scripts/collect-release.mjs` copies the built setup there and prints size +
  SHA-256, refusing to pass a file above a 12 MiB sanity bound.
* `scripts/build.mjs` now **fails the build** if `dist/` contains anything other
  than `assets/`, `index.html`, `cmaps/` or `standard_fonts/`. This is the part
  that actually prevents recurrence: the previous mistakes were all silent.
* `scripts/size-report.mjs` breaks down `dist/` by top-level entry.

Net effect: `dist/` 25.97 → 6.14 MiB; installer 22.25 → 5.46 MiB.

The A-11 stash workaround is gone. It only existed because the deliverable was
inside `dist/`; now that it is not, `vite build` emptying `dist/` is harmless
and the right behaviour.

---

### B — 0.7.0: the model can ask for a page, and the app fetches it

The feature the notes were for. With notes standing in for the document, a
question costs a few hundred tokens — but notes are a summary, so sooner or later
the model needs the actual page. It can now ask for it.

The loop: the model calls `read_page(page)`, the app renders that page, replies
with the image as a `tool` message, and asks again. The user sees the question,
then the answer, with "正在查看第 5 页…" in between.

**Tool calling, not a marker in prose.** The decision from the design note, and
the reason is forgery: a marker like `[[PAGE:5]]` is just characters, and a
document that contains those characters would produce the same signal. A
`tool_calls` field is not reachable from document text at all. The cost is real
— the request/stream protocol gained `tools`, `tool_calls`, a `tool` role and a new
terminal event — and it was paid deliberately.

**Only one tool exists, and Rust checks the name too.** `read_page` takes one
integer and returns one page image. It cannot read the filesystem, fetch a URL, or
return more than the viewer already displays. The frontend supplies the
description and schema (it knows the page count); the *name* is checked against a
fixed allowlist in Rust, because the set of actions must not be decided by
anything that a document can influence.

**Every rule is a refusal, never a repair.** A page out of range is refused
rather than clamped: clamping 900 to page 7 would hand the model a page it did
not ask for and it would answer from it. A fractional page is refused rather than
rounded. A string `"5"` is refused. Malformed JSON is refused with a message the
model can act on. Refusals go back as `tool` messages so the model can answer
from what it has instead of the user getting nothing.

**The cap belongs to the app.** Two pages per question, counted in distinct
pages fetched — asking twice for page 5 does not buy two refetches. Beyond that
the user is asked, and a refusal ends the turn with a stated reason naming the
pages the model wanted. The controller also bounds the loop in rounds, so a
provider that keeps emitting calls cannot loop forever even if the page budget
somehow does not bite.

**Every `tool_call` id gets exactly one reply.** The protocol requires it; a
missing reply makes the request malformed and the provider reports a bad request,
which looks like a broken model rather than a broken app. There is a test for the
totality of that mapping.

Pages fetched during an answer are attached to the *question* turn, so a later
read of the conversation shows why the answer mentions a figure — and a follow-up
does not pay for them again (A-29's rule, applied to the new path).

**What is not tested, and stated rather than implied:** the rendering, the
confirmation prompt, and whether a given model actually uses the tool when it
should. No unit test can answer the last one; it needs a real provider and real
papers. The rules that *are* testable are, with negative controls that fail
precisely when a rule is removed.

### A-36 — 0.6.11: a session created after the provider was chosen could not send

The failure, reproduced exactly: fresh install, first question in `selection`
mode is refused for having no selection; switch to `whole-document`, ask again,
and get **"未发送：上一个回答仍在进行中"**. Switching the model away and back
makes it work.

Two defects stacked, both about the order things happen in.

**`profileId` started null.** `setProfileId` is a no-op while no session exists,
and the session is created when a *document* opens — which is after the provider
is chosen. So the session never received it and `send()` refused. Touching the
model picker called `setProfileId` again, which is exactly why that "fixed" it.
The session now inherits the active provider at creation (`currentProfileId`),
and `openChatSession()` re-binds it at all four document-opening call sites.

**`contextMode` was hardcoded to `selection` in the session constructor.** A
previous release changed the *fallback* in `contextMode()` and left this literal
alone, so the change never took effect. A fresh document has nothing selected, so
the default itself was deciding the first question would fail.

**The error message was guessing.** It inferred "busy" whenever any turn existed,
so a session with no provider reported "上一个回答仍在进行中" — a confident, wrong
diagnosis that sent the user looking for a stop button that did nothing. It now
names the actual condition, in order.

Four tests, each negative-controlled: removing the inherited profile fails the
inheritance test and the first-send test; restoring the `selection` literal fails
the default test.

### A-35 — 0.6.10: the send button was dead from the first second; tables render

**The real cause of "Enter does nothing with DeepSeek".** A-33 addressed a
swallowed keystroke, but the report was sharper than that: the send button was
dead on a freshly opened document, before any AI request had been made.

That is a bug introduced by A-31 (persisted conversations). A saved turn could
carry `preparing` or `streaming`, and on restore it came back as an *active*
turn. The panel derives `busy` from the phase, so it disabled sending — with
nothing in flight that could ever finish. The state was permanent: reopening the
document restored the same dead turn.

How it got written despite `scheduleChatSave` only saving on a terminal phase:
the guard ran when the timer was *scheduled*, the snapshot was taken when it
*fired*. In between, the user could send another question, and the snapshot then
contained a turn that was still running.

Fixed in three places, each tested: the snapshot is taken at schedule time, so
the check and the content describe the same moment; `toStoredChat` never writes a
non-terminal phase (coerced to `cancelled` — the turn was interrupted by the app
closing, which is what happened); and `fromStoredChat` never trusts one found in a
file, because older files already contain them. A null turn id from `send()` is
no longer silent either: it names the reason.

**Markdown tables now render.** They never did — the renderer had no table
support, so a parameter table arrived as one run of `| 阶段 | 优化参数 | ...`, and
the column structure, which was the entire reason the model used a table, was
lost. Cells go through the inline renderer, so `$C_{ox}$` renders as math instead
of showing dollars. Alignment markers, escaped pipes, ragged rows (padded, so
later columns cannot shift) and horizontal scrolling are handled and tested.

**Notes generate automatically after the first whole-document answer.** The
document is already in the model's hands at that moment, so it is the cheapest
point to note-ify — and every later question then costs a few hundred tokens
instead of re-sending the paper. Guards: never overwrites existing notes, never
retries a document that already failed, never runs while something else is. The
user is told, because this spends their tokens.

**The default context mode is now `whole-document`.** It was `selection`, which
on a fresh document with nothing selected refused the first question outright —
the default was making the decision that the send would fail.

### A-33 — 0.6.9: Enter is no longer swallowed, and a busy stream now times out

Two reports that turned out to be one cause and one consequence.

**"Enter stopped working, but only with DeepSeek."** The send button is disabled
while an answer streams; a disabled button cannot stop a keystroke, so Enter went
straight to `submit()`, which had no busy check. `chat.send()` then returned
`null` for a busy session — with no message anywhere. (The permanent version of
this is A-35, above.)

**"OpenCode hung for minutes with no output."** The request was not dead. The
stall deadline was reset by *any* byte on the stream — including SSE comments and
role-only chunks, which a chatty gateway emits continuously during a large
upload. So the 60-second first-token timeout never fired: the connection was
never idle, it just never said anything.

Fixed with a second deadline that nothing resets: the first *content* must arrive
within 180 seconds. Deliberately separate from the idle timeout rather than a
longer version of it, because the two catch different failures — a quiet
connection versus a busy one producing nothing — and the A-16 behaviour (a slow
but producing stream must run to completion) has to survive. Both are tested, and
the negative control removes the ceiling and watches it fail.

### A-32 — 0.6.8: notes as the document, persisted conversations, history switch

Three changes that all answer the same question — what does a follow-up actually
cost, and what does the model actually know.

**Notes can stand in for the document (A).** `whole-document` mode now uses the
reading notes when the caller asks for them, and falls back to them automatically
on a document with no extractable text. For a scanned paper read into notes by
the image pipeline, a question costs ~800 tokens instead of ~3150 for seven page
images. The label names the source — `整篇 · 使用阅读笔记` or
`整篇 · 无可提取文字，改用阅读笔记` — because a transcript that says "整篇" while
sending a summary is a lie the user cannot check.

Notes are *not* substituted by default when text exists: they are a summary, and
answering from less information while claiming otherwise is worse than paying.

**Conversations persist beside the PDF (C).** `<pdf>.paperai-chat.json` holds the
turns with ISO timestamps; `<pdf>.paperai-chat/` holds the images. Two files, not
one, because a seven-page conversation is ~5 MB of data URLs — JSON that size is
slow to parse, impossible to inspect, and rewritten in full every turn.

The images are **content-addressed**: named by the SHA-256 of their bytes, so the
same page appearing in several turns is stored once. A long conversation about
one paper does not grow linearly with its own length.

Details that are defects if wrong and invisible if right:
- Write-then-rename, so a crash mid-write cannot leave truncated JSON that the
  next open refuses to parse.
- A missing image file drops that attachment, not the conversation: the text is
  still worth showing.
- Invalid JSON is an **error**, not an empty history — otherwise the next save
  silently destroys whatever is there.
- Filenames from the JSON are never joined into a path if they contain `/`, `\`
  or `..`; a stored `../../Windows/win.ini` is ignored, and there is a test.
- Only `image/*` data URLs are stored. The directory is named for images; writing
  arbitrary payloads into it is how a storage area becomes a drop box.

Timestamps are shown per turn, in local time. A restored transcript with no dates
cannot be told from today's.

**History can be turned off (D).** A checkbox in the context row. This is the one
change here with a silent failure mode, and it bit immediately: `historyLimit: 0`
went through `Array.slice(-0)`, which is `slice(0)` — **the whole array**. So
"don't send history" sent all of it. A test caught it; the same test is the
negative control for the guard.

The other half of the switch is subtler: `pagesInHistory` and `history` must be
decided together. Turning history off while keeping the page list would skip
rendering pages the model can no longer see — the same shape as A-29, one layer
up. Both are cleared from one flag at the call site, and tested.

**Not tested:** the round trip through the real filesystem and Tauri bridge (the
store's own rules are; the wiring is not), and the panel's checkbox state.

### A-31 — chat history store

The pure store: `toStoredChat` / `fromStoredChat` / `turnToMessage` /
`formatTurnTime`, plus the Rust side in `chat_history.rs`. 15 frontend tests and
9 Rust tests. Tolerant on read by design — an older build's file, a hand-edited
one, or a half-written one should cost at most a turn, never the conversation.

### A-29 — 0.6.6: follow-up questions no longer re-send the pages they already sent

Whole-document image mode was expensive in a way that was not obvious: asking a
second question sent the same pages **twice**. The API is stateless, so every
request has to carry the document — and the history already does, because a past
question turn is rebuilt with its images intact (`questionWithImages`). The new
turn then rendered and attached them again. For a 7-page paper that is ~7k tokens
of images on every follow-up, half of it duplicate.

**Pages already in the request are skipped.** `pagesInHistory()` reports which
pages the model can still see, derived from the *same window* `history()` uses —
they share `recentWindow`, and that sharing is the whole point. A separate count
would drift, and the failure is silent and total: skip a page the model cannot
see and that page vanishes from the document, with nothing in the answer to show
it. The invariant is tested against the real controller, not asserted in a
comment.

**Two bugs found while wiring it up, both caught by tests rather than review:**

1. A follow-up that renders nothing was told "本次没有提供论文原文" — while the
   model was holding all seven pages from the history. A model told it has no
   paper declines to answer questions about the one in front of it. Fixed by
   counting reused pages towards `providesDocument`.
2. The partial-coverage note keyed off freshly-rendered pages, so an all-reused
   follow-up on a 12-of-30-page paper lost it — the exact case where the note
   matters most, because the user is mid-conversation and the model would
   summarise 12 pages and call it the article. Now keyed off total coverage.

Both were negative-controlled. The first was **not** covered when it was written
— the control run stayed green, which is how a fix that nothing guards gets
found. A test was added for it and the control then failed exactly there.

Labels distinguish "sent N pages" from "reused N from history", so the
transcript shows what a question actually cost.

### A-28 — 0.6.5: whole-document image mode, for documents with no text at all

A scanned paper has no text in the file. The user reported "未能提取到文本" on
exactly such a document and read it as the text-extraction bug still being
broken; it was not. Verified directly on their PDF: 7 pages, one image draw
operation each, zero text operations, no encryption — the text genuinely is not
there, and reading it differently cannot help. Looking at the page can.

**`whole-document-images`** rasterises each page and sends them as images.

**Rendering is independent of the viewer.** `renderPageImage` renders from the
document, not from a painted canvas — `pageCanvas()` reads what the viewer has
already drawn, which is the same render-state dependency that caused A-26, and
whole-document mode would silently skip every page the user had not scrolled to.

**JPEG, not PNG.** A scanned page is a photograph: PNG is lossless and several
times larger for detail nobody asked to preserve. The region-screenshot ladder
prefers PNG because line art and formulas ring under JPEG's 8×8 blocks; that
reasoning does not apply to a page-sized scan, and the payload matters far more
at this size.

**Two budgets, both enforced as the pages are produced.** 12 pages
(`MAX_WHOLE_DOCUMENT_IMAGE_PAGES`) and 12 MiB of data URL
(`MAX_IMAGE_PAYLOAD_CHARS`). Checking as we go means a 30-page paper sends its
first pages rather than rendering all 30 and being rejected as one oversized
request — the alternative wastes every render the user waited for.

**Coverage is stated, not implied.** When the cap bites, the model is told it
received part of the paper and must say which pages. Without it, 12 pages of a
30-page paper get summarised and called the article — the same silent-truncation
failure the text mode guards against. This was caught by a test, not by review:
the note is computed for the image mode but originally only reached the model
through `composeContextTurn`, and image mode has no document *text* message, so
it was dropped on the floor.

**The images travel in the question turn**, never the document turn — the cache
invariant from A-22/A-23. There is no document text in this mode, so the
question turn is the only place they can go, and the "no document provided"
branch must not fire when pages are being sent.

**Scanned documents are intercepted locally.** Asking about a paper with no
extractable text used to send the question with nothing attached, so the model
could only answer "you have not given me the paper" — a paid round trip to be
told what the app already knew. Now the send is stopped, the mode is switched to
`whole-document-images` for the user, and the hint says why. Asking the question
again is then one keystroke rather than a hunt through settings.

**Cost is real and stated.** ~1k tokens per page versus a few hundred for its
text. The mode hint says so before the user picks it.

12 tests, negative-controlled: dropping the coverage note fails exactly the
assertion that checks it. The rendering itself is not unit-tested — it needs a
real canvas — and that is stated rather than implied.

### A-27 — 0.6.4: Ctrl+wheel zoom, anchored on the cursor

Hold Ctrl and roll the wheel over the page to zoom. The arithmetic
(`zoomFactorFor`, `clampZoom`, `isZoomGesture`) is pure and lives in
`src/pdf/wheel-zoom.ts`; the DOM wiring is in the adapter, kept thin so every
decision it makes is one of the pure functions'.

**Anchored on the pointer, not the centre.** Handed to the viewer's own
`origin` option rather than reimplemented — the anchor maths is exactly the kind
of thing that looks right and is off by the scroll offset, and the offset is
invisible in a screenshot. Zooming to the centre means the thing you pointed at
slides out from under the pointer, so you zoom, lose your place, scroll back,
zoom again.

**One notch is one step.** The factor is constant, not proportional to
`deltaY`: trackpads emit a continuum of small values and mice emit large ones,
so a proportional response makes zoom speed depend on the hardware. `deltaMode`
(line/page vs pixel) is deliberately not used for magnitude for the same
reason — it would make the same gesture behave differently under a browser
setting the user never sees.

**Bounds 0.25–5.** PDF.js clamps to 0.1–25, which is wider than useful at both
ends: one notch at the low end empties the viewport, and past ~5x on a 1280px
panel a single line of text fills the screen. The clamp is also the last line
of defence — a non-finite scale returns 1 rather than the ceiling, because
clamping an already-broken value to the maximum applies the consequence of the
break.

**Left Ctrl cannot be distinguished.** The request was for the left key
specifically, and a `WheelEvent` carries only `ctrlKey` — no `code`, no
`location`. Tracking it through keydown/keyup means guessing at state that can
be missed (a keyup outside the window leaves the flag stuck), and getting it
wrong fails silently. So any Ctrl zooms, which is also what every other PDF
reader does. Cmd is accepted on the same reasoning.

**Plain wheel still scrolls.** `isZoomGesture` returns false without Ctrl, so
the listener returns before `preventDefault()` — that check is the one that
keeps the gesture from breaking ordinary scrolling, and it is negative-controlled.

Not covered by tests, and stated rather than implied: the DOM wiring itself.
The listener, the `origin` computation and the `updateScale` call need a real
WebView to exercise, and this project has no browser automation (K-13). What is
tested is everything the wiring delegates to.

### A-26 — FIXED in 0.6.3: page text extraction depended on scroll position

The panel reported "未能提取到文本（共 N 页）" for a document with text on
every page.

`getPageText()` read the rendered `.textLayer` DOM element. PDF.js builds a
page's text layer inside `PDFPageView#draw()` — which runs only for pages it has
actually rendered — and rendering is virtualised by visibility
(`pdf_viewer.mjs:7143`, the `if (!this.textLayer && ...)` branch). So any page
the user had not scrolled to had no text layer and read as empty: exactly the
same result as a genuinely scanned page. Opening a paper and asking about it
before the renderer caught up produced a document-wide failure, and the panel
had no way to tell "scanned" from "not rendered yet".

**Why no test caught it.** Every existing test supplied its own fake
`getPageText`, so the adapter's own extraction was never exercised end to end.
The code under test was the fake. That is the same shape as the DOM-shim gaps
in 0.5.1 and 0.6.3: a test that cannot reach the real path passes for the wrong
reason.

**The fix.** `getPageText()` now asks the document (`page.getTextContent()`),
which has no dependency on rendering. It is also the source the text layer is
rendered from, so "matches what the user can select" still holds — the layer is
a positioned view of the same content, not different content. Results are
cached per page, because `whole-document` walks every page on every question and
each call is a worker round-trip; the cache is cleared on close so it cannot
outlive its document.

**Composition is a separate pure module** (`src/pdf/text-compose.ts`), so it is
testable in plain Node with no browser and no worker — importing it through the
adapter would have dragged in `pdfjs-dist`, whose Node support is the
`legacy` entry point only. That separation is what makes the tests real rather
than decorative.

**Test inputs are real.** `scripts/capture-text-fixture.mjs` captures actual
`getTextContent()` output from the fixture PDFs, and the tests run against it.
Synthetic items only prove the function handles the shapes its author thought
of. Two behaviours were found this way and pinned, both verified against what
the DOM implementation would have produced rather than assumed:
  - a blank line is an empty run following a line that already ended (two
    `<br>`s in the layer) — dropping it merges paragraphs;
  - a space goes between runs only between *Latin* word characters. An
    unconditional space puts one between two Chinese characters, which is
    visible and wrong in a tool whose point is reading Chinese papers.

Both were negative-controlled: breaking either fails exactly its own
assertions.

**Verified end to end** by `scripts/verify-text-extraction.mjs`, which walks
every page of all five fixtures with no viewer and nothing rendered — the state
a document is in the moment it opens. All pages yield text.

Note the residual case this does not fix: a genuinely image-only PDF still
extracts nothing, and the panel still says so. That is correct behaviour, not a
bug — but the message now means only one thing instead of two.

### A-25 — FIXED in 0.6.3: the composer swallowed Enter from the input method

A question typed into the composer would not send. Nothing was wrong with
`submit()` — the Enter handler was intercepting the keypress an IME uses to
*commit a candidate*.

Typing Chinese means every Enter is a composition key first and a send only
second, and `key` cannot tell them apart: both are `"Enter"`. Treating a
composition Enter as a send breaks the question two ways at once — the candidate
never lands in the box, and a question goes out built from whatever
half-finished pinyin happened to be in the field. Because the app is a Chinese
reading tool, this made the composer unusable in its primary language.

The platform does distinguish them, and it is the only thing that can:
`e.isComposing`, plus `keyCode: 229` as the Windows signal. Either one alone is
honoured, because neither is universal across input methods and the failure is
silent — the question simply does not appear, with nothing in the UI to explain
why. Shift+Enter is not composition-sensitive, so it is untouched.

Five tests, negative-controlled: removing the guard fails exactly the two IME
assertions. One of them asserts the send *button* still works, so the fix cannot
be satisfied by disabling Enter altogether.

**A shim gap surfaced along the way.** The new tests first failed with
`row.replaceChildren is not a function` — the DOM shim was missing the method the
panel uses to swap a `<select>`'s options, so the tests died before reaching
their own assertions. That is the same failure mode as `childElementCount` in
0.5.1: a test that cannot reach its assertion "passes" for the wrong reason.
`replaceChildren` is now implemented. Worth watching for on any new DOM method
the panel starts using.

### A-24 — FIXED in 0.6.3: the Zhipu free preset defaulted to a retired model id

The preset's default model, `glm-4.6v-flash`, stopped working: Zhipu's free
tier rejected most requests for it as overloaded on both the China and
international services, and by 2026-10-10 at least one gateway had retired the
id outright. Now `glm-4v-flash`.

**The interesting part is why nothing caught it.** The endpoint answers **401
for a retired id exactly as it does for a live one** — auth is checked before
model validation. So the probe that "verified" this preset when it was written
(401 rather than 404, therefore the path exists) proved only the path. The
doc comment already admitted the model ids were unconfirmed and the setting's
own 测试连接 was pointed at as the real check, and then an unconfirmed id was
made the default anyway. Free-tier models rotate on someone else's schedule;
a preset pinned to one is a preset with an expiry date nobody wrote down.

**What was done.** The default changed, the doc comment now states the
verification level without hedging it into uselessness, and
`zhipu_default_is_not_a_retired_free_tier_id` pins the id with the reason
attached — verified by deliberately reverting it and watching that test fail
with the right message. `glm-4.1v-thinking-flash` (image reasoning) and
`glm-4-flash` (text) are also free and selectable from the dropdown.

**Also worth knowing:** Zhipu error `1305` ("该模型当前访问量过大") is a
*model-side* shortage, not a rate limit on your account. Backing off does not
help. The error text reads like throttling and invites the wrong response.

**Not verified:** that Zhipu serves `glm-4v-flash` *today*. The evidence is a
second-hand hands-on survey of the free tier, not a call this repository made
with a working key. 测试连接 remains the only one-click check.

### A-23 — 0.6.0: multimodal support and region screenshots

Requested after A-22, with the screenshot feature as the stated next step.

**Protocol.** `content` became "a string, or an array of blocks". The shape is
untagged on both sides, so a text-only message still serialises as a bare JSON
string — which is what keeps A-22's prefix cache working. The collapse is
enforced in Rust (`content_value`) rather than trusted to the caller: no images
means the content is text, and text goes out as a string. A caller that builds
the document as a one-element block list would otherwise turn every turn into a
cache miss with no symptom anywhere.

**Where images go.** In the question turn, never in the document turn. An image
in the document message would make the prefix diverge on every question. The
question turn already varies per turn, so it is free to change shape.

**Local downscaling.** DeepSeek caps an image at a flat 384 tokens, so it
downscales hard on its own side — a 4K screenshot pays full upload cost for
detail the model never sees. Longest side goes to 1568 px, PNG first (line art
and formulas; JPEG's 8×8 blocks ring exactly where the detail is), falling back
to JPEG and then to a smaller scale only when PNG will not fit. Four rungs, then
a refusal rather than an illegible image.

**Cleartext refused.** Rust rejects `http://` image URLs. A screenshot of a
paper is the most sensitive payload this app sends; fetching it over cleartext
to avoid a base64 encoding is not a trade worth making. `data:` and `https:`
only.

**Injection.** Text rendered into a picture is still text. The system prompt's
data-not-instructions rule now covers screenshots explicitly, and the question
turn labels the image with its page so the model reads it as part of the paper
rather than as an arbitrary picture.

**Model capability.** There is no honest way to know in advance — a provider's
catalogue returns ids and nothing else — so nothing guesses. The first image
question to a text-only model fails with the provider's own message, that
message is recorded against the model, and every later attempt with that model
is warned *before* it is sent. A model that works is never warned about. DeepSeek's
refusal is unambiguous: any model other than `deepseek-v4-flash-vision-exp`
returns 400 "This model does not support image".

**Two costs worth knowing.** An image-only message is legitimate and allowed.
And once a conversation contains an image, that image is in the prefix of every
later turn in it — if the provider does not cache image tokens, the rest of that
conversation loses the cache. Screenshot questions are best started in a fresh
conversation. DeepSeek's documentation does not say whether image tokens
participate in prefix caching, so this is not a guarantee either way.

**Overlay mount point.** The selection overlay is mounted on `#viewerWrap`, not
`#viewerContainer`. The container scrolls, and an `inset: 0` child of a
scrolling box is positioned against the top of the *content* — it sails out of
view the moment the user scrolls. The overlay returns client coordinates so the
caller never has to know which element it was mounted on.

### A-22 — FIXED in 0.5.3: the document was re-sent at full price on every question

Reported 2026-10-16: "就算是整篇模式也不能每次都上传吧，上传一次大模型应该就有记忆了吧".

The intuition is right; the mechanism is different from the one assumed. The
HTTP API is stateless — nothing is remembered between requests, which is why the
client must resend context every time. What approximates "upload once" is
**prefix caching**, and DeepSeek documents the rule precisely: the match must
start at token 0, and a match that begins mid-payload does not count. Cached
input is billed at roughly 1/20, and their own measurement is first-token latency
dropping from 13 s to 500 ms on a mostly-repeated 128 K input.

The payload was built as `[system, ...history, user(document + question)]`. The
document sat *after* the history, and the history changes every turn, so the
shared prefix between two requests ended before the document — the paper was
never in a cache prefix and every question paid full price for it. The reading
notes had the same problem, because they were appended from outside this module
after the history.

Fixed by splitting the document into its own user message, immediately after the
system prompt and ahead of the history, with the notes inside it:

```
[system, user(document + notes), ...history, user(question)]
```

Two consequences, both deliberate:

* The first two messages are both `user`. OpenAI-compatible APIs do not require
  alternating roles, and this is the only way to get the document into a shared
  prefix without putting untrusted text into the system prompt — which this
  module refuses to do, because the wrapper in a user-role message is what stops
  a document containing its own closing tag from escaping the context. Trading
  the injection defence for a cache hit is a bad trade.
* Nothing in that message may vary between turns. A timestamp, a page count
  derived from scroll position, anything, would silently cost the cache on every
  question. There is a test asserting the message is byte-identical across turns.

Tests: the document message is byte-identical across turns; the question is what
varies and is the last message; the document precedes the history; notes land in
the same message, ahead of the paper, and do not rewrite the history or the
question; no memory means nothing is injected. The structural assertions were
re-pointed at the message that carries the document rather than "the last
message" — which would otherwise have kept passing while checking nothing.

### A-22b — OpenCode: catalogue requests no longer carry the session header

`list_models` sent `x-opencode-session: paperai-models`. OpenCode's own guidance
is that model-catalogue requests do not carry it, because they are not part of a
conversation and there is no backend to pin. Removed, along with the now-dead
parameter that carried it through the bridge and the command.

The inference path keeps the header, and now has three tests instead of one: the
value is the conversation id and is identical across turns of the same
conversation while differing between conversations; the notes pipeline uses its
own scope; and a catalogue request carries no header at all. The last is asserted
from the mock's request log over *every* recorded request, and is
negative-controlled — re-adding the header fails it with `GET /models` named.

### A-21 — FIXED in 0.5.2: reading memory was sent as a second `system` message

Found while answering "is 阅读笔记 the memory file?" — reviewing what had shipped,
not a user report.

`main.ts` spliced the `<reading_memory>` block in as its own `system` message
after the conversation history. That produces a payload with **two `system`
entries**, and several OpenAI-compatible gateways — OpenCode among them —
validate the role sequence and reject that. The visible effect would have been a
400 on the user's first use of exactly the feature we had just built, with a
message about roles and nothing about memory.

Fixed by `injectMemory()`: the block is folded into the **user turn**, ahead of
the document text (the paper outranks the notes, and the block already says "以
原文为准"). One `system` prompt, one authoritative instruction set, and the
history left byte-identical.

Tests: 5 assertions on the injected shape — exactly one `system` message, the
role sequence unchanged, no message added or dropped, the notes before the
document context, earlier turns not rewritten. Negative-controlled: the
two-system version fails 3 of them.

### A-18 — FIXED in 0.5.0: Highlight could not be armed on its own; Erase deleted the wrong thing

User-reported 2026-10-16: "highlight 还是没法直接点亮和选择，我用了下发现只有先选中文件再选 highlight 才有用";
"擦除不是我理解的擦除，这个怎么是直接擦除上一笔，并不是我想要的擦除某一个位置".

**Highlight.** The button ran `doHighlight()`, which only acted when a DOM text
selection already existed and otherwise warned. It was an *action*, not a mode,
so it could not be pressed on its own. Now it always enters HIGHLIGHT mode
first — the button lights, the editor is in highlight mode, and dragging over
text highlights it — and if there happens to be a selection it highlights that
too, exactly as before. `highlightSelection()` also had a related defect: it
returned the document's *total* annotation count, so a failed highlight on a
document that already had highlights looked like a success. It now returns what
this call created.

**Erase.** The handler checked for a selection and deleted immediately. PDF.js
keeps a freshly drawn ink editor selected, so pressing Erase after drawing
removed *that stroke* — which reads as "it undid my last action" rather than "it
erases what I point at". PDF.js has no eraser editor and no public per-annotation
hit test, so the fix is a two-step contract:

1. pressing Erase **arms** it and deletes nothing, ever;
2. a click inside the page deletes only if it landed on an annotation — decided
   by `tools/erase-policy.ts`, a pure function whose whole rule set is "armed
   AND hit an annotation AND PDF.js selected something";
3. the hit test is a DOM check for `data-editor-rotation`, which every editor's
   root div carries. It deliberately does not touch `AnnotationEditorUIManager`'s
   private `#editors` map: if a future pdfjs-dist renames it, erasing degrades
   to "no hit" instead of throwing or deleting the wrong annotation;
4. it stays armed after a delete (removing several in a row is the common case),
   and `Escape` leaves the armed state.

Tests: 6 pure-function assertions including the full truth table (only
`armed ∧ hit ∧ selected` deletes) and a guard against a future "simplification"
to `armed && selected`, which is exactly the bug. The real-Chromium suite grew
to 12 assertions covering "pressing Erase deletes nothing", "a click on empty
paper deletes nothing (the leftover selection survives)", "clicking annotations
deletes them, repeatedly", and "after Escape, clicking deletes nothing".

### A-19 — NEW in 0.5.0: per-document reading memory (chunked summarisation)

Requested 2026-10-16: read a paper too long for one request by sending it in
chunks, keep the notes in a file beside the PDF, and load them next time so the
memory survives. The user chose: sidecar next to the PDF; both a manual button
and automatic appends after whole-document answers; raise the single-shot limit
first and chunk only what still does not fit.

* `whole-document` budget raised 120k → 160k characters (~50k tokens), still
  inside a 64k window. Deliberately not higher: past ~64k a gateway with a 64k
  window rejects the request outright, and a hard 400 is worse than a labelled
  truncation plus the chunked path.
* `src/ai/memory.ts` plans chunks (pure), asks per chunk for structured notes
  rather than prose, merges **only the notes** (never re-sending the paper) into
  one overview, and assembles the sidecar body reproducibly.
* `src-tauri/src/ai/memory.rs` owns the disk: a marker line identifies files we
  wrote, and **a target without the marker is refused** so a user's own
  hand-written `*.paperai-notes.md` is never overwritten. 2 MiB cap; temp-file +
  rename; oldest Q&A entries are trimmed rather than the write being refused.
* `ai_ask_once` collects a whole reply in Rust — reusing the streaming provider
  unchanged — because the pipeline must not store a half-received note as if it
  were complete.
* Notes come back as a `<reading_memory>` block framed as *prior background*
  with "以原文为准", capped at 20k characters, and **structurally escaped**: the
  note body goes through the same marker-neutralising as document text. The first
  version did not, and the test caught it — a note containing `</reading_memory>`
  could have closed the block early and the rest read as instructions.
* The panel shows a "阅读笔记" row: absent / enabled with size, coverage and
  time, and a busy state that disables the button so a long run cannot be
  started twice.

Tests: 11 Rust (path derivation, round trip, foreign-file refusal both ways, size
cap, append/trim, no stray temp file, timestamp, date conversion), 19 frontend
(chunk packing: every page exactly once, budget respected, oversized page kept,
blank pages free, empty document, reproducible document body, context escaping),
4 panel assertions for the memory row, and 2 real-socket tests that a collected
answer contains every delta.

### A-17 — FIXED in 0.4.4: formulas showed raw LaTeX; toolbar lit the wrong tool

User-reported 2026-10-16, two symptoms in one round.

**(a) The transcript showed raw LaTeX.** A whole-document answer came out with
`\[`, `\]`, `\varepsilon`, `\sum_i` visible as literal text, and formulas such
as `T_j^(k+1)` sat in the prose untypeset. Root cause: the renderer understood
`$$...$$` and `\(...\)` but **not `\[...\]`**, which is what models trained on
LaTeX documents actually emit for display math. A second, smaller defect: a
`$$...$$` pair *inside a line* fell through to the single-`$` inline rule, so it
rendered as a literal `$x$` — a display formula silently demoted to inline text
with two orphan `$` characters.

Fixes: `\[...\]` is now recognised both as a block (own line) and inline;
`$$...$$` inside a paragraph produces one `md-math-display` span and leaves no
stray dollar text; `$$` is matched before the single-`$` rule for exactly that
reason. Verified in a real browser with KaTeX enabled — the reported formula
now renders as `∣Tj(k+1)−Tj(k)∣<ε` with no raw marker.

**(b) The toolbar lied about the active tool.** Three defects, one cause —
the lit button was written in more than one place, or not at all:
* `Highlight` ran `doHighlight()` and never touched the indicator, so the user
  kept looking at a lit **Select** while the editor was in HIGHLIGHT mode;
* `Erase` had **no `tool` class** in `index.html`, so `setTool`'s
  `querySelectorAll(".tool")` sweep skipped it and it could never be lit —
  literally zero buttons active;
* `Erase` armed itself by entering ink mode, which lit **Draw**: pressing
  Erase appeared to activate a different tool.

Fixes: one `setToolbarState()` owns the indicator; `erase` is modelled as its
own toolbar state (it is an action, not a `ToolMode` — PDF.js has no eraser
editor, deleting needs a selected annotation) and is lit on its own button with
an extra `armed` style; `doHighlight` reports the mode the editor is actually
in; `Escape` leaves the armed state, and it stays armed after a delete so
several annotations can be removed in a row.

Tests: 7 new markdown assertions (delimiters and structure — with KaTeX off the
renderer *deliberately* prints the formula source, so the tests assert markers
and element structure, never "no LaTeX commands") and a real-Chromium suite
(`tests/toolbar-state.mjs`, 8 assertions) that reads the **real** toolbar markup
out of `index.html` rather than a hand-typed copy.

Negative controls: removing the `\[...\]` support fails 3 markdown assertions
with exactly the reported symptom (`收敛判据 \[|T_j^{(k+1)}...`); removing the
`tool` class from Erase and the indicator update from `doHighlight` fails 5 of
8 browser assertions, with `btn-erase->[]` (no button lights at all).

### A-16 — FIXED in 0.4.3: long answers were cut off at exactly 15 s (user-reported)

User-reported 2026-10-16: a whole-document question on DeepSeek produced visible
thinking/reasoning output and was then interrupted with `ai_timeout`
("连接超时。请检查网络、代理或 Base URL。") — while the network was fine.

Root cause: `run_chat` put `.timeout(CONNECT_TIMEOUT)` on the **streaming**
request. In `reqwest`, `RequestBuilder::timeout()` is a *total* deadline —
"applied from when the request starts connecting until the response body has
finished" — and it overrides the client-level setting. `CONNECT_TIMEOUT` is 15 s,
so **every completion longer than 15 seconds was truncated mid-answer** and
reported as a transport timeout. The client had the same mistake at a larger
scale (`.timeout(IDLE_TIMEOUT)` = a 120 s total, not an idle, timeout).

This is inherent to total deadlines on streams: a reasoning model spends its
first phase emitting `reasoning_content`, and a whole-document summary is slow
by nature. A total deadline does not protect a stream, it truncates it.

Fixes:

* `client::build_client` no longer sets any total timeout. It uses
  `connect_timeout` for the TCP/TLS phase and `read_timeout` for each
  individual read (which resets after every successful read), so a live but
  slow stream is never cut off.
* The per-request `.timeout(CONNECT_TIMEOUT)` is gone from `run_chat`. Stall
  protection lives in the event loop, where it can tell the two failure modes
  apart: nothing received at all (`ai_first_token_timeout`, "check the Base URL
  and model") versus output that stopped half-way (`ai_timeout`, "interrupted
  during generation, retry or use a smaller context"). Before, both said
  "waiting for the model timed out", which is false in the second case.
* The exchange as a whole is deliberately unbounded — the user can press stop,
  and any cap here would be a silent truncation. Documented in the module
  comment so the next reader does not "fix" it back.
* `probe_connection` / `list_models` **keep** a total budget (`PROBE_TIMEOUT`):
  those are small non-streaming requests where a whole-exchange deadline is
  correct. They now carry a comment saying which case they are, because the
  distinction is what caused this bug.
* The frontend no longer discards a partial answer: text that arrived before
  the failure stays on screen above the error box, marked "以上是中断前已生成的
  内容". `humanError` now prefers the backend's specific wording for the two
  timeout codes instead of flattening both into "check your network".

Tests: `a_long_stream_is_not_truncated_mid_answer` drives a real socket against
a mock that streams 24 chunks at 900 ms (~21 s, never idle for more than a
second) and asserts all 24 arrive; `a_stream_that_stops_mid_answer_is_reported_
as_interrupted` asserts the opposite case — content then silence — is reported
as an interruption and keeps its text. Plus 7 frontend assertions for the
partial-content and error-wording behaviour.

Negative control: restoring `.timeout(Duration::from_secs(15))` makes the long
stream test fail **at 15.02 s**, reproducing the user's failure exactly; the
panel-side control (removing the partial-content block) fails the two frontend
assertions that cover it.

### A-15 — FIXED in 0.4.2: the panel could not switch provider or model (user-reported)

User-reported 2026-10-16: the AI panel header showed `DeepSeek（升级前配置）· dee…`
as static text with no way to change it, so the app always answered with whichever
profile happened to be the default.

Root cause: `ChatPanel` had a `setModelLabel(text)` that wrote a `<span>`. The
pickers lived only in the settings dialog, and `main.ts` always resolved the
active profile as `current ?? is_default ?? first`.

Fix:

* The header now carries two real `<select>` elements — `ai-profile-select` and
  `ai-model-select` — and `setModelLabel` is gone.
* Switching provider re-points the chat session at that profile; switching model
  is **persisted through `ai_save_profile`**, because the request path reads the
  model from the saved profile and an in-memory choice would revert on restart.
* The model box always keeps the model currently in use, even when the live
  catalogue omits it (marked `当前（不在列表中）`), filters `incompatible` models,
  shows a loading/failure note instead of an empty box, and both controls freeze
  while a request is in flight.
* `main.ts` caches one catalogue per provider (keyed by base URL, so editing the
  URL in settings invalidates it) and drops a late reply that lost a provider race.

Tests: 12 DOM-shim unit assertions (`tests/ai-unit/panel-picker.test.mjs`) and 9
real-Chromium assertions (`tests/panel-model-switch.mjs`, real stylesheet inlined,
geometry asserted — two pickers plus three buttons must fit the 380px panel).
Both suites were negative-controlled: removing the change handlers fails 2 of 12,
and putting the old `<span>` back fails Q1/Q2 in the browser suite.

### A-14 — OPEN (provider-side, not fixable here): Zen free models reject PaperAI with 403 FreeTierError

User-reported 2026-10-16: the `opencode-zen` preset (default model
`deepseek-v4.1-flash-free`, no API key configured) fails the connection test
with `403 FreeTierError — OpenCode's free tier can only be used from within
OpenCode` (`ai_unauthorized`).

This is an **OpenCode server-side policy**, not a PaperAI defect:

* Since ~2026-09-16 the anonymous free lane on `https://opencode.ai/zen/v1`
  rejects every request that does not originate from the official OpenCode
  client. Probed gates included client User-Agent, `ses_`-shaped session ids,
  required `bash`/`read` tool stubs in the body, and caller IP reputation.
* Third-party clients that spoofed all of those (pi-opencode-zen,
  dsh-opencode-zen, …) worked briefly; the lane was fully closed to
  non-official clients by ~2026-09-23 and those plugins are now
  deprecated/archived by their own maintainers.
* The paid Zen lane (`zen/v1` with a funded API key) and the OpenCode Go
  subscription lane (`inference/go/v1`) remain open to external clients —
  both already work in PaperAI.

Decision: no workaround is implemented. Spoofing a third party's client
identity to consume its free tier is both against the provider's intent and
fragile (already proven dead upstream). Users who want free models use them
inside the OpenCode app; users who want in-app AI use DeepSeek official,
OpenCode Go (subscription), or a funded Zen key on paid models. The server's
own message is surfaced verbatim in the settings status area, which is the
honest explanation. Documented in the `opencode_zen_preset` doc comment.

---

## Carried over from Phase 2, still open

| ID | Item | Status |
|---|---|---|
| K-05 | Windows focus stealing is best-effort | open, untested here |
| K-06 | PDF.js version coupling | open, `pdfjs-dist` pinned at 6.4.299 |
| K-08 | `cargo build` vs `tauri build` exe | open (documentation) |
| K-11 | Erase needs an editing mode first | open, unchanged |
| K-13 | CDP automation unavailable | **root-caused**, alternative path in use |
| K-14 | Test process leakage | **fixed** |
| — | Non-atomic save (two renames) | **mitigated**: recoverable, not atomic |

## Fixed in this round

| ID | Item |
|---|---|
| K-03 | Test bridge removed from release builds (verified by bundle scan) |
| K-07 | `.old` / `.bak` / temp detection, validation, idempotent restore |
| K-14 | Every probe kills the process tree it started |
| A-12 | `[hidden]` beat by author `display:` rules — three overlays could not be hidden (real-Chromium test added) |
| A-13 | Installer nested the previous installers; source maps shipped. Deliverables moved to `release/`, `dist/` guarded |
| — | A document switch let a queued delta land in the *previous* document's transcript |
| — | `![alt](url)` rendered as a clickable link instead of an inert placeholder |
| — | URLs with balanced parentheses were truncated at the first `)` |
| — | `secrets.rs` compared an `HRESULT` against a raw Win32 code, so a missing key surfaced as `ai_secret_store` instead of `ai_no_key` |
| A-24 | The Zhipu free preset defaulted to a retired model id, and a 401-based probe could not have caught it |
| A-25 | The composer treated an input method's Enter (committing a candidate) as a send, making it unusable in Chinese |
| A-26 | Page text was read from the rendered DOM text layer, so extraction depended on scroll position and failed on freshly opened documents |
| A-27 | Ctrl+wheel zoom, anchored on the cursor. Left/right Ctrl is not distinguishable on a WheelEvent, so any Ctrl zooms |
| A-28 | Scanned documents have no text at all; whole-document image mode sends the pages as pictures, and text mode now refuses instead of sending an empty question |
| A-29 | A follow-up question in image mode re-sent the pages the history already carried, doubling the cost; pages the model can still see are now skipped |
| A-30 | Notes could not be generated from a scanned paper; the pipeline now reads the pages as images |
| A-31 | Conversations persist beside the PDF (JSON + content-addressed images), with timestamps |
| A-32 | Notes can stand in for the document in whole-document mode; history can be switched off. `slice(-0)` sent all history instead of none |
| A-33 | Enter while streaming was swallowed with no message (looked model-dependent); a keepalive-only stream never hit the idle timeout |
| A-34 | Markdown tables were never rendered; pipes arrived as literal text |
| A-35 | A restored turn saved mid-stream made the app permanently busy, so sending was dead from startup. Snapshots were taken after the guard |
| A-36 | A session created after the provider was chosen had no provider bound, so the first send was refused; `selection` was hardcoded as the default mode |
| B | 0.7.0: the model can call `read_page` to fetch one page image mid-answer, capped at 2 pages per question; tool calling rather than a text marker, because a document could forge a marker |
