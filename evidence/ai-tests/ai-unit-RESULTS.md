# Frontend AI unit tests

Generated: 2026-10-22T09:24:17.894Z
Runner: scripts/run-ai-unit-tests.mjs (compiles src/ai/*.ts with tsc, then node --test)
Compiled from: src/ai/context-builder.ts, chat-controller.ts, markdown-renderer.ts, types.ts

| Suite | Pass | Total |
|---|---|---|
| context + chat controller | 80 | 80 |
| markdown safety | 37 | 37 |
| panel provider/model picker | 21 | 21 |
| interrupted answer (A-16) | 28 | 28 |
| eraser policy (A-18) | 6 | 6 |
| reading memory chunking (A-19) | 33 | 33 |
| page text extraction (A-26) | 14 | 14 |
| ctrl+wheel zoom | 13 | 13 |
| whole-page images (A-28) | 41 | 41 |
| chat history store (A-31) | 19 | 19 |
| tool call planning (B) | 22 | 22 |
| memory body split (A-41) | 9 | 9 |
| region text (A-42) | 13 | 13 |
| translation intent (A-42) | 5 | 5 |

**341/341 PASS**

These tests import the real sources, so they cannot drift from the shipped code.
