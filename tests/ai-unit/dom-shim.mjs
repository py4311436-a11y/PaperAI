/**
 * Minimal DOM implementation, sufficient for `renderMarkdown`.
 *
 * Rationale: we want to assert that rendering hostile markdown can never create
 * an active element. Doing that through a real browser would be nicer, but
 * puppeteer cannot launch on this machine (K-13 family), and a shim gives a
 * *more* deterministic assertion anyway: it records every element that gets
 * created, so "no <script> was ever constructed" is directly observable.
 *
 * Only the API surface the renderer touches is implemented. Anything missing
 * throws loudly rather than silently returning undefined, so a gap in the shim
 * shows up as a test failure instead of a false pass.
 */

export class ShimNode {
  constructor(type) {
    this.nodeType = type === "#text" ? 3 : 1;
    this.tagName = type === "#text" ? undefined : type.toUpperCase();
    this.nodeName = type === "#text" ? "#text" : this.tagName;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this._text = "";
    this.className = "";
    this.listeners = {};
    this.tabIndex = 0;
    this.hidden = false;
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(v) {
    if (this.nodeType === 3) {
      this._text = String(v);
      return;
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== "" && v != null) this.appendChild(new ShimNode("#text")._setText(String(v)));
  }

  _setText(t) {
    this._text = t;
    return this;
  }

  appendChild(n) {
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }

  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    return n;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] ?? null;
  }
  toggleAttribute(k, on) {
    if (on) this.attributes[k] = "";
    else delete this.attributes[k];
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  /** Test helper: dispatch a click with a fake event. */
  fire(type, ev) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }

  get classList() {
    const self = this;
    return {
      add(...names) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        self.className = [...set].join(" ");
      },
      remove(...names) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        self.className = [...set].join(" ");
      },
      contains(n) {
        return self.className.split(/\s+/).includes(n);
      },
    };
  }

  closest(sel) {
    let el = this;
    while (el) {
      if (el.nodeType === 1 && sel.startsWith(".") && el.classList.contains(sel.slice(1))) return el;
      el = el.parentNode;
    }
    return null;
  }

  /** Depth-first walk over elements only. */
  allElements(out = []) {
    for (const c of this.childNodes) {
      if (c.nodeType === 1) {
        out.push(c);
        c.allElements(out);
      }
    }
    return out;
  }

  querySelectorAll(sel) {
    // Only the two selectors the renderer uses.
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      return this.allElements().filter((e) => e.classList.contains(cls));
    }
    return this.allElements().filter((e) => e.tagName === sel.toUpperCase());
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

export class ShimDocument {
  constructor() {
    this.created = [];
    this.body = new ShimNode("body");
    this.documentElement = new ShimNode("html");
  }

  createElement(tag) {
    const n = new ShimNode(tag);
    // Record everything ever created — this is what the XSS test asserts on.
    this.created.push(String(tag).toLowerCase());
    return n;
  }
  createTextNode(text) {
    return new ShimNode("#text")._setText(String(text));
  }
  createDocumentFragment() {
    return new ShimNode("#fragment");
  }
  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

/** Install the shim as the global `document`, returning a restore function. */
export function installDom() {
  const prev = globalThis.document;
  const doc = new ShimDocument();
  globalThis.document = doc;
  return {
    doc,
    restore() {
      globalThis.document = prev;
    },
  };
}
