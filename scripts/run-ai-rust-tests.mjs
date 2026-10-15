/**
 * Runs the Rust provider integration suite against the local Mock SSE server.
 *
 * Why a runner instead of plain `cargo test`: the suite needs a *real* provider
 * on the other end of a socket, and several tests need the mock to be serving a
 * specific scenario. Cargo runs tests in parallel threads and has no hook for
 * "restart the mock between scenarios", so we run one scenario per cargo
 * invocation with a filtered test name.
 *
 * Every request the mock received is appended to evidence/ai-tests/, which is
 * how we prove what the app did and did not send (no PDF content when the user
 * did not ask, Authorization present, etc.).
 *
 * Usage: node scripts/run-ai-rust-tests.mjs [--filter <substring>]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { startMockProvider } from "../tests/ai-mock/server.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const EVIDENCE = path.join(ROOT, "evidence", "ai-tests");
mkdirSync(EVIDENCE, { recursive: true });

const only = (() => {
  const i = process.argv.indexOf("--filter");
  return i >= 0 ? process.argv[i + 1] : null;
})();

/** test-name substring -> scenario the mock must serve. */
const PLAN = [
  ["happy_path_streams_and_completes", "happy"],
  ["batched_events_in_one_packet", "batched"],
  ["utf8_split_across_chunks_is_not_corrupted", "splitUtf8"],
  ["crlf_and_comment_lines", "crlfAndComments"],
  ["empty_choices_and_usage_only_tail_do_not_error", "emptyThenUsage"],
  ["missing_done_is_a_success_when_content_arrived", "noDone"],
  ["abrupt_close_without_content_is_an_error_not_a_silent_success", "abruptEmpty"],
  ["in_stream_error_object_terminates_with_error", "midStreamError"],
  ["non_sse_200_is_reported_as_bad_stream", "notSse"],
  ["http_401_maps_to_unauthorized", "unauthorized"],
  ["http_403_maps_to_unauthorized", "forbidden"],
  ["http_404_maps_to_not_found_with_a_url_hint", "modelNotFound"],
  ["http_429_maps_to_rate_limited", "rateLimited"],
  ["http_500_maps_to_provider_error", "serverError"],
  ["http_400_maps_to_bad_config", "badRequest"],
  ["redirect_is_not_followed", "redirect"],
  ["missing_key_fails_before_any_network_call", "happy"],
  ["plain_http_to_a_remote_host_is_refused", "happy"],
  ["cancel_stops_the_stream_promptly", "slow"],
  ["context_is_sent_verbatim_and_nothing_else", "happy"],
];

/** Async spawn: `spawnSync` would block this process's event loop, and the
 *  Mock SSE server lives in this very process — it would never accept the
 *  connection. That mistake produced 20 spurious "timeout" failures. */
function runCargo(args, env) {
  return new Promise((resolve) => {
    const child = spawn("cargo", args, {
      cwd: path.join(ROOT, "src-tauri"),
      env,
      shell: false,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => child.kill(), 300000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `spawn error: ${e.message}` });
    });
  });
}

const results = [];
const requestLog = [];

for (const [test, scenario] of PLAN) {
  if (only && !test.includes(only)) continue;

  const mock = await startMockProvider({ scenario });
  const env = {
    ...process.env,
    PAPERAI_MOCK_BASE: mock.baseUrl,
    PAPERAI_MOCK_SCENARIO: scenario,
  };

  const { out } = await runCargo(
    ["test", "--test", "ai_provider", test, "--", "--exact", "--nocapture"],
    env
  );

  const passed = /test result: ok\.\s*1 passed/.test(out);
  const skipped = /BUT PAPERAI_MOCK_BASE|refusing to report/i.test(out);

  // Archive what the mock saw, with the credential already redacted by the mock.
  for (const req of mock.requests) {
    requestLog.push({
      test,
      scenario,
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
      contentType: req.headers["content-type"] ?? null,
      accept: req.headers.accept ?? null,
      body: req.body,
    });
  }

  results.push({ test, scenario, passed, skipped, requests: mock.requests.length });
  const mark = passed ? "PASS" : skipped ? "BLOCKED" : "FAIL";
  console.log(`[${mark.padEnd(8)}] ${test}  (mock=${scenario}, ${mock.requests.length} req)`);
  if (!passed) {
    console.log(
      out
        .split(/\r?\n/)
        .filter((l) => /panicked|assertion|expected|error\[|test result/.test(l))
        .slice(0, 6)
        .map((l) => "            " + l.trim())
        .join("\n")
    );
  }

  await mock.stop();
}

writeFileSync(
  path.join(EVIDENCE, "rust-provider-requests.json"),
  JSON.stringify(requestLog, null, 2),
  "utf8"
);

const total = results.length;
const ok = results.filter((r) => r.passed).length;
writeFileSync(
  path.join(EVIDENCE, "rust-provider-RESULTS.md"),
  [
    "# Rust provider integration suite (against local Mock SSE)",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Runner: scripts/run-ai-rust-tests.mjs`,
    "",
    "| Test | Mock scenario | Result | Requests seen by mock |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.test} | ${r.scenario} | **${r.passed ? "PASS" : "FAIL"}** | ${r.requests} |`),
    "",
    `**${ok}/${total} PASS**`,
    "",
    "The mock redacts `Authorization` before recording, so",
    "`rust-provider-requests.json` is safe to archive as evidence.",
    "",
  ].join("\n"),
  "utf8"
);

console.log(`\n${ok}/${total} PASS — evidence in evidence/ai-tests/`);
process.exit(ok === total ? 0 : 1);
