# AI architecture — PaperAI 0.3.0

## Layering

The rule from the PDF side carries over unchanged: **one door per direction.**

```
┌─ frontend (src/) ──────────────────────────────────────────────┐
│  main.ts                 shell: toolbar, dirty policy, wiring   │
│  ai/context-builder.ts   question + mode -> message list        │
│  ai/chat-controller.ts   state machine, per-document sessions   │
│  ai/chat-panel.ts        the panel; renders, never decides      │
│  ai/markdown-renderer.ts DOM nodes only; no HTML strings        │
│  ai/selection-*.ts       capture before focus steal             │
│  bridge.ts               THE ONLY place that calls invoke()     │
└────────────────────────────┬───────────────────────────────────┘
                             │  profileId + visible text + requestId
                             │  ← AiStreamEvent (channel)
┌────────────────────────────┴───────────────────────────────────┐
│  src-tauri/src/ai/                                             │
│   mod.rs        IPC commands                                    │
│   settings.rs   profiles (JSON, no secrets) + DeepSeek preset    │
│   secrets.rs    Windows Credential Manager; no read-back command │
│   config.rs     base-URL policy and normalisation               │
│   client.rs     reqwest/rustls, redirects OFF, timeouts          │
│   provider.rs   OpenAI-compatible Chat Completions + streaming   │
│   stream.rs     incremental SSE parser (pure)                    │
│   session.rs    cancellation registry                            │
└─────────────────────────────────────────────────────────────────┘
                             │ HTTPS, Bearer injected here
                             ▼
                    DeepSeek / any OpenAI-compatible endpoint
```

Two invariants fall out of this shape:

* **The key never crosses the IPC boundary.** There is no `get_api_key`
  command. The frontend can set, test-for-existence and delete a credential;
  only `secrets::read_secret` (crate-private) can read it, and its only caller
  is the HTTP client building the `Authorization` header.
* **The frontend never speaks HTTP.** It has no URL to fetch, no header to
  build. Adding a provider cannot accidentally send document text anywhere.

## The wire shapes

```ts
interface AIProfile {            // persisted, no secret
  id: string; displayName: string;
  baseUrl: string;               // normalised, e.g. https://api.deepseek.com/v1
  model: string;                 // fully editable — never hard-coded
  credentialId: string;          // names the Credential Manager entry
}

type ContextMode = 'none' | 'selection' | 'current-page' | 'nearby-pages';

type AIStreamEvent =
  | { type: 'started' }
  | { type: 'delta'; text: string }
  | { type: 'completed'; finish_reason: string | null }
  | { type: 'cancelled' }
  | { type: 'error'; code: string; safe_message: string };
```

One request produces **exactly one terminal event**. The controller enforces
this on the receiving side as well, so a chatty provider cannot leave the UI
saying "generating" forever.

## Request construction

The body is deliberately minimal:

```json
{ "model": "...", "messages": [...], "stream": true }
```

No `tools`, `response_format`, `top_p`, `thinking` or `reasoning_effort`. Many
"OpenAI-compatible" gateways reject unknown fields, and some bill differently
when reasoning flags are present. A unit test asserts the exact key set.

Base-URL joining handles the three shapes users actually type without ever
producing `/v1/v1` or `//chat/completions`:

| typed | requested |
|---|---|
| `https://api.deepseek.com` | `…/chat/completions` |
| `https://api.deepseek.com/v1` | `…/v1/chat/completions` |
| `https://api.deepseek.com/v1/` | `…/v1/chat/completions` |
| `…/v1/chat/completions` | unchanged |

## Streaming and cancellation

`provider.rs` runs a `tokio::select!` loop with `biased` ordering over three
futures: the cancel watch, the next network chunk, and an idle deadline.

Cancellation is a `tokio::sync::watch` channel, not a boolean polled between
chunks — a provider that stalls would otherwise never be interrupted. When the
watch fires, the loop returns and **drops the HTTP body**, which closes the
connection instead of waiting for bytes that may never come.

The idle deadline is reset on every chunk, so it doubles as a first-token
timeout and a mid-stream stall detector.

## Selection capture — the ordering that matters

The failure this code exists to avoid:

```
user drags out a selection
  → floating bar appears
  → user clicks 「解释」
  → the button takes focus
  → window.getSelection() is now EMPTY
  → an empty prompt is sent
```

Three things prevent it:

1. `selection-bar.ts` calls `preventDefault()` on `pointerdown` **and**
   `mousedown` for every control, so focus never moves.
2. `installSelectionTracking` snapshots on `selectionchange` and `pointerup`,
   well before any UI reacts.
3. `askWithPreset` re-captures at click time and **refuses** when the snapshot
   is not from the currently-open document.

And a fourth, quieter one: `captureSelection` returns `null` rather than an
empty snapshot, so no caller can "helpfully" fall back to sending the whole
document.

## Context building

| mode | sends | gate |
|---|---|---|
| `none` | the question + history only | always available |
| `selection` | the selected text + page numbers | requires a live PDF selection |
| `current-page` | that page's extractable text | user must choose the mode |
| `nearby-pages` | p-1, p, p+1 (clamped) | user must choose the mode |

Document text is wrapped in `<document_context>…</document_context>`. The
wrapper is load-bearing, so `escapeForContext` neutralises any lookalike inside
the payload (any case, optional whitespace) and a test asserts **exactly one**
opening and one closing tag survive regardless of input.

Only the display title and page numbers travel — never an absolute path.

The character budget is 26 000 by default, truncated at a paragraph or sentence
boundary and flagged to the UI rather than silently cut.

## Markdown and LaTeX

`markdown-renderer.ts` builds DOM nodes and never creates an HTML string. Model
output reaches the page exclusively through `textContent`, so the parser has no
step for an attacker to subvert:

* `<script>` in an answer is displayed as the literal text `<script>`.
* Images are **never** loaded — a remote image is a tracking beacon — and
  `![alt](url)` renders as an explicit inert placeholder.
* `javascript:` and `data:` links become blocked text; `https` links become an
  anchor **with no `href`**, so rendering cannot navigate and only a real click
  calls `onOpenLink`.
* KaTeX runs with `trust: false`, `throwOnError: false`, and its fonts are
  bundled locally (the built CSS contains no CDN reference).

## Chat state machine

```
idle → preparing → streaming → completed
                 ↘ error
                 ↘ cancelling → cancelled
```

Per-document sessions: each open document gets its own transcript, context mode
and in-flight request id. Switching documents **retires** the outgoing request:
it is cancelled, its `activeRequestId` is cleared, and the controller's
generation counter is incremented so any delta already sitting in the event
queue is dropped. Without that last step a queued delta lands in the *original*
document's transcript after the user has left it.

## What 0.3.0 deliberately does not do

RAG, embeddings, full-text indexing, whole-PDF summarisation, OCR, cloud
accounts, background upload, cross-paper Q&A, and AI-driven PDF edits. The
scope is a careful minimum: read, annotate, ask about what you selected.
