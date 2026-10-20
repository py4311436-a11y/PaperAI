# Frontend AI unit tests

Generated: 2026-10-20T11:21:26.414Z
Runner: scripts/run-ai-unit-tests.mjs (compiles src/ai/*.ts with tsc, then node --test)
Compiled from: src/ai/context-builder.ts, chat-controller.ts, markdown-renderer.ts, types.ts

| Suite | Pass | Total |
|---|---|---|
| context + chat controller | 78 | 78 |
| markdown safety | 37 | 37 |
| panel provider/model picker | 21 | 21 |
| interrupted answer (A-16) | 24 | 24 |
| eraser policy (A-18) | 6 | 6 |
| reading memory chunking (A-19) | 33 | 33 |
| page text extraction (A-26) | 14 | 14 |
| ctrl+wheel zoom | 13 | 13 |
| whole-page images (A-28) | 39 | 39 |
| chat history store (A-31) | 19 | 19 |
| tool call planning (B) | 21 | 21 |
| memory body split (A-41) | 9 | 9 |
| region text (A-42) | 13 | 13 |
| translation intent (A-42) | 5 | 5 |

**332/332 PASS**

These tests import the real sources, so they cannot drift from the shipped code.
