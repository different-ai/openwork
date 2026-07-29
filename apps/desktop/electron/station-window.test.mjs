import assert from "node:assert/strict";
import test from "node:test";

import {
  createStationWindowManager,
  stationDecisionCommand,
  STATION_MODE_SHORTCUT,
  stationWindowBounds,
} from "./station-window.mjs";

class FakeWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.hidden = true;
    this.bounds = options;
    this.boundsCalls = [];
    this.sent = [];
    this.listeners = new Map();
    this.webContents = {
      isDestroyed: () => false,
      on: (name, callback) => this.listeners.set(`web:${name}`, callback),
      send: (name, payload) => this.sent.push([name, payload]),
    };
    FakeWindow.instances.push(this);
  }

  isDestroyed() { return this.destroyed; }
  setBounds(bounds, animate) {
    this.bounds = bounds;
    this.boundsCalls.push({ bounds, animate });
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setMenuBarVisibility() {}
  showInactive() { this.hidden = false; }
  hide() { this.hidden = true; }
  isMinimized() { return false; }
  restore() {}
  show() { this.hidden = false; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  destroy() { this.destroyed = true; }
  on(name, callback) { this.listeners.set(name, callback); }
}

function createHarness(overrides = {}) {
  FakeWindow.instances = [];
  const ipcListeners = new Map();
  const ipcHandlers = new Map();
  const mainSent = [];
  const shortcuts = new Map();
  const registrations = [];
  const unregistered = [];
  const mainWindow = {
    focusCalls: 0,
    showCalls: 0,
    isDestroyed: () => false,
    isMinimized: () => false,
    show() { this.showCalls += 1; },
    focus() { this.focusCalls += 1; },
    webContents: {
      isDestroyed: () => false,
      send: (name, payload) => mainSent.push([name, payload]),
    },
  };
  const manager = createStationWindowManager({
    BrowserWindow: FakeWindow,
    globalShortcut: {
      register: (key, callback) => {
        registrations.push(key);
        shortcuts.set(key, callback);
        return true;
      },
      unregister: (key) => {
        unregistered.push(key);
        shortcuts.delete(key);
      },
    },
    ipcMain: {
      on: (name, callback) => ipcListeners.set(name, callback),
      handle: (name, callback) => ipcHandlers.set(name, callback),
    },
    loadContent: async () => {},
    platform: "darwin",
    preloadPath: "/tmp/station-preload.mjs",
    screen: overrides.screen ?? {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    getMainWindow: () => mainWindow,
  });
  return {
    ipcHandlers,
    ipcListeners,
    mainWindow,
    mainSent,
    manager,
    registrations,
    shortcuts,
    unregistered,
  };
}

test("anchors collapsed and expanded Station bounds to the screen edge", () => {
  const display = { workArea: { x: 20, y: 30, width: 1200, height: 800 } };
  const collapsed = stationWindowBounds(display, false);
  const expanded = stationWindowBounds(display, true);
  assert.equal(collapsed.x + collapsed.width, 1208);
  assert.equal(expanded.x + expanded.width, 1208);
  assert.ok(expanded.width > collapsed.width);
  assert.equal(expanded.height, collapsed.height);
  assert.equal(expanded.y, collapsed.y);
});

test("keeps the original display anchor and never delegates resizing animation to the OS", () => {
  let cursorX = 100;
  const leftDisplay = { workArea: { x: 0, y: 0, width: 1200, height: 800 } };
  const rightDisplay = { workArea: { x: 1200, y: 0, width: 1200, height: 800 } };
  const harness = createHarness({
    screen: {
      getCursorScreenPoint: () => ({ x: cursorX, y: 100 }),
      getDisplayNearestPoint: () => cursorX < 1200 ? leftDisplay : rightDisplay,
      getPrimaryDisplay: () => leftDisplay,
    },
  });
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  cursorX = 1800;
  harness.manager.setExpanded(true);
  const window = FakeWindow.instances[0];
  assert.equal(window.bounds.x + window.bounds.width, 1188);
  assert.equal(window.bounds.y, stationWindowBounds(leftDisplay, true).y);
  assert.equal(window.boundsCalls.at(-1)?.animate, false);
});

test("re-anchors when cached display geometry no longer matches a live display", () => {
  let staleAnchor = false;
  const disconnectedDisplay = {
    id: 41,
    workArea: { x: 0, y: 0, width: 1920, height: 900 },
  };
  const liveDisplay = {
    id: 7,
    workArea: { x: 0, y: 0, width: 1728, height: 900 },
  };
  const harness = createHarness({
    screen: {
      getCursorScreenPoint: () => ({ x: 1700, y: 100 }),
      getDisplayNearestPoint: () => disconnectedDisplay,
      getDisplayMatching: () => staleAnchor ? liveDisplay : disconnectedDisplay,
      getPrimaryDisplay: () => liveDisplay,
    },
  });
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  staleAnchor = true;
  harness.manager.setExpanded(true);
  const window = FakeWindow.instances[0];
  assert.equal(window.bounds.x + window.bounds.width, 1716);
});

test("the Station shortcut enters active mode without registering keys or taking focus", () => {
  const harness = createHarness();
  const result = harness.manager.initialize();
  assert.deepEqual(result, {
    enabled: false,
    registered: false,
    shortcut: STATION_MODE_SHORTCUT,
  });
  harness.manager.setEnabled(true);
  harness.shortcuts.get(STATION_MODE_SHORTCUT)?.();
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "set-mode", active: true },
  ]);
  assert.deepEqual([...harness.shortcuts.keys()], [STATION_MODE_SHORTCUT]);
  assert.equal(FakeWindow.instances[0]?.hidden, false);
  assert.notEqual(FakeWindow.instances[0]?.focused, true);
  const inputHandler = FakeWindow.instances[0]?.listeners.get("web:before-input-event");
  let prevented = false;
  inputHandler?.({ preventDefault: () => { prevented = true; } }, { type: "keyDown", key: "Enter" });
  assert.equal(prevented, false);
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "set-mode", active: true },
  ]);
});

