/**
 * Local OpenAI-compatible Mock provider, for end-to-end AI tests.
 *
 * Deliberately a plain Node http server with no dependencies so it can be
 * started from any test with one call, and so its behaviour is auditable: every
 * fault-injection knob is explicit and named.
 *
 * It records every request it receives (path, headers with the Authorization
 * value REDACTED, parsed body) so tests can assert exactly what the app sent —
 * which is how we prove "no PDF content was uploaded" and "the key never left
 * Rust in a readable form".
 *
 * Usage:
 *   const mock = await startMockProvider({ scenario: 'happy' });
 *   // ... run the app against mock.baseUrl ...
 *   mock.requests; mock.stop();
 */
import http from "node:http";

const DEFAULT_MODEL = "mock-model";

/** Split a string into chunks that split multi-byte characters on purpose. */
function brutalChunks(text, size) {
  const bytes = Buffer.from(text, "utf8");
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

function sseChunk(model, delta, extra = {}) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

/**
 * Scenario definitions. Each returns the list of raw byte buffers to write,
 * plus an optional status/headers override.
 */
const scenarios = {
  /** Normal stream, then [DONE]. */
  happy: (model) => ({
    status: 200,
    buffers: [
      Buffer.from(sseChunk(model, { role: "assistant", content: "" })),
      Buffer.from(sseChunk(model, { content: "这是" })),
      Buffer.from(sseChunk(model, { content: "一段回答。" })),
      Buffer.from(sseChunk(model, {}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })),
      Buffer.from("data: [DONE]\n\n"),
    ],
  }),

  /** Two events inside one TCP chunk. */
  batched: (model) => ({
    status: 200,
    buffers: [
      Buffer.from(sseChunk(model, { content: "A" }) + sseChunk(model, { content: "B" })),
      Buffer.from("data: [DONE]\n\n"),
    ],
  }),

  /** Chinese text cut mid-character across chunk boundaries. */
  splitUtf8: (model) => ({
    status: 200,
    buffers: [
      ...brutalChunks(sseChunk(model, { content: "中文流式测试" }), 7),
      Buffer.from("data: [DONE]\n\n"),
    ],
  }),

  /** CRLF line endings and comment keep-alives. */
  crlfAndComments: (model) => ({
    status: 200,
    buffers: [
      Buffer.from(": keep-alive\n\n"),
      Buffer.from(sseChunk(model, { content: "crlf" }).replace(/\n/g, "\r\n")),
      Buffer.from("data: [DONE]\r\n\r\n"),
    ],
  }),

  /** Empty choices and a usage-only tail, then DONE without content. */
  emptyThenUsage: (model) => ({
    status: 200,
    buffers: [
      Buffer.from(`data: ${JSON.stringify({ choices: [], model })}\n\n`),
      Buffer.from(`data: ${JSON.stringify({ choices: [], model, usage: { total_tokens: 5 } })}\n\n`),
      Buffer.from("data: [DONE]\n\n"),
    ],
  }),

  /** Socket closes without [DONE] after real content. */
  noDone: (model) => ({
    status: 200,
    buffers: [Buffer.from(sseChunk(model, { content: "没有DONE的完整回答" }))],
  }),

  /** Socket closes with nothing at all. */
  abruptEmpty: () => ({ status: 200, buffers: [] }),

  /** An error object delivered *inside* a 200 stream. */
  midStreamError: (model) => ({
    status: 200,
    buffers: [
      Buffer.from(sseChunk(model, { content: "开始" })),
      Buffer.from(`data: ${JSON.stringify({ error: { code: "server_busy", message: "服务繁忙" } })}\n\n`),
    ],
  }),

  /** Non-SSE body that looks like success — the "empty answer" trap. */
  notSse: () => ({ status: 200, buffers: [Buffer.from("this is not an event stream")] }),

  /** The requested model does not exist. */
  modelNotFound: () => ({
    status: 404,
    json: { error: { message: "The model `nope` does not exist", type: "invalid_request_error" } },
  }),

  unauthorized: () => ({ status: 401, json: { error: { message: "Invalid API key" } } }),
  forbidden: () => ({ status: 403, json: { error: { message: "Forbidden" } } }),
  rateLimited: () => ({ status: 429, json: { error: { message: "Rate limit reached" } } }),
  serverError: () => ({ status: 500, json: { error: { message: "internal" } } }),
  badRequest: () => ({ status: 400, json: { error: { message: "bad payload" } } }),

  /** A 302 to a different host — must not be followed with the key. */
  redirect: () => ({
    status: 302,
    headers: { Location: "https://evil.example.com/v1/chat/completions" },
    buffers: [],
  }),

  /** Answer content that attempts to break the renderer / inject instructions. */
  maliciousContent: (model) => ({
    status: 200,
    buffers: [
      Buffer.from(
        sseChunk(model, {
          content:
            '<script>window.__pwned=1</script>' +
            '<img src="https://tracker.example.com/pixel.png">' +
            "[click](javascript:alert(1))" +
            '<iframe src="https://evil.example.com"></iframe>' +
            "正常文本继续",
        })
      ),
      Buffer.from("data: [DONE]\n\n"),
    ],
  }),

  /** Slow stream: yields tokens over several seconds so cancel can be tested. */
  slow: (model) => ({
    status: 200,
    slow: true,
    makeBuffers: () => [
      Buffer.from(sseChunk(model, { content: "第一段。" })),
      Buffer.from(sseChunk(model, { content: "第二段。" })),
      Buffer.from(sseChunk(model, { content: "第三段。" })),
      Buffer.from(sseChunk(model, { content: "第四段。" })),
      Buffer.from("data: [DONE]\n\n"),
    ],
    gapMs: 900,
  }),

  /** Never sends anything: used for the first-token timeout. */
  stall: () => ({ status: 200, stall: true, buffers: [] }),

  /**
   * A-16: a LONG but perfectly healthy stream.
   *
   * 24 chunks, one every 900 ms => ~21 s in total, which is well past the
   * 15 s that `RequestBuilder::timeout(CONNECT_TIMEOUT)` used to impose. This is
   * the shape of a real reasoning-model answer on a whole document: slow, but
   * never idle. Any total deadline truncates it; an idle deadline does not.
   */
  longHealthy: (model) => ({
    status: 200,
    slow: true,
    makeBuffers: () => {
      const out = [];
      for (let i = 1; i <= 24; i++) {
        out.push(Buffer.from(sseChunk(model, { content: `第${i}段内容。` })));
      }
      out.push(Buffer.from("data: [DONE]\n\n"));
      return out;
    },
    gapMs: 900,
  }),

  /**
   * A-16: output stops half-way and the connection is then held open forever.
   *
   * The provider is not slow here, it is gone: nothing more will ever arrive.
   * Only a stall/idle deadline can catch this, and the app must say the answer
   * was interrupted rather than that it never received anything.
   */
  stallAfterContent: (model) => ({
    status: 200,
    slow: true,
    makeBuffers: () => [
      Buffer.from(sseChunk(model, { content: "开头写了一段内容，" })),
      Buffer.from(sseChunk(model, { content: "然后就断了。" })),
      // No [DONE], and the socket stays open — the loop must time out.
    ],
    gapMs: 300,
    stallAfterAll: true,
  }),
};

