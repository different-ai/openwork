import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// browser-panel.mjs imports "electron" at module scope. Resolve that specifier
// to an in-memory stub so the panel's tab and view bookkeeping can run under
// plain Node.
const electronStub = `
export const app = { on() {} };
export const clipboard = { writeText() {} };
export const session = { fromPartition() { return {}; } };
export const shell = { openExternal() { return Promise.resolve(); } };
export class WebContentsView {
  constructor() {
    const listeners = new Map();
    let attached = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.webContents = {
      url: "about:blank",
      debugger: {
        commands: [],
        isAttached: () => attached,
        attach() { attached = true; },
        detach() { attached = false; },
        async sendCommand(method, params) { this.commands.push({ method, params }); },
      },
      on(event, handler) { listeners.set(event, handler); },
      once(event, handler) { listeners.set(event, handler); },
      emit(event, ...args) { listeners.get(event)?.(null, ...args); },
      setWindowOpenHandler() {},
      isDestroyed() { return false; },
      getURL() { return this.url; },
      getTitle() { return ""; },
      isLoading() { return false; },
      canGoBack() { return false; },
      canGoForward() { return false; },
      loadURL(url) { this.url = url; return Promise.resolve(); },
      focus() {},
      close() {},
    };
  }
  setBounds(bounds) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
}
`;

