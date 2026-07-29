import assert from "node:assert/strict";
import test from "node:test";

import {
  createStationWindowManager,
  STATION_SHORTCUT,
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
  destroy() { this.destroyed = true; }
  on(name, callback) { this.listeners.set(name, callback); }
}

function createHarness(overrides = {}) {
  FakeWindow.instances = [];
  const ipcListeners = new Map();
  const ipcHandlers = new Map();
  const mainSent = [];
  let shortcut = null;
  const manager = createStationWindowManager({
    BrowserWindow: FakeWindow,
    globalShortcut: {
      register: (key, callback) => {
        assert.equal(key, STATION_SHORTCUT);
        shortcut = callback;
        return true;
      },
      unregister: () => {},
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
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (name, payload) => mainSent.push([name, payload]),
      },
    }),
  });
  return {
    ipcHandlers,
    ipcListeners,
    mainSent,
    manager,
    shortcut: () => shortcut,
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
  cursorX = 1800;
  harness.manager.setExpanded(true);
  const window = FakeWindow.instances[0];
  assert.equal(window.bounds.x + window.bounds.width, 1188);
  assert.equal(window.bounds.y, stationWindowBounds(leftDisplay, true).y);
  assert.equal(window.boundsCalls.at(-1)?.animate, false);
});

test("global shortcut shows Station and forwards a listening toggle", () => {
  const harness = createHarness();
  const result = harness.manager.initialize();
  assert.deepEqual(result, { registered: true, shortcut: STATION_SHORTCUT });
  harness.shortcut()?.();
  assert.deepEqual(harness.mainSent.at(-1), [
    "openwork:station:command",
    { type: "toggle-listening" },
  ]);
  assert.equal(FakeWindow.instances[0]?.hidden, false);
});

test("publishes bounded state to the Station window", () => {
  const harness = createHarness();
  harness.manager.initialize();
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

test("rejects unrecognized renderer commands", () => {
  const harness = createHarness();
  assert.deepEqual(harness.manager.forwardCommand({ type: "send-email" }), {
    ok: false,
    error: "invalid Station command",
  });
  assert.equal(harness.mainSent.length, 0);
});
