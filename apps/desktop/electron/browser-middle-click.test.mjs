import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Execute the real isolated preload with DOM/IPC witnesses, never a live page or
// OS browser. These tests assert dispatch semantics, not physical mouse input.
function loadPreload(surface, { native = true, mainFrame = true, platform = "linux" } = {}) {
  const location = new URL(surface === "app" ? "http://localhost/index.html" : "https://example.com/page");
  const listeners = new Map();
  const calls = [];
  const exposed = {};
  const window = {
    addEventListener(type, handler, options) {
      const entries = listeners.get(type) ?? [];
      entries.push({ handler, options });
      listeners.set(type, entries);
    },
  };
  class HTMLElement {
    constructor(attributes = {}) { this.attributes = attributes; this.isContentEditable = false; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    getAttribute(name) { return this.attributes[name] ?? null; }
  }
  class HTMLAnchorElement extends HTMLElement {
    get href() { return new URL(this.getAttribute("href"), location).href; }
  }
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {}
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value; } },
    ipcRenderer: { on() {}, sendSync() { return null; }, send(channel, url) { calls.push({ channel, url }); } },
    webFrame: {}, webUtils: {},
  };
  if (native) {
    const file = surface === "app" ? "preload.mjs" : "browser-content-preload.cjs";
    const source = readFileSync(new URL(file, import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
    runInNewContext(source, {
      ...electron, require: () => electron,
      process: { isMainFrame: mainFrame, platform, versions: {}, env: {} },
      installBrowserShortcutFocusTracking() {},
      window, location, URL, HTMLElement, HTMLAnchorElement, HTMLInputElement, HTMLTextAreaElement,
      document: { readyState: "complete", documentElement: { dataset: {}, classList: { add() {} } } },
    });
  }
  /**
   * @param {MouseEventInit & {
   *   href?: string,
   *   attributes?: Record<string, string>,
   *   type?: string,
   *   trusted?: boolean,
   *   prevented?: boolean,
   *   editable?: boolean,
   *   input?: boolean,
   *   link?: boolean,
   * }} [options]
   */
  function dispatch({ href = "https://destination.example/a%2Fb?x=one%20two&x=%2F#section", attributes = {}, button = 1, type = "auxclick", detail = 1, trusted = true, prevented = false, editable = false, input = false, link = true, ...modifiers } = {}) {
    const anchor = new HTMLAnchorElement({ href, ...attributes });
    const child = input ? new HTMLInputElement() : new HTMLElement();
    child.isContentEditable = editable;
    const event = {
      type, button, detail, isTrusted: trusted, defaultPrevented: prevented, stopped: false,
      ...modifiers,
      composedPath: () => link ? [child, anchor, window] : [child, window],
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
    };
    for (const { handler, options } of listeners.get(type) ?? []) {
      assert.equal(options.capture, true, "own the gesture before renderer/page handlers");
      handler(event);
      if (event.stopped) break;
    }
    return { event, builtinOpens: type === "auxclick" && button === 1 && !event.defaultPrevented ? 1 : 0, bubbled: !event.stopped };
  }
  return { dispatch, calls, listeners, exposed, location };
}

for (const surface of ["app", "page"]) {
  for (const platform of ["darwin", "win32", "linux"]) {
    test(`${surface}/${platform}: platform Cmd/Ctrl primary click uses the same guarded external dispatch`, () => {
      const { dispatch, calls, listeners } = loadPreload(surface, { platform });
      const modifier = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
      const gesture = { button: 0, type: "click", ...modifier };
      const url = "https://destination.example/a%2Fb?x=%2F#section";
      const { event, bubbled } = dispatch({ ...gesture, href: url });
      assert.equal(event.defaultPrevented, true);
      assert.equal(bubbled, false, "React/page handlers cannot also open the link");
      assert.deepEqual(calls, [{ channel: "openwork:browser:middleClickLink", url }]);
      assert.equal(listeners.get("click").length, 1);
      calls.length = 0;
      for (const options of [
        { trusted: false }, { prevented: true }, { detail: 0 }, { button: 1 }, { button: 2 },
        { type: "mousedown" }, { type: "mouseup" }, { type: "dragstart" },
        { href: "#section" },
        { href: "file:///tmp/link.html" }, { href: "javascript:alert(1)" }, { href: "https://user:password@example.com" },
        { attributes: { download: "file" } }, { editable: true }, { input: true }, { link: false },
      ]) {
        const result = dispatch({ ...gesture, ...options });
        assert.equal(result.event.defaultPrevented, options.prevented ?? false);
        assert.equal(result.bubbled, true);
      }
      // Control-click on macOS is a context-menu gesture, not Cmd-click.
      const otherModifier = platform === "darwin" ? { ctrlKey: true } : { metaKey: true };
      assert.equal(dispatch({ button: 0, type: "click", ...otherModifier }).event.defaultPrevented, false);
      assert.deepEqual(calls, []);
      if (surface === "app") {
        for (const href of ["/workspace/a", "docs/report.pdf", "http://localhost/settings"]) {
          assert.equal(dispatch({ ...gesture, href }).event.defaultPrevented, false);
        }
        assert.deepEqual(calls, []);
      } else {
        assert.equal(dispatch({ ...gesture, href: "/next?value=%2F#section" }).event.defaultPrevented, true);
        assert.deepEqual(calls, [{ channel: "openwork:browser:middleClickLink", url: "https://example.com/next?value=%2F#section" }]);
      }
    });
  }
  test(`${surface}: nested middle-click link cancels native navigation and bubbling with exactly one IPC`, () => {
    const { dispatch, calls, listeners, exposed } = loadPreload(surface);
    // Markdown, citation chips/hover cards, and plain app URLs are all anchors;
    // sanitized href wins over original markdown metadata.
    const url = "https://destination.example/a%2Fb?x=one%20two&x=%2F#section";
    const { event, builtinOpens, bubbled } = dispatch({ href: url, attributes: { "data-openwork-link-href": "file:///ignored" } });
    assert.equal(event.defaultPrevented, true);
    assert.equal(bubbled, false);
    assert.equal(builtinOpens, 0);
    assert.deepEqual(calls, [{ channel: "openwork:browser:middleClickLink", url }]);
    assert.equal(listeners.get("auxclick").length, 1);
    assert.equal(exposed.__OPENWORK_ELECTRON__?.browser?.middleClickLink, undefined, "no page-facing launch API");
  });

  test(`${surface}: ordinary primary, auxiliary menus, keyboard and drag stay unchanged`, () => {
    const { dispatch, calls } = loadPreload(surface);
    for (const options of [
      { button: 0 }, { button: 2 }, { button: 3 }, { trusted: false }, { prevented: true },
      { button: 0, type: "click" }, { button: 0, metaKey: true, type: "click" },
      { button: 0, ctrlKey: true, type: "click", detail: 0 },
      { button: 0, altKey: true, type: "click" }, { button: 0, shiftKey: true, type: "click" },
      { button: 0, type: "click", detail: 0 }, { type: "mousedown" }, { type: "mouseup" }, { type: "dragstart" },
    ]) {
      const { event, bubbled } = dispatch(options);
      assert.equal(event.defaultPrevented, options.prevented ?? false, JSON.stringify(options));
      assert.equal(bubbled, true);
    }
    assert.deepEqual(calls, []);
    dispatch({ ctrlKey: true });
    assert.equal(calls.length, 1, "a modified middle click is still button 1, not a modified primary click");
  });

  test(`${surface}: fragments, files, unsafe schemes, downloads, editors, and non-links are not externalized`, () => {
    const { dispatch, calls, location } = loadPreload(surface);
    for (const href of ["", "#section", `${location.href}#section`, "file:///tmp/readme.md", "mailto:test@example.com", "openwork://settings", "javascript:alert(1)", "data:text/html,link", "blob:https://example.com/id", "https://user:password@example.com/", "https://example.com/\npath", "https://example.com/\u007f", "http://[", `https://example.com/${"a".repeat(32_768)}`]) {
      assert.equal(dispatch({ href }).event.defaultPrevented, false, href.slice(0, 60));
    }
    for (const options of [{ attributes: { download: "file" } }, { editable: true }, { input: true }, { link: false }]) {
      assert.equal(dispatch(options).event.defaultPrevented, false);
    }
    assert.deepEqual(calls, []);
  });

  test(`${surface}: subframe preloads never grant external link clicks`, () => {
    const { dispatch, calls } = loadPreload(surface, { mainFrame: false });
    assert.equal(dispatch().event.defaultPrevented, false);
    assert.equal(dispatch({ button: 0, type: "click", ctrlKey: true }).event.defaultPrevented, false);
    assert.deepEqual(calls, []);
  });
}

test("app: absolute internal routes and relative attachment paths retain their behavior", () => {
  const { dispatch, calls } = loadPreload("app");
  for (const href of ["/workspace/a/session/b", "docs/report.pdf", "http://localhost/settings", "//localhost/settings"]) {
    assert.equal(dispatch({ href }).event.defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
  dispatch({ href: "//destination.example/path" });
  assert.deepEqual(calls, [{ channel: "openwork:browser:middleClickLink", url: "http://destination.example/path" }]);
});

test("page: relative website links resolve against the document without losing query/hash", () => {
  const { dispatch, calls } = loadPreload("page");
  assert.equal(dispatch({ href: "/next?value=%2F#section" }).event.defaultPrevented, true);
  assert.deepEqual(calls, [{ channel: "openwork:browser:middleClickLink", url: "https://example.com/next?value=%2F#section" }]);
});

test("web client: without the native preload middle and Cmd/Ctrl clicks keep browser defaults", () => {
  const { dispatch, calls } = loadPreload("app", { native: false });
  assert.equal(dispatch().builtinOpens, 1);
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
    assert.equal(dispatch({ button: 0, type: "click", ...modifier }).event.defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
});
