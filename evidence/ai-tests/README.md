# evidence/ai-tests

- `rust-provider-run.log` — full output of `scripts/run-ai-rust-tests.mjs`
- `rust-provider-RESULTS.md` — per-test table with the mock scenario used
- `rust-provider-requests.json` — every HTTP request the app made, as seen by
  the Mock SSE server. **The mock redacts `Authorization` before recording**, so
  this file contains no credential.

The request log is the authority for the privacy assertions: it shows exactly
which messages were sent. A test that claims "no PDF content was uploaded" must
point at a request here whose body contains only the user's question.