test("Station stays dormant until enabled and repeated enablement keeps one shortcut", () => {
  const harness = createHarness();
  assert.equal(harness.manager.initialize().registered, false);
  assert.equal(FakeWindow.instances.length, 0);
  assert.equal(harness.manager.setEnabled(true).registered, true);
  assert.equal(harness.manager.setEnabled(true).registered, true);
  assert.equal(
    harness.registrations.filter((shortcut) => shortcut === STATION_MODE_SHORTCUT).length,
    1,
  );
});

test("intentionally focused Station decisions navigate cards without global shortcuts", () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  harness.manager.publishState({
    suggestions: [{ id: "first" }, { id: "second" }],
  });
  harness.shortcuts.get(STATION_MODE_SHORTCUT)?.();
  assert.notEqual(FakeWindow.instances[0]?.focused, true);
  FakeWindow.instances[0]?.focus();
  const inputHandler = FakeWindow.instances[0]?.listeners.get("web:before-input-event");
  const prevented = [];
  const event = { preventDefault: () => prevented.push(true) };
  inputHandler?.(event, { type: "keyDown", key: "ArrowLeft" });
  inputHandler?.(event, { type: "keyDown", key: "ArrowRight" });
  inputHandler?.(event, { type: "keyDown", key: "Enter" });
  assert.deepEqual(harness.mainSent.slice(-3), [
    ["openwork:station:command", { type: "previous" }],
    ["openwork:station:command", { type: "next" }],
    ["openwork:station:command", { type: "handoff" }],
  ]);
  assert.equal(prevented.length, 3);
  harness.shortcuts.get(STATION_MODE_SHORTCUT)?.();
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "set-mode", active: false },
  ]);
  assert.deepEqual([...harness.shortcuts.keys()], [STATION_MODE_SHORTCUT]);
});