/**
 * @param {object} opts
 * @param {string} [opts.scenario]
 * @param {number} [opts.port]  0 = pick a free port
 */
export async function startMockProvider(opts = {}) {
  const scenario = opts.scenario ?? "happy";
  const requests = [];
  let stopped = false;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      // Record the request with the credential REDACTED, so the log itself is
      // safe to archive as evidence.
      const headers = { ...req.headers };
      if (headers.authorization) {
        const v = String(headers.authorization);
        headers.authorization = v.startsWith("Bearer ")
          ? `Bearer <redacted:${v.length - 7}chars>`
          : "<redacted>";
      }
      requests.push({
        method: req.method,
        url: req.url,
        headers,
        body,
        rawBodyLength: rawBody.length,
        at: Date.now(),
      });

      const spec = (scenarios[scenario] ?? scenarios.happy)(body?.model ?? DEFAULT_MODEL);

      const sendJson = () => {
        res.writeHead(spec.status, { "Content-Type": "application/json", ...(spec.headers || {}) });
        res.end(JSON.stringify(spec.json ?? {}));
      };

      if (spec.status !== 200) return sendJson();
      if (spec.json) return sendJson();

      if (spec.stall) {
        // Headers only; the connection stays open and no body arrives.
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(spec.headers || {}),
      });

if (spec.slow) {
      const buffers = spec.makeBuffers();
      let i = 0;
      const tick = () => {
        if (stopped || res.destroyed || i >= buffers.length) {
          // `stallAfterAll` deliberately keeps the socket open with no further
          // bytes: that is what a provider dying mid-answer looks like, and the
          // client's stall deadline is the only thing that can end it.
          if (!res.destroyed && !spec.stallAfterAll) res.end();
          return;
        }
        res.write(buffers[i++]);
        setTimeout(tick, spec.gapMs ?? 500);
      };
      tick();
      return;
    }

      for (const b of spec.buffers) res.write(b);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    scenario,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    /** OpenAI-compatible endpoint path the app is expected to POST to. */
    chatPath: "/chat/completions",
    requests,
    /** Requests whose body mentions any of these strings. */
    requestsMentioning(needles) {
      return requests.filter((r) => needles.some((n) => r.rawBodyLength > 0 && JSON.stringify(r.body).includes(n)));
    },
    /** Bodies of every request, for asserting what was (not) sent. */
    bodies() {
      return requests.map((r) => r.body);
    },
    /** Count of requests that actually carried a message list. */
    chatRequestCount() {
      return requests.filter((r) => r.body && Array.isArray(r.body.messages)).length;
    },
    stop() {
      stopped = true;
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export const SCENARIOS = Object.keys(scenarios);

// Allow `node tests/ai-mock/server.mjs --scenario slow --port 8788` for manual runs.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const argOf = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const m = await startMockProvider({
    scenario: argOf("scenario", "happy"),
    port: Number(argOf("port", 8788)),
  });
  console.log(`mock provider scenario=${m.scenario} on ${m.baseUrl}`);
  console.log(`POST ${m.baseUrl}/v1/chat/completions`);
}
