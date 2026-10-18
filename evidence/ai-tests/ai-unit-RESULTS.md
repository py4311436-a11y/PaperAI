# Frontend AI unit tests

Generated: 2026-10-18T09:29:58.277Z
Runner: scripts/run-ai-unit-tests.mjs (compiles src/ai/*.ts with tsc, then node --test)
Compiled from: src/ai/context-builder.ts, chat-controller.ts, markdown-renderer.ts, types.ts

| Suite | Pass | Total |
|---|---|---|
| context + chat controller | 66 | 66 |
| markdown safety | 27 | 27 |
| panel provider/model picker | 21 | 21 |
| interrupted answer (A-16) | 11 | 11 |
| eraser policy (A-18) | 6 | 6 |
| reading memory chunking (A-19) | 28 | 28 |
| page text extraction (A-26) | 14 | 14 |
| ctrl+wheel zoom | 13 | 13 |
| whole-page images (A-28) | 18 | 18 |

**204/204 PASS**

These tests import the real sources, so they cannot drift from the shipped code.