test("ignores decision keys outside a focused unmodified key press", () => {
  assert.equal(stationDecisionCommand({ type: "keyDown", key: "Enter", meta: true }), null);
  assert.equal(stationDecisionCommand({ type: "keyDown", key: "Enter", isAutoRepeat: true }), null);
  assert.equal(stationDecisionCommand({ type: "keyUp", key: "Enter" }), null);
  assert.deepEqual(
    stationDecisionCommand({ type: "keyDown", key: "ArrowLeft" }),
    { type: "previous" },
  );
});

test("Escape is not intercepted and cannot show or focus the OpenWork window", () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  harness.manager.publishState({
    interactionMode: "active",
    suggestions: [{ id: "card-1" }],
  });
  const inputHandler = FakeWindow.instances[0]?.listeners.get("web:before-input-event");
  let prevented = false;
  inputHandler?.({ preventDefault: () => { prevented = true; } }, {
    type: "keyDown",
    key: "Escape",
  });
  assert.equal(prevented, false);
  assert.equal(harness.mainSent.length, 0);
  assert.equal(harness.mainWindow.showCalls, 0);
  assert.equal(harness.mainWindow.focusCalls, 0);
});

test("publishes bounded state to the Station window", () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  const suggestions = Array.from({ length: 18 }, (_, index) => ({ id: String(index) }));
  harness.manager.publishState({ visible: true, status: "listening", suggestions });
  const state = harness.manager.getState();
  assert.equal(state.status, "listening");
  assert.equal(state.suggestions.length, 12);
  assert.deepEqual(FakeWindow.instances[0]?.sent.at(-1), [
    "openwork:station:state",
    state,
  ]);
});

test("published active state expands for cards while passive state retracts before collapsing", async () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  harness.manager.publishState({
    visible: true,
    interactionMode: "active",
    suggestions: [{ id: "priority" }],
  });
  assert.equal(FakeWindow.instances[0]?.bounds.width, 440);
  harness.manager.publishState({ interactionMode: "passive" });
  assert.equal(FakeWindow.instances[0]?.bounds.width, 440);
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.equal(FakeWindow.instances[0]?.bounds.width, 66);
});

test("developer transcript expansion stays anchored across passive state updates", async () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  harness.manager.setExpanded(true);
  harness.manager.publishState({
    interactionMode: "passive",
    transcript: "A live transcript update.",
    suggestions: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.equal(FakeWindow.instances[0]?.bounds.width, 440);
  harness.manager.setExpanded(false);
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.equal(FakeWindow.instances[0]?.bounds.width, 66);
});

test("disabling Station stops the renderer and tears down every native capability", () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  assert.equal(FakeWindow.instances.length, 1);
  assert.ok(harness.shortcuts.has(STATION_MODE_SHORTCUT));
  const result = harness.manager.setEnabled(false);
  assert.equal(result.enabled, false);
  assert.equal(harness.manager.getEnabled(), false);
  assert.equal(FakeWindow.instances[0]?.destroyed, true);
  assert.equal(harness.shortcuts.has(STATION_MODE_SHORTCUT), false);
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "stop" },
  ]);
});

test("rejects unrecognized renderer commands", () => {
  const harness = createHarness();
  assert.deepEqual(harness.manager.forwardCommand({ type: "send-email" }), {
    ok: false,
    error: "invalid Station command",
  });
  assert.equal(harness.mainSent.length, 0);
});

test("forwards the development transcript reset without adding native behavior", () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  assert.deepEqual(harness.manager.forwardCommand({ type: "clear-transcript" }), {
    ok: true,
  });
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "clear-transcript" },
  ]);
});

test("forwards intentional goal approval and dismissal to the listening agent", () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  harness.manager.forwardCommand({ type: "approve-goal", id: "goal-1" });
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "approve-goal", id: "goal-1" },
  ]);
  harness.manager.forwardCommand({ type: "dismiss-goal", id: "goal-1" });
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "dismiss-goal", id: "goal-1" },
  ]);
});

test("forwards the transcript-record preference without persisting transcript content natively", () => {
  const harness = createHarness();
  harness.manager.initialize();
  harness.manager.setEnabled(true);
  harness.manager.forwardCommand({ type: "set-transcript-record", enabled: false });
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "set-transcript-record", enabled: false },
  ]);
});