const hooks = `
const stub = ${JSON.stringify(electronStub)};
export function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: "electron-stub:main", shortCircuit: true };
  return next(specifier, context);
}
export function load(url, context, next) {
  if (url === "electron-stub:main") return { format: "module", source: stub, shortCircuit: true };
  return next(url, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { createBrowserPanel } = await import("./browser-panel.mjs");

const PANEL_BOUNDS = { x: 800, y: 40, width: 400, height: 900 };
const RESET_SEQUENCE = [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 0, height: 0, deviceScaleFactor: 0, mobile: false } },
  { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
];

function createPanel() {
  const children = [];
  const sent = [];
  const mainWindow = {
    contentView: {
      children,
      addChildView(view) { children.push(view); },
      removeChildView(view) { children.splice(children.indexOf(view), 1); },
    },
    webContents: { getZoomFactor: () => 1, isDestroyed: () => false, send(channel, payload) { sent.push({ channel, payload }); } },
    isDestroyed: () => false,
  };
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    on(channel, handler) { handlers.set(channel, handler); },
  };
  createBrowserPanel({ getWindow: () => mainWindow, remoteDebugPort: 0, onDeepLink: () => {} }).registerIpc(ipcMain);
  const invoke = (channel, ...args) => handlers.get(channel)(null, ...args);
  // The on-screen tab is the attached view with real panel bounds; background
  // presences are attached too, but only ever one pixel large.
  const onScreen = () => children.find((view) => view.getBounds().width > 1) ?? null;
  const commands = (view) => view.webContents.debugger.commands;
  const messages = (channel) => sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload);
  return { invoke, onScreen, commands, children, messages };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("showing the panel sizes the active tab and resets viewport emulation left on it", async () => {
  const { invoke, onScreen, commands } = createPanel();
  invoke("openwork:browser:createTab", "https://example.com");
  assert.equal(onScreen(), null, "a tab created while the panel is hidden stays off screen");

  invoke("openwork:browser:show", PANEL_BOUNDS);
  await flush();

  const view = onScreen();
  assert.ok(view, "the active tab is attached to the window");
  assert.deepEqual(view.getBounds(), PANEL_BOUNDS);
  assert.deepEqual(commands(view), RESET_SEQUENCE);
  assert.equal(view.webContents.debugger.isAttached(), false, "the temporary debugger session is released");
});

test("selecting a tab from the tab strip resets that tab only", async () => {
  const { invoke, onScreen, commands } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS);
  const first = invoke("openwork:browser:createTab", "https://one.example");
  const firstView = onScreen();
  invoke("openwork:browser:createTab", "https://two.example");
  const secondView = onScreen();
  assert.notEqual(firstView, secondView);
  await flush();
  commands(firstView).length = 0;
  commands(secondView).length = 0;

  invoke("openwork:browser:selectTab", first.tabId);
  await flush();

  assert.equal(onScreen(), firstView);
  assert.deepEqual(commands(firstView), RESET_SEQUENCE);
  assert.deepEqual(commands(secondView), [], "the tab that left the screen is untouched");
});

test("focusing a tab's page resets its viewport emulation unless a debugger is already attached", async () => {
  const { invoke, onScreen, commands } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS);
  invoke("openwork:browser:createTab", "https://example.com");
  const view = onScreen();
  await flush();
  commands(view).length = 0;

  view.webContents.emit("focus");
  await flush();
  assert.deepEqual(commands(view), RESET_SEQUENCE);

  commands(view).length = 0;
  view.webContents.debugger.attach("1.3");
  view.webContents.emit("focus");
  await flush();
  assert.deepEqual(commands(view), [], "an existing debugger session is left alone");
  assert.equal(view.webContents.debugger.isAttached(), true);
});

test("agent navigation that brings a background tab on screen leaves its viewport emulation alone", async () => {
  const { invoke, onScreen, commands } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS);
  invoke("openwork:browser:createTab", "https://one.example");
  const firstView = onScreen();
  invoke("openwork:browser:createTab", "https://two.example");
  assert.notEqual(onScreen(), firstView, "the first tab is in the background");
  await flush();
  commands(firstView).length = 0;

  firstView.webContents.emit("did-start-navigation", "https://one.example/next", false, true);
  await flush();

  assert.equal(onScreen(), firstView, "the navigating tab is brought on screen");
  assert.deepEqual(commands(firstView), [], "a capture viewport set before navigating is preserved");
});

const BACKGROUND_SEQUENCE = [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false } },
  { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
];
const FOREGROUND_SEQUENCE = [
  { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } },
  { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
];

test("a tab opened for a background conversation loads silently and leaves the visible conversation's tab on screen", async () => {
  const { invoke, onScreen, commands, children, messages } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const visibleView = onScreen();
  await flush();
  commands(visibleView).length = 0;

  const { tabId } = invoke("openwork:browser:createTab", "https://b.example", "B");
  await flush();

  const state = invoke("openwork:browser:state");
  const backgroundTab = state.tabs.find((tab) => tab.id === tabId);
  const backgroundView = children.find((view) => view !== visibleView);
  assert.equal(onScreen(), visibleView, "the visible conversation keeps its tab on screen");
  assert.equal(state.activeTabId, state.tabs.find((tab) => tab.ownerSessionId === "A").id);
  assert.equal(backgroundTab.ownerSessionId, "B");
  assert.equal(state.activeTabIdByOwner.B, tabId, "the tab is B's active tab, ready for when B is opened");
  assert.deepEqual(backgroundView.getBounds(), { x: 0, y: 0, width: 1, height: 1 }, "a one-pixel presence keeps the page painting");
  assert.deepEqual(commands(backgroundView), BACKGROUND_SEQUENCE, "the page lays out and focuses like a visible one");
  assert.equal(backgroundView.webContents.debugger.isAttached(), true, "our emulation session stays open while unseen");
  assert.deepEqual(commands(visibleView), [], "the visible tab is untouched");
  assert.deepEqual(messages("openwork:browser:panel-opened"), [], "no panel pops for a silent tab until it navigates");
});

test("navigating a background conversation's tab reports its owner instead of taking the screen", async () => {
  const { invoke, onScreen, children, messages } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const visibleView = onScreen();
  invoke("openwork:browser:createTab", "https://b.example", "B");
  const backgroundView = children.find((view) => view !== visibleView);
  await flush();

  backgroundView.webContents.emit("did-start-navigation", "https://b.example/next", false, true);
  await flush();

  assert.equal(onScreen(), visibleView, "A's tab stays on screen");
  assert.deepEqual(messages("openwork:browser:panel-opened"), [{ ownerSessionId: "B" }]);
});

test("switching to the background conversation swaps its tab on screen and restores a normal viewport", async () => {
  const { invoke, onScreen, commands, children } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const aView = onScreen();
  invoke("openwork:browser:createTab", "https://b.example", "B");
  const bView = children.find((view) => view !== aView);
  await flush();
  commands(aView).length = 0;
  commands(bView).length = 0;

  invoke("openwork:browser:setVisibleSession", "B");
  await flush();

  assert.equal(onScreen(), bView, "B's tab takes the screen");
  assert.deepEqual(bView.getBounds(), PANEL_BOUNDS);
  assert.deepEqual(commands(bView), FOREGROUND_SEQUENCE, "B's emulation is undone before it is shown");
  assert.equal(bView.webContents.debugger.isAttached(), false, "our session is released for the user-driven reset path");
  assert.deepEqual(commands(aView), BACKGROUND_SEQUENCE, "A's tab now keeps painting in the background");
  assert.deepEqual(aView.getBounds(), { x: 0, y: 0, width: 1, height: 1 });
  const state = invoke("openwork:browser:state");
  assert.equal(state.visibleSessionId, "B");
  assert.equal(state.activeTabId, state.activeTabIdByOwner.B);
});

test("closing a conversation's last tab tells only that conversation its panel is empty", async () => {
  const { invoke, onScreen, messages } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const aView = onScreen();
  const { tabId } = invoke("openwork:browser:createTab", "https://b.example", "B");
  await flush();

  invoke("openwork:browser:closeTab", tabId);

  assert.equal(onScreen(), aView, "A keeps browsing");
  assert.deepEqual(messages("openwork:browser:panel-closed"), [{ ownerSessionId: "B" }]);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map((tab) => tab.ownerSessionId), ["A"]);
});

test("tabs created without a conversation stay shared and behave as before", async () => {
  const { invoke, onScreen, messages } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS);
  invoke("openwork:browser:createTab", "https://shared.example");
  await flush();

  const state = invoke("openwork:browser:state");
  assert.equal(state.tabs[0].ownerSessionId, null);
  assert.ok(onScreen(), "a shared tab is on screen");

  invoke("openwork:browser:setVisibleSession", "A");
  assert.ok(onScreen(), "a shared tab stays on screen for every conversation");
  invoke("openwork:browser:closeAllTabs");
  assert.deepEqual(messages("openwork:browser:panel-closed"), [{ ownerSessionId: null }]);
});
