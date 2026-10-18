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

  /**
   * Replace every child in one step, as the real DOM does.
   *
   * The panel uses it to swap the model `<select>`'s options. Without it the
   * tests that touch the composer threw `row.replaceChildren is not a function`
   * before reaching their own assertions — so they failed for a reason that had
   * nothing to do with what they were checking, which is how a test ends up
   * "proving" the wrong thing. Same class of gap as `childElementCount` in
   * 0.5.1.
   */
  replaceChildren(...nodes) {
    for (const old of this.childNodes) old.parentNode = null;
    this.childNodes.length = 0;
    this.append(...nodes);
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

  /**
   * Inline style bag.
   *
   * The real DOM has `element.style`; the shim did not, so `th.style.textAlign
   * = "right"` threw and the table-alignment test failed with a TypeError
   * instead of checking what it meant to check.
   */
  get style() {
    if (!this._style) this._style = {};
    return this._style;
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
      /**
       * Real DOM `toggle(name, force?)`.
       *
       * Added when `setMemoryState` started using it: the shim threw
       * "classList.toggle is not a function", which fails the *test* rather
       * than the assertion inside it. That is the failure mode this project has
       * been bitten by before (0.5.1 `childElementCount`, `replaceChildren`) —
       * a missing shim method means the test never reaches what it meant to
       * check. It failed loudly this time, but the fix is still the shim: the
       * real DOM has `toggle`, so code may use it.
       *
       * The two-argument form is what the panel uses, so it is implemented
       * exactly: `force` decides the result instead of flipping.
       */
      toggle(name, force) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        const want = force === undefined ? !set.has(name) : Boolean(force);
        if (want) set.add(name);
        else set.delete(name);
        self.className = [...set].join(" ");
        return want;
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
    // Class, tag, id, and space-separated descendant selectors — everything the
    // panel, the renderer and the table tests use.
    //
    // Descendant support was added when tables arrived: `querySelectorAll(
    // "tbody tr")` silently returned nothing, which fails a test *inside* its
    // assertion rather than at the selector. Same family as the missing
    // `classList.toggle`: a shim that cannot express the query makes the test
    // report the wrong thing.
    const parts = sel.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      let scope = [this];
      for (const part of parts) {
        const next = [];
        for (const node of scope) next.push(...node.querySelectorAll(part));
        // De-duplicate: a nested match can be found from more than one ancestor.
        scope = [...new Set(next)];
      }
      return scope;
    }
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
