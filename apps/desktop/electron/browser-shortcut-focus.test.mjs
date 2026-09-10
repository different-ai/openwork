import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installBrowserShortcutFocusTracking } from "./browser-shortcut-focus.mjs";

function element(parentElement = null, tabId = null) {
  return {
    parentElement,
    getAttribute(name) {
      assert.equal(name, "data-browser-shortcut-tab");
      return tabId;
    },
    closest(selector) {
      assert.equal(selector, "[data-browser-shortcut-tab]");
      return tabId === null ? parentElement?.closest(selector) ?? null : this;
    },
  };
}

function setup() {
  const emitter = new EventEmitter();
  const documentElement = element();
  const document = { documentElement, body: element(documentElement) };
  const reports = [];
  const window = {
    document,
    addEventListener(type, listener, options) {
      assert.equal(options.capture, true, `${type} must run before descendant handlers`);
      emitter.on(type, listener);
    },
  };
  installBrowserShortcutFocusTracking(window, (tabId) => reports.push(tabId));
  return {
    document,
    reports,
    emit(type, target, isTrusted = true) {
      emitter.emit(type, { type, target, isTrusted });
    },
  };
}

test("reports the nearest browser marker for trusted pointer and focus events", () => {
  const { document, reports, emit } = setup();
  const tab = element(document.body, "tab-1");
  const nestedTab = element(tab, "tab-2");
  emit("pointerdown", element(tab));
  emit("focusin", tab);
  emit("focusin", element(nestedTab));
  assert.deepEqual(reports, ["tab-1", "tab-1", "tab-2"]);
});

test("outside targets clear focus even when a sibling browser marker is present", () => {
  const { document, reports, emit } = setup();
  const panel = element(document.body);
  const tab = element(panel, "tab-1");
  for (const target of [panel, element(panel), element(document.body), document.body, document.documentElement, document, null]) {
    emit("pointerdown", tab);
    emit("pointerdown", target);
    assert.equal(reports.at(-1), null);
  }
  emit("focusin", tab);
  emit("focusin", element(panel));
  assert.deepEqual(reports.slice(-2), ["tab-1", null]);
});

test("body focus after native tab closure retains continuity until explicit outside intent", () => {
  const { document, reports, emit } = setup();
  const tab = element(document.body, "tab-1");
  emit("pointerdown", tab);
  emit("focusin", document.body);
  emit("focusin", document.documentElement);
  assert.deepEqual(reports, ["tab-1"]);
  emit("pointerdown", document.body);
  assert.deepEqual(reports, ["tab-1", null]);
  emit("focusin", tab);
  emit("focusin", element(document.body));
  assert.deepEqual(reports, ["tab-1", null, "tab-1", null]);
});

test("synthetic focus and navigation events cannot establish or clear browser focus", () => {
  const { document, reports, emit } = setup();
  const tab = element(document.body, "tab-1");
  for (const type of ["pointerdown", "focusin", "beforeunload", "hashchange", "popstate"]) {
    emit(type, tab, false);
    emit(type, document.body, false);
  }
  assert.deepEqual(reports, []);
  emit("focusin", tab);
  emit("pointerdown", element(document.body), false);
  emit("hashchange", null, false);
  assert.deepEqual(reports, ["tab-1"]);
});

test("navigation and history changes clear focus, and later browser input reports again", () => {
  const { document, reports, emit } = setup();
  const tab = element(document.body, "tab-1");
  for (const type of ["beforeunload", "hashchange", "popstate"]) {
    emit("focusin", tab);
    emit(type);
    assert.deepEqual(reports.slice(-2), ["tab-1", null]);
  }
  emit("pointerdown", tab);
  assert.equal(reports.at(-1), "tab-1");
});

test("explicit browser input is not deduplicated after main clears Tab focus", () => {
  const { document, reports, emit } = setup();
  const tab = element(document.body, "tab-1");
  emit("focusin", tab);
  emit("keydown", tab);
  assert.deepEqual(reports, ["tab-1"], "main owns keyboard shortcut handling and Tab clearing");
  emit("focusin", tab);
  assert.deepEqual(reports, ["tab-1", "tab-1"]);
});

test("an empty closest marker clears rather than borrowing an ancestor tab", () => {
  const { document, reports, emit } = setup();
  emit("pointerdown", element(element(document.body, "tab-1"), ""));
  assert.deepEqual(reports, [null]);
});
