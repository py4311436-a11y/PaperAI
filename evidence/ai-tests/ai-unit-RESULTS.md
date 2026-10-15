# Frontend AI unit tests

Generated: 2026-10-15T13:46:24.351Z
Runner: scripts/run-ai-unit-tests.mjs (compiles src/ai/*.ts with tsc, then node --test)
Compiled from: src/ai/context-builder.ts, chat-controller.ts, markdown-renderer.ts, types.ts

| Suite | Pass | Total |
|---|---|---|
| context + chat controller | 28 | 28 |
| markdown safety | 20 | 20 |

**48/48 PASS**

These tests import the real sources, so they cannot drift from the shipped code.
