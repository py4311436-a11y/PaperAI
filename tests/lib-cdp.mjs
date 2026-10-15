/**
 * Minimal CDP client over Node's built-in WebSocket.
 *
 * Why not puppeteer: in this environment puppeteer attaches to the WebView2
 * page target too late (only about:blank is visible at connect time), and calls
 * made through a late-attached session hang. Speaking raw CDP to the *page*
 * endpoint works reliably and is enough for everything this suite needs:
 * evaluate, real mouse input, and screenshots.
 */
export class CdpPage {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map(); // method -> [handlers]
    this.closed = false;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.events.get(msg.method) ?? []) h(msg.params);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  /**
   * Attach to a Tauri WebView2 page through the BROWSER endpoint with a
   * flattened session. Connecting straight to the page socket races with the
   * navigation commit and hangs.
   */
  static async attachTauriPage(port, timeoutMs = 60000) {
    const browserWs = await waitBrowserEndpoint(port, timeoutMs);
    const ws = new WebSocket(browserWs);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws connect timeout")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws connect error")); }, { once: true });
    });

    // bootstrap transport before the session id exists
    const boot = new CdpPage(ws, undefined);
    const { targetInfos } = await boot.send("Target.getTargets");
    const hit = targetInfos.find((t) => t.type === "page" && !/^about:blank/.test(t.url));
    if (!hit) throw new Error(`no tauri page target (saw: ${targetInfos.map((t) => t.url).join(", ")})`);

    const { sessionId } = await boot.send("Target.attachToTarget", { targetId: hit.targetId, flatten: true });
    const page = new CdpPage(ws, sessionId);
    page.appUrl = hit.url;
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    return page;
  }

  static async connect(url, timeoutMs = 20000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws connect timeout")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error("ws connect error")); }, { once: true });
    });
    const page = new CdpPage(ws);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    return page;
  }

  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(handler);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.id;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 120000);
    });
  }

  /** Evaluate an expression; `awaitPromise` makes async results resolve. */
  async eval(expression, awaitPromise = true) {
    // NOTE: `userGesture` is deliberately omitted — this WebView2 build
    // rejects the whole call with -32602 when it is supplied.
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = d.exception?.description ?? d.text ?? "unknown exception";
      throw new Error(`page threw: ${text.slice(0, 500)}`);
    }
    return r.result?.value;
  }

  /**
   * Move the mouse. `buttons` must be 1 while a drag is in progress —
   * otherwise Chromium treats the stream as hover and never selects text or
   * draws ink (this cost a full debugging cycle; do not "simplify" it away).
   */
  async mouseMove(x, y, buttons = 0) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: buttons ? "left" : "none",
      buttons,
    });
  }

  async mouseDown(x, y) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
  }

  async mouseUp(x, y) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
  }

  async click(x, y) {
    await this.mouseMove(x, y, 0);
    await this.mouseDown(x, y);
    await this.mouseUp(x, y);
  }

  async drag(from, to, steps = 10, delayMs = 20) {
    await this.mouseMove(from.x, from.y, 0);
    await this.mouseDown(from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.mouseMove(x, y, 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    await this.mouseUp(to.x, to.y);
  }

  async screenshot() {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return Buffer.from(r.data, "base64");
  }

  /**
   * Poll `expression` until it returns a truthy value.
   * Avoids Runtime.evaluate-with-awaitPromise hangs on long waits.
   */
  async waitFor(expression, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        last = await this.eval(expression, true);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      if (Date.now() > end) throw new Error(`timeout waiting for ${label ?? expression} (last: ${String(last).slice(0, 200)})`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * Browser arguments needed to drive a Tauri WebView2 from an automation host.
 *
 * Without these the renderer gets suspended: the page loads, JS runs to the
 * point of registering its event listeners, and then Runtime.evaluate never
 * returns. Cause is WebView2 treating the window as occluded in a session that
 * has no interactive compositor. Verified by probe/cdp-throttle.mjs.
 */
export function webview2AutomationArgs(port) {
  return [
    `--remote-debugging-port=${port}`,
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-features=CalculateNativeWinOcclusion",
  ].join(" ");
}

export async function waitBrowserEndpoint(port, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`CDP endpoint never appeared on port ${port}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Wait for the real app page target (the browser endpoint shows up first). */
export async function waitPageTarget(port, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const hit = list.find((t) => t.type === "page" && !/^about:blank/.test(t.url));
      if (hit) return hit;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error("app page target never appeared");
    await new Promise((r) => setTimeout(r, 500));
  }
}
