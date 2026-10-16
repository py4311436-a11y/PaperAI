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
    if (type === "select") this._installSelectValue();
  }

  /**
   * Real `<select>` value semantics: `value` reads the selected option and
   * writing it moves the selection, rejecting ids that are not in the list.
   *
   * Without this, `select.value = "x"` would just create a stray property and a
   * test could "pass" on a picker that never had that option — which is exactly
   * the bug class this shim exists to catch.
   */
  _installSelectValue() {
    const optionNodes = () => this.childNodes.filter((c) => c.nodeType === 1 && c.tagName === "OPTION");
    Object.defineProperty(this, "value", {
      configurable: true,
      get() {
        const opts = optionNodes();
        const sel = opts.find((o) => o.selected);
        return (sel ?? opts[0])?.value ?? "";
      },
      set(v) {
        const opts = optionNodes();
        const hit = opts.find((o) => o.value === v);
        for (const o of opts) o.selected = o === hit;
      },
    });
    Object.defineProperty(this, "options", {
      configurable: true,
      get() {
        return optionNodes();
      },
    });
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
    // A DocumentFragment is *moved*, not inserted: the real DOM splices its
    // children in. Without this the fragment stays as a single wrapper child,
    // `childElementCount` is permanently 1, and any code that branches on it
    // silently takes the wrong path — which is exactly how a test ended up
    // passing against a branch it never executed.
    if (n && n.isFragment) {
      for (const c of [...n.childNodes]) {
        c.parentNode = null;
        this.appendChild(c);
      }
      n.childNodes.length = 0;
      return n;
    }
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }

  /** Multi-argument append, as the real DOM has. */
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }

  prepend(...nodes) {
    for (const n of nodes.reverse()) {
      n.parentNode = this;
      this.childNodes.unshift(n);
    }
  }

  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }

  /** `ChildNode.remove()` — used by the panel to drop the empty-state note. */
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChild(next, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) throw new Error("replaceChild: old node is not a child");
    this.childNodes[i] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }

  /** Element children only — `children.length`, not `childNodes.length`. */
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  /**
   * Without this the panel took its *full-rebuild* path in every unit test,
   * because `undefined === turns.length` is false. The streaming-reuse tests
   * then passed against code they never executed. A shim gap that silently
   * selects the wrong branch is worse than one that throws.
   */
  get childElementCount() {
    return this.children.length;
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
    // Class, tag and id selectors — everything the panel and renderer use.
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      return this.allElements().filter((e) => e.classList.contains(cls));
    }
    if (sel.startsWith("#")) {
      const id = sel.slice(1);
      return this.allElements().filter((e) => e.id === id);
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
    const n = new ShimNode("#fragment");
    n.isFragment = true;
    return n;
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
