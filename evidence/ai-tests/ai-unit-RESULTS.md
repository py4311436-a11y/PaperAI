# Frontend AI unit tests

Generated: 2026-10-16T09:15:03.479Z
Runner: scripts/run-ai-unit-tests.mjs (compiles src/ai/*.ts with tsc, then node --test)
Compiled from: src/ai/context-builder.ts, chat-controller.ts, markdown-renderer.ts, types.ts

| Suite | Pass | Total |
|---|---|---|
| context + chat controller | 37 | 37 |
| markdown safety | 27 | 27 |
| panel provider/model picker | 16 | 16 |
| interrupted answer (A-16) | 11 | 11 |
| eraser policy (A-18) | 6 | 6 |
| reading memory chunking (A-19) | 19 | 19 |

**116/116 PASS**

These tests import the real sources, so they cannot drift from the shipped code.
