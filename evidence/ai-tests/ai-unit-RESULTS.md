# Frontend AI unit tests

Generated: 2026-10-18T08:04:13.569Z
Runner: scripts/run-ai-unit-tests.mjs (compiles src/ai/*.ts with tsc, then node --test)
Compiled from: src/ai/context-builder.ts, chat-controller.ts, markdown-renderer.ts, types.ts

| Suite | Pass | Total |
|---|---|---|
| context + chat controller | 63 | 63 |
| markdown safety | 27 | 27 |
| panel provider/model picker | 21 | 21 |
| interrupted answer (A-16) | 11 | 11 |
| eraser policy (A-18) | 6 | 6 |
| reading memory chunking (A-19) | 28 | 28 |
| page text extraction (A-26) | 14 | 14 |
| ctrl+wheel zoom | 13 | 13 |

**183/183 PASS**

These tests import the real sources, so they cannot drift from the shipped code.
