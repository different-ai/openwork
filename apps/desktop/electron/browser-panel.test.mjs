import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import test from "node:test";

// Keep Electron and installed-browser discovery in memory: these guards must
// never touch the clipboard, show a dialog, or launch a real browser.
const electronStub = `
import { EventEmitter } from "node:events";
export const effects = [];
export const controls = {
  ready: true,
  confirm: async () => 0, beforeLoad: async () => {}, beforeCommand: async () => {}, beforeDiscovery: async () => {},
  invoke: async () => true,
};
export const exposed = {};
export const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
export const webUtils = {};
export const webFrame = {
  zoomFactor: 1,
  getZoomFactor() { return this.zoomFactor; },
  setZoomFactor(factor) { this.zoomFactor = factor; },
};
export const preloadCalls = [];
export const ipcRenderer = new EventEmitter();
ipcRenderer.invoke = (channel, ...args) => { preloadCalls.push({ channel, args }); return controls.invoke(channel, ...args); };
ipcRenderer.send = (channel, ...args) => { preloadCalls.push({ channel, args }); };
ipcRenderer.sendSync = () => null;
export const app = { on() {} };
export const clipboard = { writeText(url) { effects.push({ type: "copy", url }); } };
export const dialog = { async showMessageBox(_window, options) { effects.push({ type: "dialog" }); return { response: await controls.confirm(options) }; } };
export const requestHooks = [];
export const browserSession = new EventEmitter();
browserSession.webRequest = { onBeforeRequest(_filter, listener) { requestHooks.push(listener); } };
export const session = { fromPartition() {
  if (!controls.ready) throw new Error("Session can only be received when app is ready");
  return browserSession;
} };
export const shell = { async openExternal(url) { effects.push({ type: "external", url }); } };
export const createdViews = [];
export const navigation = { load: async () => {} };
export class BrowserWindow {
  static getAllWindows() { return []; }
  constructor(options) {
    if (options.show !== false || options.focusable !== false) throw new Error("background host must never show or focus");
    const children = [];
    this.contentView = {
      children,
      addChildView(view) { children.push(view); },
      removeChildView(view) { children.splice(children.indexOf(view), 1); },
    };
    this.destroyed = false;
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return false; }
  destroy() { this.destroyed = true; }
}
export class WebContentsView {
  constructor(options) {
    createdViews.push(this);
    const listeners = new EventEmitter();
    const requestHook = options?.webPreferences?.partition === "persist:openwork-browser" ? requestHooks.at(-1) : null;
    let attached = false;
    const targetId = "target-" + createdViews.length;
    const view = this;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.visible = true;
    this.webContents = {
      id: createdViews.length,
      url: "about:blank",
      targetId, domReady: false, loading: false, audible: false, closeMode: "destroy", loads: [],
      sent: [],
      send(channel, payload) { this.sent.push({ channel, payload }); },
      debugger: {
        commands: [],
        isAttached: () => attached,
        attach() { attached = true; },
        detach() { attached = false; },
        async sendCommand(method, params) {
          if (method.startsWith("Emulation.") && !view.webContents.domReady) throw new Error("Emulation before initial document");
          this.commands.push({ method, params });
          await controls.beforeCommand(method);
          if (method === "Target.getTargetInfo") return { targetInfo: { targetId } };
        },
      },
      on(event, handler) { listeners.on(event, handler); },
      once(event, handler) { listeners.once(event, handler); },
      removeListener(event, handler) { listeners.removeListener(event, handler); },
      emit(event, ...args) { listeners.emit(event, null, ...args); },
      setWindowOpenHandler(handler) { this.windowOpenHandler = handler; },
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      getURL() { return this.url; },
      getOrCreateDevToolsTargetId() { return targetId; },
      getTitle() { return ""; },
      isLoading() { return this.loading; },
      isCurrentlyAudible() { return this.audible; },
      canGoBack() { return false; },
      canGoForward() { return false; },
      destinations: [],
      stops: 0,
      async request(url, details = {}) {
        const result = requestHook ? await new Promise((resolve) => requestHook({ url, method: "GET", resourceType: "mainFrame", webContentsId: this.id, ...details }, resolve)) : { cancel: false };
        if (!result.cancel && /^https?:/.test(url)) this.destinations.push(url);
        return result;
      },
      async loadURL(url) {
        this.url = url; this.loads.push(url);
        await controls.beforeLoad(this, url);
        if ((await this.request(url)).cancel) throw new Error("ERR_BLOCKED_BY_CLIENT");
        await navigation.load(url, this);
        if (this.destroyed) throw new Error("Contents destroyed");
        this.domReady = true;
        this.emit("dom-ready");
      },
      stop() { this.stops++; },
      focus() {},
      close(options) {
        if (options?.waitForBeforeUnload && this.closeMode === "pending") return;
        if (options?.waitForBeforeUnload && this.closeMode === "veto") { this.emit("will-prevent-unload"); return; }
        this.destroyed = true; this.emit("destroyed");
      },
    };
  }
  setBounds(bounds) { this.bounds = bounds; }
  setVisible(visible) { this.visible = visible; }
  getVisible() { return this.visible; }
  getBounds() { return this.bounds; }
}
`;

const installedBrowsersStub = `
import { effects, controls } from "electron";
export async function listInstalledBrowsers() {
  await controls.beforeDiscovery();
  return [["chrome", "Google Chrome"], ["firefox", "Firefox"]].map(([id, name]) => ({
    id, name,
    async open(url) { effects.push({ type: "browser", id, url }); },
  }));
}
`;

const hooks = `
const stub = ${JSON.stringify(electronStub)};
const browsers = ${JSON.stringify(installedBrowsersStub)};
export function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: "electron-stub:main", shortCircuit: true };
  if (specifier === "./installed-browsers.mjs") return { url: "installed-browsers-stub:main", shortCircuit: true };
  return next(specifier, context);
}
export function load(url, context, next) {
  if (url === "electron-stub:main") return { format: "module", source: stub, shortCircuit: true };
  if (url === "installed-browsers-stub:main") return { format: "module", source: browsers, shortCircuit: true };
  return next(url, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { createBrowserPanel } = await import("./browser-panel.mjs");
// @ts-expect-error The registered test-only Electron stub exports its witnesses.
const { createdViews, effects, controls, browserSession, navigation, requestHooks, exposed, webFrame, preloadCalls, ipcRenderer } = await import("electron");

const PANEL_BOUNDS = { x: 800, y: 40, width: 400, height: 900 };
const LINK = { url: "https://example.com/a%2Fb?x=one%20two&x=%2F#section", point: { x: 20, y: 30 }, sessionId: "A" };
const RESET_SEQUENCE = [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 0, height: 0, deviceScaleFactor: 0, mobile: false } },
  { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
];

function createPanel(checkPolicy = async (_request) => {}, remoteDebugPort = 0) {
  effects.length = 0;
  controls.confirm = async () => 0;
  controls.beforeLoad = async () => {};
  controls.beforeCommand = async () => {};
  controls.beforeDiscovery = async () => {};
  browserSession.removeAllListeners("will-download");
  const policies = [];
  const children = [];
  const firstView = createdViews.length;
  const sent = [];
  const menus = [];
  const mainWindow = Object.assign(new EventEmitter(), {
    contentView: {
      children,
      addChildView(view, index) {
        const previous = children.indexOf(view);
        if (previous !== -1) children.splice(previous, 1);
        children.splice(index ?? children.length, 0, view);
        assert.ok(view.getBounds().width > 0 && view.getBounds().height > 0, "size a view before attaching it");
      },
      removeChildView(view) { children.splice(children.indexOf(view), 1); },
    },
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: {},
      getURL: () => "http://localhost/index.html",
      zoomFactor: 1,
      getZoomFactor() { return this.zoomFactor; },
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      send(channel, payload) { sent.push({ channel, payload }); },
    }),
    destroyed: false,
    isDestroyed() { return this.destroyed; },
  });
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    on(channel, handler) { handlers.set(channel, handler); },
  };
  const panel = createBrowserPanel({
    getWindow: () => mainWindow, remoteDebugPort, onDeepLink: () => {},
    checkPolicy: async (request) => { policies.push(request); await checkPolicy(request); },
    showNativeContextMenu: (request) => new Promise((resolve, reject) => {
      menus.push({ request, choose: resolve, fail: reject, closed: false });
    }),
    // Intentionally allow a late result after close to exercise stale callbacks.
    closeNativeContextMenu: () => { if (menus.length) menus.at(-1).closed = true; },
  });
  panel.registerIpc(ipcMain);
  const mainContents = mainWindow.webContents;
  const emit = (channel, event, ...args) => handlers.get(channel)?.(event, ...args);
  const invoke = (channel, ...args) => {
    assert.ok(handlers.has(channel), `registered IPC: ${channel}`);
    return emit(channel, { sender: mainContents, senderFrame: mainContents.mainFrame }, ...args);
  };
  // Electron paints every child above the BrowserWindow's primary renderer.
  const onScreen = () => children.find((view) => view.getBounds().width > 1) ?? null;
  const views = () => createdViews.slice(firstView);
  const commands = (view) => view.webContents.debugger.commands;
  const messages = (channel) => sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload);
  const approve = (allowed = true, tabId = invoke("openwork:browser:state").activeTabId) => {
    const tab = invoke("openwork:browser:state").tabs.find((tab) => tab.id === tabId);
    assert.ok(tab?.browserApproval, "the tab has a pending approval");
    return invoke("openwork:browser:approve", tabId, tab.browserApproval.id, allowed);
  };
  async function openLinkMenu(payload = LINK) {
    const before = menus.length;
    invoke("openwork:browser:linkContextMenu", payload);
    await flush();
    assert.equal(menus.length, before + 1, "the link menu opens a native popup");
    return menus.at(-1);
  }
  async function openTabMenu(tabId, point = LINK.point) {
    const before = menus.length;
    const done = invoke("openwork:browser:tabContextMenu", tabId, point);
    await flush();
    assert.equal(menus.length, before + 1, "the tab menu opens a native popup");
    return { ...menus.at(-1), done };
  }
  return { invoke, emit, mainWindow, mainContents, menus, onScreen, commands, children, messages, views, policies, openLinkMenu, openTabMenu, panel, approve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

let preloadTestId = 0;
async function loadPreload(t) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: new EventTarget(), configurable: true, writable: true });
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", previousWindow);
    ipcRenderer.removeAllListeners();
  });
  ipcRenderer.removeAllListeners();
  controls.invoke = async () => true;
  webFrame.setZoomFactor(1);
  preloadCalls.length = 0;
  await import(`./preload.mjs?geometry-test=${++preloadTestId}`);
  // Existing bootstrap reads are outside the geometry path under test.
  t.mock.method(ipcRenderer, "sendSync", () => { throw new Error("Geometry must not use synchronous IPC"); });
  return exposed.__OPENWORK_ELECTRON__.browser;
}

test("browser manager construction before app readiness defers session hooks until the first tab", async (t) => {
  controls.ready = false;
  t.after(() => { controls.ready = true; });
  const { invoke } = createPanel();
  assert.equal(browserSession.listenerCount("will-download"), 0);
  controls.ready = true;
  invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  assert.equal(browserSession.listenerCount("will-download"), 1, "download tracking is installed once");
  invoke("openwork:browser:destroy");
});

function gate() {
  /** @type {() => void} */
  let finish;
  const promise = new Promise((resolve) => { finish = () => resolve(undefined); });
  return { promise, finish };
}

/** @param {import("node:test").TestContext} t */
function createTaskPanel(t) {
  const panel = createPanel(undefined, 9222);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(panel.views()
    .filter(view => !view.webContents.isDestroyed())
    .map(({ webContents }) => ({ type: "page", id: webContents.targetId, url: webContents.getURL() })))));
  return panel;
}

test("showing the panel sizes the active tab and resets viewport emulation left on it", async () => {
  const { invoke, onScreen, commands } = createPanel();
  invoke("openwork:browser:createTab", "https://example.com");
  assert.equal(onScreen(), null, "a tab created while the panel is hidden stays off screen");
  await flush();

  invoke("openwork:browser:show", PANEL_BOUNDS);
  await flush();

  const view = onScreen();
  assert.ok(view, "the active tab is attached to the window");
  assert.deepEqual(view.getBounds(), PANEL_BOUNDS);
  assert.deepEqual(commands(view), RESET_SEQUENCE);
  assert.equal(view.webContents.debugger.isAttached(), false, "the temporary debugger session is released");
});

test("geometry updates scale fractional edges at changing zoom without replacing or resizing background tabs", async () => {
  const { invoke, mainContents, onScreen, views } = createPanel();
  const bounds = { x: 10.4, y: 21.2, width: 100.8, height: 80.8 };
  invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  invoke("openwork:browser:show", { ...bounds, zoomFactor: 1 }, "A");
  const foreground = onScreen();
  const background = views().find(view => view !== foreground);
  const backgroundBounds = background.getBounds();
  for (const { zoomFactor, expected } of [
    { zoomFactor: 1, expected: { x: 10, y: 21, width: 101, height: 81 } },
    { zoomFactor: 1.25, expected: { x: 13, y: 27, width: 126, height: 101 } },
    { zoomFactor: 0.8, expected: { x: 8, y: 17, width: 81, height: 65 } },
  ]) {
    mainContents.zoomFactor = zoomFactor;
    assert.equal(invoke("openwork:browser:bounds", { ...bounds, zoomFactor }), true);
    assert.equal(onScreen(), foreground);
    assert.deepEqual(foreground.getBounds(), expected);
    assert.deepEqual(background.getBounds(), backgroundBounds);
  }
  assert.equal(views().length, 2, "geometry never allocates a new page");
});

test("stale zoom snapshots cannot move a view, replace cached bounds, change ownership, or reopen a hidden panel", async () => {
  const { invoke, mainContents, onScreen } = createPanel();
  const a = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  const stale = { ...PANEL_BOUNDS, zoomFactor: 1 };
  assert.equal(invoke("openwork:browser:show", stale, "A"), true);
  const view = onScreen();
  mainContents.zoomFactor = 1.25;
  assert.equal(invoke("openwork:browser:show", stale, "B"), false);
  assert.equal(invoke("openwork:browser:bounds", stale), false);
  assert.equal(invoke("openwork:browser:state").visibleSessionId, "A");
  assert.equal(onScreen(), view);
  assert.deepEqual(view.getBounds(), PANEL_BOUNDS);

  const latest = { x: 640, y: 48, width: 320, height: 600, zoomFactor: 1.25 };
  assert.equal(invoke("openwork:browser:bounds", latest), true);
  const nativeBounds = { x: 800, y: 60, width: 400, height: 750 };
  assert.deepEqual(view.getBounds(), nativeBounds);
  assert.equal(invoke("openwork:browser:bounds", stale), false);
  mainContents.zoomFactor = 0.8;
  await invoke("openwork:browser:selectTab", a.tabId);
  assert.deepEqual(view.getBounds(), nativeBounds, "reattachment never rescales cached CSS with a new zoom");

  invoke("openwork:browser:hide");
  assert.equal(invoke("openwork:browser:show", latest, "B"), false);
  assert.equal(onScreen(), null);
  assert.equal(invoke("openwork:browser:state").visibleSessionId, "A");
  assert.equal(invoke("openwork:browser:show", { ...latest, zoomFactor: 0.8 }, "B"), true);
  assert.notEqual(onScreen(), view);
  assert.equal(invoke("openwork:browser:state").visibleSessionId, "B");
});

test("unstamped geometry keeps the legacy CSS contract and malformed snapshots leave placement intact", () => {
  const { invoke, mainContents, onScreen } = createPanel();
  mainContents.zoomFactor = 1.25;
  invoke("openwork:browser:createTab", "about:blank");
  assert.equal(invoke("openwork:browser:show", PANEL_BOUNDS), true);
  assert.deepEqual(onScreen().getBounds(), { x: 1000, y: 50, width: 500, height: 1125 });
  const latest = { x: 80, y: 40, width: 240, height: 400 };
  assert.equal(invoke("openwork:browser:bounds", latest), true);
  const expected = { x: 100, y: 50, width: 300, height: 500 };
  for (const invalid of [null, { ...latest, x: NaN }, { ...latest, width: 0 },
    { ...latest, zoomFactor: Infinity }, { ...latest, zoomFactor: 0 }, { ...latest, zoomFactor: null }]) {
    assert.equal(invoke("openwork:browser:bounds", invalid), false);
    assert.deepEqual(onScreen().getBounds(), expected);
  }
});

test("preload deduplicates geometry including zoom, invalidates after applied zoom, and preserves show/hide intent", async (t) => {
  const { invoke, mainContents, onScreen } = createPanel();
  invoke("openwork:browser:createTab", "about:blank", "A");
  const browser = await loadPreload(t);
  controls.invoke = async (channel, ...args) => invoke(channel, ...args);
  assert.equal(await browser.show(PANEL_BOUNDS, "A"), true);
  await browser.setBounds({ ...PANEL_BOUNDS });
  assert.equal(preloadCalls.length, 1, "show and same-geometry frames share a dedup cache");
  assert.deepEqual(preloadCalls[0].args, [{ ...PANEL_BOUNDS, zoomFactor: 1 }, "A"]);
  mainContents.zoomFactor = 1.25;
  webFrame.setZoomFactor(1.25);
  await browser.setBounds(PANEL_BOUNDS);
  assert.equal(preloadCalls.length, 2, "equal CSS bounds at a different zoom must still be sent");
  assert.deepEqual(onScreen().getBounds(), { x: 1000, y: 50, width: 500, height: 1125 });
  const resized = { ...PANEL_BOUNDS, x: 700, width: 500 };
  await browser.setBounds(resized);
  await browser.setBounds(resized);
  assert.equal(preloadCalls.length, 3);
  assert.deepEqual(onScreen().getBounds(), { x: 875, y: 50, width: 625, height: 1125 });
  let invalidations = 0;
  window.addEventListener("openwork:browser:bounds-invalidated", () => { invalidations++; });
  ipcRenderer.emit("openwork:browser:bounds-invalidated", {});
  assert.equal(invalidations, 1, "the renderer is explicitly asked to remeasure");
  await browser.setBounds(resized);
  assert.equal(preloadCalls.length, 4, "invalidation forces even identical geometry to be resent");
  await browser.hide();
  assert.equal(onScreen(), null);
  await browser.show(resized, "A");
  await browser.show(resized, "A");
  assert.equal(preloadCalls.length, 7, "show intent is never deduplicated");
  assert.ok(onScreen());
});

test("preload retries rejected zoom snapshots but a late rejection cannot invalidate newer geometry", async (t) => {
  const browser = await loadPreload(t);
  controls.invoke = async () => false;
  assert.equal(await browser.show(PANEL_BOUNDS, "A"), false, "the renderer can retry a rejected show");
  assert.equal(await browser.setBounds(PANEL_BOUNDS), false);
  controls.invoke = async () => true;
  assert.equal(await browser.setBounds(PANEL_BOUNDS), true);
  assert.equal(preloadCalls.length, 3, "rejected geometry cannot poison deduplication");

  const pending = gate();
  controls.invoke = async () => { await pending.promise; return false; };
  const stale = browser.setBounds({ ...PANEL_BOUNDS, width: 300 });
  controls.invoke = async () => true;
  webFrame.setZoomFactor(1.25);
  await browser.setBounds(PANEL_BOUNDS);
  pending.finish();
  assert.equal(await stale, false);
  await browser.setBounds(PANEL_BOUNDS);
  assert.equal(preloadCalls.length, 5, "late rejection leaves the newer accepted snapshot cached");
  assert.equal(preloadCalls[3].args[0].zoomFactor, 1, "zoom is captured before awaiting IPC");
  assert.equal(preloadCalls[4].args[0].zoomFactor, 1.25);
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
  const { invoke, onScreen, commands, children, messages, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const visibleView = onScreen();
  await flush();
  commands(visibleView).length = 0;

  const { tabId } = invoke("openwork:browser:createTab", "https://b.example", "B");
  await flush();

  const state = invoke("openwork:browser:state");
  const backgroundTab = state.tabs.find((tab) => tab.id === tabId);
  const backgroundView = views().find((view) => view !== visibleView);
  assert.deepEqual(children, [visibleView], "background content stays detached from the window");
  assert.equal(onScreen(), visibleView, "the visible conversation keeps its tab on screen");
  assert.equal(state.activeTabId, state.tabs.find((tab) => tab.ownerSessionId === "A").id);
  assert.equal(backgroundTab.ownerSessionId, "B");
  assert.equal(state.activeTabIdByOwner.B, tabId, "the tab is B's active tab, ready for when B is opened");
  assert.deepEqual(backgroundView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
  assert.deepEqual(commands(backgroundView), BACKGROUND_SEQUENCE, "the page lays out and focuses like a visible one");
  assert.equal(backgroundView.webContents.debugger.isAttached(), true, "our emulation session stays open while unseen");
  assert.deepEqual(commands(visibleView), [], "the visible tab is untouched");
  assert.equal(messages("openwork:browser:panel-opened").at(-1).tab.id, tabId, "the explicit open selects B's page only in B's panel");
  assert.equal(messages("openwork:browser:panel-opened").at(-1).ownerSessionId, "B");

  // Even an unexpectedly large background surface must not intercept the app.
  backgroundView.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  invoke("openwork:browser:hide");
  assert.deepEqual(children, []);
  assert.equal(onScreen(), null);
  assert.ok(invoke("openwork:browser:state").nativeViews.every((view) => !view.aboveApp));
});

test("navigating a background conversation's tab reports its owner instead of taking the screen", async () => {
  const { invoke, onScreen, messages, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const visibleView = onScreen();
  const { tabId } = invoke("openwork:browser:createTab", "https://b.example", "B");
  const backgroundView = views().find((view) => view !== visibleView);
  await flush();

  backgroundView.webContents.emit("did-start-navigation", "https://b.example/next", false, true);
  await flush();

  assert.equal(onScreen(), visibleView, "A's tab stays on screen");
  const opens = messages("openwork:browser:panel-opened");
  assert.equal(opens.at(-2).tab.id, tabId, "the explicit open selects its page");
  assert.deepEqual(opens.at(-1), { ownerSessionId: "B" }, "later navigation does not override an artifact selection");
});

test("switching to the background conversation swaps its tab on screen and restores a normal viewport", async () => {
  const { invoke, onScreen, commands, children, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const aView = onScreen();
  invoke("openwork:browser:createTab", "https://b.example", "B");
  const bView = views().find((view) => view !== aView);
  await flush();
  commands(aView).length = 0;
  commands(bView).length = 0;

  invoke("openwork:browser:setVisibleSession", "B");
  await flush();

  assert.equal(onScreen(), bView, "B's tab takes the screen");
  assert.deepEqual(children, [bView], "the previous foreground view detaches from the window");
  assert.deepEqual(bView.getBounds(), PANEL_BOUNDS);
  assert.deepEqual(commands(bView), FOREGROUND_SEQUENCE, "B's emulation is undone before it is shown");
  assert.equal(bView.webContents.debugger.isAttached(), false, "our session is released for the user-driven reset path");
  assert.deepEqual(commands(aView), BACKGROUND_SEQUENCE, "A's tab now keeps painting in the background");
  assert.deepEqual(aView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
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

test("capacity refuses allocation without replacing existing tabs and closing frees a slot", async () => {
  const { invoke, views } = createPanel();
  const limit = invoke("openwork:browser:state").tabLimit;
  assert.equal(limit, 12);
  for (let i = 0; i < limit; i++) invoke("openwork:browser:createTab", "about:blank", `owner-${i}`);
  const before = invoke("openwork:browser:state");
  assert.throws(() => invoke("openwork:browser:createTab", "about:blank", "overflow"), /12 browser tabs open.*Close.*try again/);
  await assert.rejects(invoke("openwork:browser:openUrl", "https://example.com", "builtin", { sessionId: "overflow" }), /12 browser tabs open/);
  assert.equal(views().length, limit, "rejection allocates no native view");
  assert.deepEqual(invoke("openwork:browser:state").tabs, before.tabs);
  invoke("openwork:browser:closeTab", before.tabs[0].id);
  assert.equal(views()[0].webContents.isDestroyed(), true);
  invoke("openwork:browser:createTab", "about:blank", "retry");
  assert.equal(invoke("openwork:browser:state").tabs.length, limit);
});

test("owner cleanup is exact and idempotent and releases only an empty background host", async () => {
  const { invoke, views, messages } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", null);
  const b = invoke("openwork:browser:createTab", "about:blank", "B");
  const c = invoke("openwork:browser:createTab", "about:blank", "C");
  await flush();
  for (const invalid of [undefined, null, "", "   ", 1]) assert.deepEqual(invoke("openwork:browser:closeSessionTabs", invalid), []);
  assert.deepEqual(invoke("openwork:browser:closeSessionTabs", "B"), [b.tabId]);
  assert.deepEqual(invoke("openwork:browser:closeSessionTabs", "B"), []);
  assert.equal(views()[2].webContents.isDestroyed(), true);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 1, "C still uses the hidden host");
  assert.deepEqual(invoke("openwork:browser:closeSessionTabs", "C"), [c.tabId]);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.ownerSessionId), ["A", null]);
  assert.ok(views().slice(0, 2).every(view => !view.webContents.isDestroyed()));
  assert.deepEqual(messages("openwork:browser:panel-closed"), [{ ownerSessionId: "B" }, { ownerSessionId: "C" }]);
  invoke("openwork:browser:closeAllTabs");
  assert.ok(views().every(view => view.webContents.isDestroyed()));
});

test("external target destruction releases owner state and the empty hidden host", async () => {
  const { invoke, views } = createPanel();
  invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  views()[0].webContents.close();
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
});

test("failed navigation rolls back its allocation while another owner's page survives", async (t) => {
  const { invoke, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  await flush();
  const before = invoke("openwork:browser:state");
  t.mock.method(navigation, "load", async () => { throw new Error("ERR_UNSAFE_PORT"); });
  const opening = invoke("openwork:browser:openUrl", "http://127.0.0.1:1", "builtin", { sessionId: "B" });
  await flush();
  invoke("openwork:browser:setVisibleSession", "B");
  approve();
  await assert.rejects(opening, { code: "browser_operation_failed" });
  invoke("openwork:browser:setVisibleSession", "A");
  assert.deepEqual(invoke("openwork:browser:state").tabs, before.tabs);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
  assert.equal(views()[1].webContents.isDestroyed(), true);
  assert.equal(views()[0].webContents.isDestroyed(), false);
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

test("suspension requires explicit confirmation with Cancel as both defaults and never falls back to the active tab", async () => {
  const { invoke, views } = createPanel();
  const { tabId } = invoke("openwork:browser:createTab", "https://example.com", "A");
  await flush();
  const before = invoke("openwork:browser:state").tabs;
  controls.confirm = async (options) => {
    assert.equal(options.title, "Suspend browser tab?");
    assert.equal(options.type, "warning");
    assert.deepEqual(options.buttons, ["Cancel", "Suspend"]);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.match(options.detail, /Form input, scroll position, and page history will be lost/);
    return 0;
  };
  assert.equal(await invoke("openwork:browser:suspendTab", tabId), null);
  for (const id of [undefined, null, "", "missing"]) await assert.rejects(invoke("openwork:browser:suspendTab", id), /Unknown/);
  assert.deepEqual(invoke("openwork:browser:state").tabs, before);
  assert.equal(views()[0].webContents.isDestroyed(), false);
  assert.equal(effects.length, 1);
});

test("confirmed suspension frees native resources but retains identity and owner until an explicit selection reloads", async () => {
  const { invoke, views, messages } = createPanel();
  const { tabId } = invoke("openwork:browser:createTab", "https://example.com/form", "B");
  controls.confirm = async () => 1;
  for (let cycle = 0; cycle < 4; cycle++) {
    await flush();
    const previous = views().at(-1);
    assert.equal(await invoke("openwork:browser:suspendTab", tabId), tabId);
    assert.equal(previous.webContents.isDestroyed(), true);
    invoke("openwork:browser:setVisibleSession", "A");
    invoke("openwork:browser:show", PANEL_BOUNDS, "B");
    invoke("openwork:browser:bounds", PANEL_BOUNDS);
    const state = invoke("openwork:browser:state");
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].id, tabId);
    assert.equal(state.tabs[0].ownerSessionId, "B");
    assert.equal(state.tabs[0].url, "https://example.com/form");
    assert.equal(state.tabs[0].status, "suspended");
    assert.equal(state.tabs[0].automationProtected, false);
    assert.equal(state.activeTabIdByOwner.B, tabId);
    assert.deepEqual(state.nativeViews, []);
    assert.equal(state.backgroundWindowCount, 0);
    assert.deepEqual(messages("openwork:browser:panel-closed"), []);
    assert.equal(await invoke("openwork:browser:selectTab", tabId), tabId);
    assert.notEqual(views().at(-1), previous);
    assert.deepEqual(views().at(-1).webContents.loads, ["https://example.com/form"]);
    assert.equal(views().filter(view => !view.webContents.isDestroyed()).length, 1);
    assert.equal(invoke("openwork:browser:state").tabs[0].automationProtected, false);
  }
  invoke("openwork:browser:closeSessionTabs", "B");
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
});

test("automation is protected before navigation consent and returns its native target only after first-document background emulation", async (t) => {
  const { invoke, views, commands, approve } = createTaskPanel(t);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  const document = gate();
  const emulation = gate();
  controls.beforeLoad = () => document.promise;
  controls.beforeCommand = () => emulation.promise;
  let returned = false;
  const opening = invoke("openwork:browser:openUrl", "https://example.com", "builtin", { sessionId: "B" });
  void opening.then(() => { returned = true; });
  await flush();
  const tab = invoke("openwork:browser:state").tabs[0];
  assert.equal(tab.automationProtected, true);
  assert.deepEqual(views()[0].webContents.loads, [], "navigation waits for the owner's consent");
  assert.deepEqual(commands(views()[0]), [], "no Emulation before the first dom-ready");
  await assert.rejects(invoke("openwork:browser:suspendTab", tab.id), /protected or busy/);
  assert.throws(() => invoke("openwork:browser:releaseTab", tab.id, "B"), /busy/);
  assert.equal(approve(true, tab.id), true);
  await flush();
  assert.deepEqual(views()[0].webContents.loads, ["https://example.com/"], "the approved destination loads without a marker page");
  invoke("openwork:browser:setVisibleSession", "A");
  assert.deepEqual(commands(views()[0]), [], "background emulation still waits for the first document");
  await assert.rejects(invoke("openwork:browser:suspendTab", tab.id), /protected or busy/);
  assert.throws(() => invoke("openwork:browser:releaseTab", tab.id, "B"), /busy/);
  document.finish();
  await flush();
  assert.equal(returned, false, "a ready document alone is not a usable background handle");
  emulation.finish();
  const handle = await opening;
  assert.equal(handle.tab_id, tab.id);
  assert.equal(handle.target_id, views()[0].webContents.targetId);
  assert.equal(handle.owner_session_id, "B");
  assert.deepEqual(commands(views()[0]), BACKGROUND_SEQUENCE);
  const loads = [...views()[0].webContents.loads];
  assert.equal((await invoke("openwork:browser:restoreTab", tab.id, "B")).target_id, handle.target_id);
  assert.deepEqual(views()[0].webContents.loads, loads, "reacquiring a live page never navigates it");
  assert.deepEqual(effects, [], "protected suspension never opens the confirmation dialog");
});

test("restore and release enforce exact ownership and protection lasts until explicit release", async (t) => {
  const { invoke, views, approve } = createTaskPanel(t);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  const opening = invoke("openwork:browser:openUrl", "https://example.com", "builtin", { sessionId: "B" });
  await flush();
  assert.deepEqual(views()[0].webContents.loads, [], "navigation waits for the owner's consent");
  assert.equal(approve(), true);
  const first = await opening;
  const tabId = first.tab_id;
  controls.confirm = async () => 1;
  for (const owner of [undefined, null, "", "A"]) {
    await assert.rejects(invoke("openwork:browser:restoreTab", tabId, owner), /owner mismatch/);
    assert.throws(() => invoke("openwork:browser:releaseTab", tabId, owner), /owner mismatch/);
  }
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /protected/);
  assert.deepEqual(invoke("openwork:browser:releaseTab", tabId, "B"), { tabId, released: true });
  assert.equal(views()[0].webContents.isDestroyed(), false, "release is not a close or navigation");
  await invoke("openwork:browser:suspendTab", tabId);
  const suspended = invoke("openwork:browser:state").tabs;
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "A"), /owner mismatch/);
  assert.equal(views().length, 1, "ownership is checked before allocating a native page");
  assert.deepEqual(invoke("openwork:browser:state").tabs, suspended);
  const restored = await invoke("openwork:browser:restoreTab", tabId, "B");
  assert.equal(restored.tab_id, tabId);
  assert.equal(restored.owner_session_id, "B");
  assert.notEqual(restored.target_id, first.target_id);
  assert.deepEqual(views()[1].webContents.loads, [first.url]);
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /protected/);
  views()[1].webContents.close();
  assert.deepEqual(invoke("openwork:browser:state").tabs, [], "ordinary CDP close still deletes the logical tab");
});

test("confirmation rechecks the captured page for active work, loading, downloads, and media", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { invoke, views } = createTaskPanel(t);
  const { tabId } = invoke("openwork:browser:createTab", "https://example.com", "B");
  await flush();
  const contents = views()[0].webContents;
  for (const field of ["loading", "audible"]) {
    controls.confirm = async () => { contents[field] = true; return 1; };
    await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /loading, downloading, or playing/);
    contents[field] = false;
  }
  controls.confirm = async () => { contents.emit("media-started-playing"); return 1; };
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /playing media/);
  contents.emit("media-paused");
  const download = new EventEmitter();
  controls.confirm = async () => { browserSession.emit("will-download", null, download, contents); return 1; };
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /downloading/);
  download.emit("done");
  controls.confirm = async () => { await invoke("openwork:browser:restoreTab", tabId, "B"); return 1; };
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /protected/);
  invoke("openwork:browser:releaseTab", tabId, "B");
  const other = invoke("openwork:browser:createTab", "about:blank", "B");
  controls.confirm = async () => { invoke("openwork:browser:closeTab", tabId); return 1; };
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /Unknown/);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.id), [other.tabId]);
});

test("beforeunload veto leaves the live document intact and pending close retains capacity even after timeout", async (t) => {
  const { invoke, views } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  const { tabId } = invoke("openwork:browser:createTab", "https://example.com", "A");
  await flush();
  const contents = views()[0].webContents;
  controls.confirm = async () => 1;
  contents.closeMode = "veto";
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /page prevented/);
  assert.equal(contents.isDestroyed(), false);
  assert.equal(invoke("openwork:browser:state").tabs[0].status, "ready");
  for (let i = 1; i < 12; i++) invoke("openwork:browser:createTab", "about:blank", "A");
  await invoke("openwork:browser:selectTab", tabId);
  contents.closeMode = "pending";
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = invoke("openwork:browser:suspendTab", tabId);
  const rejected = assert.rejects(pending, /still waiting to close/);
  await flush();
  assert.equal(invoke("openwork:browser:state").tabs[0].status, "suspending");
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "A"), /busy/);
  await assert.rejects(invoke("openwork:browser:selectTab", tabId), /suspending/);
  assert.throws(() => invoke("openwork:browser:reload"), /suspending/);
  t.mock.timers.tick(2501);
  await rejected;
  assert.throws(() => invoke("openwork:browser:createTab", "about:blank"), /12 browser tabs/);
  assert.equal(invoke("openwork:browser:state").nativeViews.length, 12);
  contents.close();
  assert.equal(invoke("openwork:browser:state").tabs[0].status, "suspended");
  invoke("openwork:browser:createTab", "about:blank");
  assert.equal(invoke("openwork:browser:state").tabs.length, 13);
});

test("failed and capacity-blocked restoration preserve saved metadata and a retry returns the same logical tab", async (t) => {
  const { invoke, views } = createTaskPanel(t);
  const { tabId } = invoke("openwork:browser:createTab", "https://example.com", "B");
  await flush();
  controls.confirm = async () => 1;
  await invoke("openwork:browser:suspendTab", tabId);
  const saved = invoke("openwork:browser:state").tabs[0];
  controls.beforeLoad = async () => { throw new Error("Navigation failed"); };
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "B"), /Navigation failed/);
  assert.deepEqual(invoke("openwork:browser:state").tabs, [saved]);
  assert.ok(views().every(view => view.webContents.isDestroyed()));
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
  controls.beforeLoad = async () => {};
  controls.beforeCommand = async (method) => { if (method === "Target.getTargetInfo") throw new Error("Target failed"); };
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "B"), /Target failed/);
  assert.deepEqual(invoke("openwork:browser:state").tabs, [saved]);
  controls.beforeCommand = async () => {};
  for (let i = 0; i < 12; i++) invoke("openwork:browser:createTab", "about:blank", "A");
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "B"), /12 browser tabs/);
  assert.deepEqual(invoke("openwork:browser:state").tabs[0], saved);
  invoke("openwork:browser:closeSessionTabs", "A");
  assert.equal((await invoke("openwork:browser:restoreTab", tabId, "B")).tab_id, tabId);
});

test("deletion cancels pending suspension and restoration without resurrecting saved tabs", async (t) => {
  const { invoke, views } = createTaskPanel(t);
  controls.confirm = async () => 1;
  const { tabId } = invoke("openwork:browser:createTab", "https://example.com", "B");
  await flush();
  views()[0].webContents.closeMode = "pending";
  const suspending = invoke("openwork:browser:suspendTab", tabId);
  const closed = assert.rejects(suspending, /closed/);
  await flush();
  invoke("openwork:browser:closeSessionTabs", "B");
  await closed;
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);

  const saved = invoke("openwork:browser:createTab", "https://example.com", "B");
  await flush();
  await invoke("openwork:browser:suspendTab", saved.tabId);
  const loading = gate();
  controls.beforeLoad = () => loading.promise;
  const restoring = invoke("openwork:browser:restoreTab", saved.tabId, "B");
  const cancelled = assert.rejects(restoring, /destroyed|closed/);
  await assert.rejects(invoke("openwork:browser:restoreTab", saved.tabId, "B"), /busy/);
  assert.equal(invoke("openwork:browser:state").nativeViews.length, 1);
  invoke("openwork:browser:closeAllTabs");
  loading.finish();
  await cancelled;
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
  assert.ok(views().every(view => view.webContents.isDestroyed()));

  controls.beforeLoad = async () => {};
  for (const channel of ["closeTab", "closeSessionTabs", "closeAllTabs", "destroy"]) {
    const next = invoke("openwork:browser:createTab", "about:blank", "B");
    await flush();
    await invoke("openwork:browser:suspendTab", next.tabId);
    invoke(`openwork:browser:${channel}`, channel === "closeSessionTabs" ? "B" : next.tabId);
    assert.deepEqual(invoke("openwork:browser:state").tabs, []);
    await assert.rejects(invoke("openwork:browser:selectTab", next.tabId), /Unknown/);
  }
});

test("a native choice launches only the selected installed or default browser with the exact link", async () => {
  for (const itemId of ["browser:chrome", "browser:firefox", "open-external"]) {
    const { openLinkMenu, invoke, policies, views } = createPanel();
    const { request, choose } = await openLinkMenu();
    assert.deepEqual(request, {
      point: LINK.point,
      items: [
        { type: "item", id: "open-builtin", label: "Open in OpenWork" },
        { type: "item", id: "open-external", label: "Open in Default Browser" },
        { type: "item", id: "browser:chrome", label: "Open in Google Chrome" },
        { type: "item", id: "browser:firefox", label: "Open in Firefox" },
        { type: "separator" },
        { type: "item", id: "copy-url", label: "Copy Link Address" },
      ],
    });
    assert.deepEqual(policies, [], "showing the popup does not open the destination");
    assert.deepEqual(effects, []);
    choose(itemId);
    await flush();

    assert.deepEqual(policies, [{ url: LINK.url, external: true }]);
    assert.deepEqual(effects, [itemId === "open-external"
      ? { type: "external", url: LINK.url }
      : { type: "browser", id: itemId.slice("browser:".length), url: LINK.url }]);
    assert.deepEqual(invoke("openwork:browser:state").tabs, []);
    assert.deepEqual(views(), [], "native menus allocate no overlay renderer");
  }
});

test("external policy denial prevents catalog and default launches without a built-in fallback", async () => {
  for (const itemId of ["browser:firefox", "open-external"]) {
    const { openLinkMenu, invoke, policies } = createPanel(async () => { throw new Error("blocked"); });
    const { choose } = await openLinkMenu();
    choose(itemId);
    await flush();

    assert.deepEqual(policies, [{ url: LINK.url, external: true }], itemId);
    assert.deepEqual(effects, [{ type: "dialog" }], itemId);
    assert.deepEqual(invoke("openwork:browser:state").tabs, [], itemId);
  }
});

test("copying a link neither checks policy nor launches a browser", async () => {
  const { openLinkMenu, invoke, policies } = createPanel(async () => { throw new Error("blocked"); });
  const { choose } = await openLinkMenu();
  choose("copy-url");
  await flush();

  assert.deepEqual(effects, [{ type: "copy", url: LINK.url }]);
  assert.deepEqual(policies, []);
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
});

test("link menus reject untrusted senders, subframes, unsafe URLs and invalid points", async () => {
  const { emit, invoke, mainContents, views, policies, menus } = createPanel();
  emit("openwork:browser:linkContextMenu", { sender: {}, senderFrame: mainContents.mainFrame }, LINK);
  emit("openwork:browser:linkContextMenu", { sender: mainContents, senderFrame: {} }, LINK);
  for (const url of ["javascript:alert(1)", "file:///tmp/link.html", "data:text/html,link", "openwork://settings", "https://user:password@example.com", "https://example.com/\npath", "https://example.com/\u007f", `https://example.com/${"a".repeat(32_768)}`]) {
    invoke("openwork:browser:linkContextMenu", { ...LINK, url });
  }
  for (const point of [null, {}, { x: "20", y: 30 }, { x: NaN, y: 30 }, { x: 20, y: Infinity }]) {
    invoke("openwork:browser:linkContextMenu", { ...LINK, point });
  }
  await flush();

  assert.deepEqual(views(), [], "rejected requests never create an overlay or tab");
  assert.deepEqual(menus, []);
  assert.deepEqual(policies, []);
  assert.deepEqual(effects, []);
});

test("the built-in choice retains the captured owner when focus changes before policy completes", async () => {
  /** @type {(() => void) | undefined} */
  let allow;
  const { openLinkMenu, invoke, policies } = createPanel(() => new Promise((resolve) => { allow = resolve; }));
  invoke("openwork:browser:setVisibleSession", "B");
  const { choose } = await openLinkMenu();
  choose("open-builtin");
  await flush();
  assert.deepEqual(policies, [{ url: LINK.url, external: false }]);
  assert.deepEqual(invoke("openwork:browser:state").tabs, [], "navigation waits for policy");
  invoke("openwork:browser:setVisibleSession", "C");
  assert.ok(allow, "the pending policy check exposes its completion");
  allow();
  await flush();

  const state = invoke("openwork:browser:state");
  assert.equal(state.visibleSessionId, "C");
  assert.deepEqual(state.tabs.map(({ url, ownerSessionId }) => ({ url, ownerSessionId })), [{ url: LINK.url, ownerSessionId: "A" }]);
  assert.equal(state.activeTabId, null, "the captured owner's tab does not take the visible conversation");
  assert.deepEqual(effects, []);
});

test("obsolete renderer choice IPC cannot execute actions or dismiss the native menu", async () => {
  const { openLinkMenu, invoke, emit, mainContents, policies } = createPanel();
  invoke("openwork:browser:createTab", "https://existing.example");
  const menu = await openLinkMenu();
  const tabs = invoke("openwork:browser:state").tabs;
  policies.length = 0;
  for (const sender of [{}, mainContents]) {
    for (const itemId of ["browser:firefox", "copy-url", "close-all-tabs"]) {
      emit("openwork:menu-overlay:choose", { sender, senderFrame: mainContents.mainFrame }, { requestId: "forged", itemId });
    }
  }
  await flush();

  assert.deepEqual(policies, []);
  assert.deepEqual(effects, []);
  assert.deepEqual(invoke("openwork:browser:state").tabs, tabs);
  assert.equal(menu.closed, false, "renderer choices leave the native menu open");
  menu.choose("copy-url");
  await flush();
  assert.deepEqual(effects, [{ type: "copy", url: LINK.url }]);
});

test("tab menus use native items and CSS coordinates without selecting or replacing the captured tab", async () => {
  for (const itemId of ["copy-url", "open-external", "close-tab", "close-all-tabs"]) {
    const { invoke, openTabMenu, views, policies, mainContents } = createPanel();
    invoke("openwork:browser:setVisibleSession", "A");
    const first = invoke("openwork:browser:createTab", LINK.url, "A");
    const second = invoke("openwork:browser:createTab", "https://second.example/", "A");
    await flush();
    policies.length = 0;
    mainContents.getZoomFactor = () => 1.75;
    const point = { x: 20.25, y: 30.75 };
    const { request, choose, done } = await openTabMenu(first.tabId, point);
    assert.deepEqual(request, {
      point,
      items: [
        { type: "item", id: "copy-url", label: "Copy URL", enabled: true },
        { type: "item", id: "open-external", label: "Open in Browser", enabled: true },
        { type: "separator" },
        { type: "item", id: "close-tab", label: "Close Tab" },
        { type: "item", id: "close-all-tabs", label: "Close All Tabs" },
      ],
    });
    assert.equal(invoke("openwork:browser:state").activeTabId, second.tabId);
    assert.equal(views().length, 2, "no native view is allocated for the menu");
    choose(itemId);
    await done;
    const remaining = invoke("openwork:browser:state").tabs.map((tab) => tab.id);
    assert.deepEqual(remaining, itemId === "close-all-tabs" ? [] : itemId === "close-tab" ? [second.tabId] : [first.tabId, second.tabId]);
    assert.deepEqual(policies, itemId === "open-external" ? [{ url: LINK.url, external: true }] : []);
    assert.deepEqual(effects, itemId === "copy-url" ? [{ type: "copy", url: LINK.url }] : itemId === "open-external" ? [{ type: "external", url: LINK.url }] : []);
  }
});

test("native results cannot invoke disabled, missing, or cross-menu action IDs", async () => {
  const { openLinkMenu, openTabMenu, invoke, policies } = createPanel();
  const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
  await flush();
  policies.length = 0;
  for (const itemId of ["copy-url", "open-external", "open-builtin", "browser:firefox", "forged", undefined]) {
    const { request, choose, done } = await openTabMenu(tabId);
    assert.equal(request.items.find((item) => item.id === "copy-url").enabled, false);
    assert.equal(request.items.find((item) => item.id === "open-external").enabled, false);
    choose(itemId);
    await done;
  }
  for (const itemId of ["browser:unlisted", "close-tab", "close-all-tabs", undefined]) {
    const { choose } = await openLinkMenu();
    choose(itemId);
    await flush();
  }
  assert.deepEqual(policies, []);
  assert.deepEqual(effects, []);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map((tab) => tab.id), [tabId]);
});

test("tab external actions remain policy checked and non-HTTP addresses cannot launch", async () => {
  const { openTabMenu, invoke, views, policies } = createPanel(async () => { throw new Error("blocked"); });
  const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
  await flush();
  views()[0].webContents.url = "file:///tmp/local.html";
  policies.length = 0;
  const blocked = await openTabMenu(tabId);
  assert.equal(blocked.request.items.find((item) => item.id === "open-external").enabled, false);
  blocked.choose("open-external");
  await blocked.done;
  assert.deepEqual(policies, []);
  views()[0].webContents.url = LINK.url;
  const denied = await openTabMenu(tabId);
  const rejection = assert.rejects(denied.done, /blocked/);
  denied.choose("open-external");
  await rejection;
  assert.deepEqual(policies, [{ url: LINK.url, external: true }]);
  assert.deepEqual(effects, []);
  assert.equal(invoke("openwork:browser:state").tabs.length, 1);
});

test("link points stay in CSS coordinates and native cancellation releases listeners without closing another popup", async () => {
  const { openLinkMenu, mainContents, mainWindow, views, policies } = createPanel();
  mainContents.getZoomFactor = () => 2;
  const point = { x: 25.25, y: 40.75 };
  const menu = await openLinkMenu({ ...LINK, point });
  assert.deepEqual(menu.request.point, point);
  assert.equal(mainWindow.listenerCount("blur"), 1);
  menu.choose(null);
  await flush();
  assert.deepEqual(effects, []);
  assert.deepEqual(policies, []);
  assert.deepEqual(views(), []);
  assert.equal(menu.closed, false, "the helper already dismissed or superseded this popup");
  assert.equal(mainWindow.listenerCount("blur"), 0);
  assert.equal(mainContents.listenerCount("did-start-navigation"), 0);
  assert.equal(mainContents.listenerCount("destroyed"), 0);
});

test("late installed-browser discovery cannot reopen dismissed, superseded or destroyed menus", async () => {
  for (const ending of ["dismiss", "blur", "navigate", "destroy", "renderer-destroyed", "session", "supersede"]) {
    const { invoke, openLinkMenu, mainWindow, mainContents, menus, policies, views } = createPanel();
    const discovery = gate();
    let calls = 0;
    controls.beforeDiscovery = () => ++calls === 1 ? discovery.promise : undefined;
    invoke("openwork:browser:linkContextMenu", LINK);
    // End the request immediately, even before its first asynchronous turn.
    if (ending === "dismiss") invoke("openwork:menu-overlay:dismiss");
    if (ending === "blur") mainWindow.emit("blur");
    if (ending === "navigate") mainContents.emit("did-start-navigation", null, "http://localhost/next", false, true);
    if (ending === "destroy") invoke("openwork:browser:destroy");
    if (ending === "renderer-destroyed") { mainContents.destroyed = true; mainContents.emit("destroyed"); }
    if (ending === "session") invoke("openwork:browser:setVisibleSession", "B");
    const newer = ending === "supersede" ? await openLinkMenu({ ...LINK, url: "https://newer.example/" }) : null;
    discovery.finish();
    await flush();
    assert.equal(menus.length, newer ? 1 : 0, ending);
    assert.deepEqual(policies, [], ending);
    assert.deepEqual(effects, [], ending);
    assert.deepEqual(views(), [], ending);
    if (newer) {
      assert.equal(newer.closed, false, "stale discovery cannot close a newer native popup");
      newer.choose("copy-url");
      await flush();
      assert.deepEqual(effects, [{ type: "copy", url: "https://newer.example/" }]);
    }
    assert.equal(mainWindow.listenerCount("blur"), 0, ending);
  }
});

test("late native selections are ignored after dismissal, blur, navigation or destruction", async () => {
  for (const ending of ["dismiss", "blur", "navigate", "destroy", "renderer-destroyed", "window-destroyed", "session", "hide"]) {
    const { invoke, openLinkMenu, mainWindow, mainContents, policies, views } = createPanel();
    const menu = await openLinkMenu();
    if (ending === "dismiss") invoke("openwork:menu-overlay:dismiss");
    if (ending === "blur") mainWindow.emit("blur");
    if (ending === "navigate") mainContents.emit("did-start-navigation", null, "http://localhost/next", true, true);
    if (ending === "destroy") invoke("openwork:browser:destroy");
    if (ending === "renderer-destroyed") { mainContents.destroyed = true; mainContents.emit("destroyed"); }
    if (ending === "window-destroyed") mainWindow.destroyed = true;
    if (ending === "session") invoke("openwork:browser:show", PANEL_BOUNDS, "B");
    if (ending === "hide") invoke("openwork:browser:hide");
    menu.choose("open-builtin");
    await flush();
    assert.equal(menu.closed, true, ending);
    assert.deepEqual(policies, [], ending);
    assert.deepEqual(effects, [], ending);
    assert.deepEqual(views(), [], ending);
    assert.equal(mainWindow.listenerCount("blur"), 0, ending);
  }
});

test("tab and link popups supersede each other without executing or closing the newer menu", async () => {
  for (const first of ["tab", "link"]) {
    const { invoke, openLinkMenu, openTabMenu, menus, policies } = createPanel();
    const { tabId } = invoke("openwork:browser:createTab", LINK.url, "A");
    await flush();
    policies.length = 0;
    const old = first === "tab" ? await openTabMenu(tabId) : await openLinkMenu();
    const newer = first === "tab" ? await openLinkMenu() : await openTabMenu(tabId);
    old.choose("open-external");
    await flush();
    assert.equal(menus[0].closed, true);
    assert.equal(menus[1].closed, false);
    assert.deepEqual(policies, []);
    assert.deepEqual(effects, []);
    newer.choose("copy-url");
    await flush();
    assert.deepEqual(effects, [{ type: "copy", url: LINK.url }]);
    assert.equal(invoke("openwork:browser:state").tabs.length, 1);
  }
});

test("selected link actions cannot run after a newer request or destroyed document while policy waits", async () => {
  for (const itemId of ["open-builtin", "open-external", "browser:firefox"]) {
    for (const ending of ["supersede", "destroy", "navigate", "renderer-destroyed"]) {
      const policy = gate();
      const { invoke, openLinkMenu, mainContents, policies, views } = createPanel(() => policy.promise);
      const menu = await openLinkMenu();
      menu.choose(itemId);
      await flush();
      assert.deepEqual(policies, [{ url: LINK.url, external: itemId !== "open-builtin" }]);
      const newer = ending === "supersede" ? await openLinkMenu({ ...LINK, url: "https://newer.example/" }) : null;
      if (ending === "destroy") invoke("openwork:browser:destroy");
      if (ending === "navigate") mainContents.emit("did-start-navigation", null, "http://localhost/next", false, true);
      if (ending === "renderer-destroyed") { mainContents.destroyed = true; mainContents.emit("destroyed"); }
      policy.finish();
      await flush();
      assert.deepEqual(effects, [], `${itemId}: ${ending}`);
      assert.deepEqual(views(), [], `${itemId}: ${ending}`);
      if (newer) {
        assert.equal(newer.closed, false);
        newer.choose("copy-url");
        await flush();
        assert.deepEqual(effects, [{ type: "copy", url: "https://newer.example/" }]);
      }
    }
  }
});

test("tab navigation or closure invalidates native choices and policy-pending external actions", async () => {
  for (const selected of [false, true]) {
    for (const ending of ["navigate", "close"]) {
      const policy = gate();
      const { invoke, openTabMenu, views, policies } = createPanel(({ external }) => external ? policy.promise : undefined);
      const first = invoke("openwork:browser:createTab", LINK.url, "A");
      const second = invoke("openwork:browser:createTab", "https://second.example/", "A");
      await flush();
      policies.length = 0;
      const menu = await openTabMenu(first.tabId);
      if (selected) { menu.choose("open-external"); await flush(); }
      if (ending === "navigate") views()[0].webContents.emit("did-start-navigation", "https://next.example/", false, true);
      if (ending === "close") invoke("openwork:browser:closeTab", first.tabId);
      if (!selected) menu.choose("close-all-tabs");
      policy.finish();
      await menu.done;
      assert.deepEqual(policies, selected ? [{ url: LINK.url, external: true }] : []);
      assert.deepEqual(effects, []);
      assert.ok(invoke("openwork:browser:state").tabs.some((tab) => tab.id === second.tabId));
    }
  }
});

test("automation open waits for its owner's consent and then reuses only that owned task tab", async () => {
  const { invoke, onScreen, views, panel, approve } = createPanel(undefined, 9222);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const foreground = onScreen();
  const opening = invoke("openwork:browser:openUrl", "https://b.example/", "builtin", { sessionId: "B" });
  await flush();
  assert.equal(onScreen(), foreground);
  assert.deepEqual(views()[1].webContents.loads, [], "background approval sends no destination load");
  invoke("openwork:browser:setVisibleSession", "B");
  approve();
  const opened = await opening;
  assert.deepEqual(opened, {
    provider: "builtin", browser_url: "http://127.0.0.1:9222", target_id: views()[1].webContents.getOrCreateDevToolsTargetId(),
    tab_id: invoke("openwork:browser:state").activeTabIdByOwner.B, url: "https://b.example/", owner_session_id: "B", visible: true,
  });
  invoke("openwork:browser:setVisibleSession", "A");
  assert.equal(onScreen(), foreground);
  assert.deepEqual(views()[1].webContents.loads, ["https://b.example/"]);
  assert.equal((await panel.browserTask({ sessionId: "B", operation: "open", args: { url: opened.url } })).tabId, opened.tab_id);
  assert.deepEqual(await invoke("openwork:browser:openUrl", opened.url, "builtin", { sessionId: "B" }), { ...opened, visible: false });
  assert.equal(views().length, 2, "both automation rails reuse the owned task tab");
});

test("automation open rejects paused and disabled control before creating or navigating a tab", async () => {
  const { invoke, onScreen, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = invoke("openwork:browser:createTab", "https://a.example/", "A");
  await flush();
  invoke("openwork:browser:taskControl", tabId, "pause");
  const before = invoke("openwork:browser:state");
  const foreground = onScreen();
  const loads = [...foreground.webContents.loads];
  await assert.rejects(invoke("openwork:browser:openUrl", "https://a.example/new", "builtin", { sessionId: "A" }), { code: "paused" });
  invoke("openwork:browser:setControlEnabled", false);
  await assert.rejects(invoke("openwork:browser:openUrl", "https://a.example/new", "builtin", { sessionId: "A" }), { code: "browser_disabled" });
  assert.equal(views().length, 1);
  assert.equal(onScreen(), foreground);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map((tab) => tab.id), before.tabs.map((tab) => tab.id));
  assert.deepEqual(foreground.webContents.loads, loads);
  invoke("openwork:browser:navigate", "https://a.example/person");
  await flush();
  assert.equal(foreground.webContents.getURL(), "https://a.example/person", "human navigation remains separate");
});

test("takeover cancels automation opening during policy and during navigation", async (t) => {
  /** @type {() => void} */
  let releasePolicy;
  const policy = new Promise((resolve) => { releasePolicy = () => resolve(undefined); });
  const { invoke, views, approve } = createPanel(async ({ url }) => { if (url.endsWith("/policy")) await policy; });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = invoke("openwork:browser:createTab", "https://a.example/", "A");
  await flush();
  const beforeDispatch = invoke("openwork:browser:openUrl", "https://a.example/policy", "builtin", { sessionId: "A" });
  invoke("openwork:browser:taskControl", tabId, "pause");
  await assert.rejects(beforeDispatch, { code: "paused" });
  invoke("openwork:browser:taskControl", tabId, "resume");
  releasePolicy();
  await flush();
  assert.equal(views().length, 1, "resuming cannot revive a canceled opening");

  /** @type {() => void} */
  let finishLoad;
  const loading = new Promise((resolve) => { finishLoad = () => resolve(undefined); });
  t.mock.method(navigation, "load", () => loading);
  const inFlight = invoke("openwork:browser:openUrl", "https://a.example/slow", "builtin", { sessionId: "A" });
  await flush();
  assert.equal(views().length, 2);
  approve();
  await flush();
  invoke("openwork:browser:taskControl", tabId, "pause");
  await assert.rejects(inFlight, { code: "paused" });
  assert.equal(views()[1].webContents.stops, 1);
  finishLoad();
  await flush();
  assert.deepEqual(views()[1].webContents.loads, ["https://a.example/slow"]);
  assert.equal(views()[1].webContents.isDestroyed(), true, "a canceled open releases its abandoned page");
  assert.ok(invoke("openwork:browser:state").tabs.every((tab) => tab.browserTask.status === "paused"));
});

test("a first task open stays blank through asynchronous panel mounting and localhost needs explicit consent", async () => {
  const { invoke, panel, views, approve } = createPanel();
  const hooksBefore = requestHooks.length;
  const url = "http://localhost:4173/preview";
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url } });
  await flush();
  const pending = invoke("openwork:browser:state").tabs[0];
  assert.equal(pending.url, "about:blank");
  assert.equal(pending.browserApproval.approveLabel, "Allow origin in this tab");
  assert.match(pending.browserApproval.message, /http:\/\/localhost:4173/);
  assert.deepEqual(views()[0].webContents.loads, []);
  assert.deepEqual(views()[0].webContents.destinations, []);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval.id, pending.browserApproval.id, "mounting preserves the pending review");
  approve();
  const result = await opening;
  assert.equal(result.ok, true);
  assert.equal(invoke("openwork:browser:state").tabs[0].browserTask.status, "idle");
  assert.deepEqual(views()[0].webContents.loads, [url]);
  assert.deepEqual(views()[0].webContents.destinations, [url]);
  assert.equal(requestHooks.length, hooksBefore + 1, "one all-request listener handles both policy and consent");
  const reading = panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId: result.tabId } });
  await flush();
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval.title, "Allow website access?", "navigation did not grant reading or action access");
  approve(false);
  assert.equal((await reading).code, "user_denied");
});

test("denied, canceled, closed and background task opens never load and release their blank tabs", async () => {
  for (const end of ["deny", "cancel", "close", "background"]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const controller = new AbortController();
    const opening = panel.browserTask({ sessionId: end === "background" ? "B" : "A", operation: "open", args: { url: "http://127.0.0.1:4173/" } }, { signal: controller.signal });
    await flush();
    const tab = invoke("openwork:browser:state").tabs[0];
    if (end === "deny") approve(false);
    if (end === "close") invoke("openwork:browser:closeTab", tab.id);
    if (end === "cancel") controller.abort();
    if (end === "background") {
      assert.equal(views()[0].webContents.debugger.isAttached(), false, "an uninitialized consent tab must not enter background emulation");
      assert.deepEqual(views()[0].webContents.debugger.commands, []);
      assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0, "pending consent needs no hidden native host");
      assert.equal(approve(true, tab.id), false, "another visible conversation cannot approve");
      assert.ok(invoke("openwork:browser:state").tabs[0].browserApproval);
      controller.abort();
    }
    assert.equal((await opening).ok, false, end);
    await flush();
    assert.deepEqual(views()[0].webContents.loads, [], end);
    assert.deepEqual(views()[0].webContents.destinations, [], end);
    assert.equal(views()[0].webContents.isDestroyed(), true, end);
    assert.deepEqual(invoke("openwork:browser:state").tabs, [], end);
  }
});

test("the task timeout cancels the longer approval dialog and late acceptance cannot navigate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { invoke, panel, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://slow.example/" } });
  await flush();
  const tab = invoke("openwork:browser:state").tabs[0];
  t.mock.timers.tick(30_000);
  assert.equal((await opening).code, "timeout");
  assert.equal(invoke("openwork:browser:approve", tab.id, tab.browserApproval.id, true), false);
  assert.deepEqual(views()[0].webContents.loads, []);
  assert.deepEqual(views()[0].webContents.destinations, []);
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
});

test("blocked main-window links require navigation consent and retain their originating owner", async () => {
  for (const allowed of [false, true]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    panel.routeBlockedMainWindowNavigation("https://linked.example/private");
    invoke("openwork:browser:setVisibleSession", "B");
    await flush();
    const tab = invoke("openwork:browser:state").tabs[0];
    assert.equal(tab.ownerSessionId, "A", "the destination belongs to the conversation that initiated the navigation");
    assert.equal(tab.browserApproval.approveLabel, "Allow origin in this tab");
    assert.deepEqual(views()[0].webContents.destinations, []);
    assert.equal(approve(true, tab.id), false, "another conversation cannot authorize the destination");
    invoke("openwork:browser:setVisibleSession", "A");
    approve(allowed, tab.id);
    await flush();
    assert.deepEqual(views()[0].webContents.destinations, allowed ? ["https://linked.example/private"] : []);
    if (!allowed) assert.equal(views()[0].webContents.isDestroyed(), true);
  }
});

test("task navigation reuses only exact-origin consent in the same tab", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "http://127.0.0.1:4173/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const navigate = (url) => panel.browserTask({ sessionId: "A", operation: "navigate", args: { tabId, url } });
  assert.equal((await navigate("http://127.0.0.1:4173/next")).ok, true);
  const before = [...views()[0].webContents.loads];
  for (const url of ["http://127.0.0.1:4174/", "https://127.0.0.1:4173/", "http://localhost:4173/", "http://127.0.0.1.example:4173/", "http://2130706433:4175/", "http://[::1]:4173/"]) {
    const navigating = navigate(url);
    await flush();
    assert.deepEqual(views()[0].webContents.loads, before);
    approve(false);
    assert.equal((await navigating).code, "user_denied");
  }
  const accepted = navigate("http://localhost:4173/approved");
  await flush(); approve();
  assert.equal((await accepted).ok, true);
  assert.equal(views()[0].webContents.destinations.at(-1), "http://localhost:4173/approved");
});

test("the request hook holds a cross-origin main-frame redirect before any target request", async (t) => {
  for (const outcome of ["deny", "allow", "cancel", "close", "background"]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const start = "https://redirect.example/";
    const destination = "http://127.0.0.1:4173/private";
    t.mock.method(navigation, "load", async (url, contents) => {
      if (url !== start) return;
      if ((await contents.request(destination)).cancel) throw new Error("redirect blocked");
      contents.url = destination;
    });
    const controller = new AbortController();
    const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: start } }, { signal: controller.signal });
    await flush(); approve();
    await flush();
    assert.deepEqual(views()[0].webContents.destinations, [start]);
    assert.match(invoke("openwork:browser:state").tabs[0].browserApproval.message, /http:\/\/127.0.0.1:4173/);
    const tab = invoke("openwork:browser:state").tabs[0];
    if (outcome === "allow" || outcome === "deny") approve(outcome === "allow");
    if (outcome === "cancel") controller.abort();
    if (outcome === "close") invoke("openwork:browser:closeTab", tab.id);
    if (outcome === "background") {
      invoke("openwork:browser:setVisibleSession", "B");
      assert.equal(approve(true, tab.id), false);
      assert.deepEqual(views()[0].webContents.destinations, [start]);
      controller.abort();
    }
    assert.equal((await opening).ok, outcome === "allow", outcome);
    assert.deepEqual(views()[0].webContents.destinations, outcome === "allow" ? [start, destination] : [start], outcome);
    t.mock.restoreAll();
  }
});

test("navigation grants do not cross tabs or conversations and canceled approval cannot be revived", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://owned.example/" } });
  await flush(); approve();
  const first = await opening;
  assert.equal((await panel.browserTask({ sessionId: "B", operation: "navigate", args: { tabId: first.tabId, url: "https://owned.example/next" } })).code, "wrong_conversation");
  for (const sessionId of ["A", "B"]) {
    const second = panel.browserTask({ sessionId, operation: "open", args: { url: "https://owned.example/second" } });
    await flush();
    const tab = invoke("openwork:browser:state").tabs.at(-1);
    assert.ok(tab.browserApproval, "the first tab's grant is not reused");
    assert.deepEqual(views().at(-1).webContents.loads, []);
    invoke("openwork:browser:closeSessionTabs", sessionId);
    assert.equal((await second).ok, false);
    assert.equal(invoke("openwork:browser:approve", tab.id, tab.browserApproval.id, true), false);
    assert.deepEqual(views().at(-1).webContents.destinations, []);
  }
});

test("managed policy denial precedes loading and is rechecked after navigation acceptance", async () => {
  let blocked = true;
  const { invoke, panel, views, approve } = createPanel(async ({ url, hasUpload }) => {
    if (url !== "about:blank" && (blocked || hasUpload)) throw new Error("managed denial");
  });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const open = () => panel.browserTask({ sessionId: "A", operation: "open", args: { url: "http://localhost:4173/" } });
  assert.equal((await open()).code, "website_blocked");
  assert.equal(views().length, 0);
  blocked = false;
  const revoked = open();
  await flush(); blocked = true; approve();
  assert.equal((await revoked).code, "website_blocked");
  assert.deepEqual(views()[0].webContents.loads, []);
  blocked = false;
  const accepted = open();
  await flush();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  approve();
  assert.equal((await accepted).ok, true);
  const contents = views()[1].webContents;
  assert.deepEqual(await contents.request("http://localhost:4173/upload", { resourceType: "xhr", method: "POST", uploadData: [{}] }), { cancel: true });
  blocked = true;
  assert.deepEqual(await contents.request("https://cdn.example/image", { resourceType: "image" }), { cancel: true });
  assert.deepEqual(await contents.request("http://localhost:4173/next"), { cancel: true });
  assert.deepEqual(contents.destinations, ["http://localhost:4173/"]);
});

test("takeover cancels pending navigation, permits manual browsing without grants, and requires fresh consent on resume", async () => {
  const { invoke, emit, panel, views, approve, mainContents } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
  await flush();
  const url = "http://localhost:4173/";
  const navigate = () => panel.browserTask({ sessionId: "A", operation: "navigate", args: { tabId, url } });
  const pending = navigate();
  await flush();
  const approvalId = invoke("openwork:browser:state").tabs[0].browserApproval.id;
  invoke("openwork:browser:taskControl", tabId, "pause");
  assert.equal((await pending).ok, false);
  assert.deepEqual(views()[0].webContents.destinations, []);
  assert.equal((await navigate()).code, "paused");
  assert.deepEqual(await views()[0].webContents.request("https://late-redirect.example/"), { cancel: true }, "a late task redirect is not manual browsing");
  const contents = views()[0].webContents;
  for (const [event, type] of [["before-input-event", "keyDown"], ["before-mouse-event", "mouseDown"]]) {
    contents.emit(event, { type });
    assert.deepEqual(await contents.request("https://queued-input.example/"), { cancel: true }, "post-pause page input cannot authorize navigation");
  }
  for (const channel of ["navigate", "back", "forward", "reload"]) {
    for (const event of [{ sender: contents, senderFrame: {} }, { sender: mainContents, senderFrame: {} }]) {
      assert.throws(() => emit(`openwork:browser:${channel}`, event, url), /browser toolbar/);
      assert.deepEqual(await contents.request("https://forged-toolbar.example/"), { cancel: true });
    }
  }
  assert.deepEqual(contents.destinations, [], "neither queued input nor a forged toolbar message contacts a destination");
  invoke("openwork:browser:navigate", url);
  await flush();
  assert.deepEqual(views()[0].webContents.destinations, [url], "manual takeover navigation is still available");
  invoke("openwork:browser:taskControl", tabId, "resume");
  assert.equal(invoke("openwork:browser:approve", tabId, approvalId, true), false);
  const resumed = navigate();
  await flush();
  assert.deepEqual(views()[0].webContents.destinations, [url]);
  approve(false);
  assert.equal((await resumed).code, "user_denied");
});

test("a request already waiting on managed policy cannot become manual traffic after takeover", async () => {
  /** @type {() => void} */
  let release = () => assert.fail("The managed-policy request has not reached its wait point.");
  const { invoke, panel, views, approve } = createPanel(async ({ url, method }) => {
    if (method && url.endsWith("/held")) await new Promise((resolve) => { release = () => resolve(undefined); });
  });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://owned.example/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const request = views()[0].webContents.request("https://other.example/held");
  await flush();
  invoke("openwork:browser:taskControl", tabId, "pause");
  invoke("openwork:browser:taskControl", tabId, "resume");
  release();
  assert.deepEqual(await request, { cancel: true });
  assert.deepEqual(views()[0].webContents.destinations, ["https://owned.example/"]);
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval, null);
});

test("hiding a tab during post-acceptance policy checking withholds navigation and its grant", async () => {
  let hold = false;
  /** @type {() => void} */
  let release = () => assert.fail("The post-acceptance policy check has not reached its wait point.");
  const { invoke, panel, views, approve } = createPanel(async () => {
    if (hold) await new Promise((resolve) => { release = () => resolve(undefined); });
  });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "http://localhost:4173/" } });
  await flush();
  hold = true;
  approve();
  await flush();
  invoke("openwork:browser:hide");
  hold = false;
  release();
  assert.equal((await opening).code, "needs_attention");
  assert.deepEqual(views()[0].webContents.loads, []);
  assert.deepEqual(views()[0].webContents.destinations, []);
  assert.equal(views()[0].webContents.isDestroyed(), true);
});

test("task popups inherit the navigation gate but no grants, including late popups after pause", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const url = "https://owned.example/";
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url } });
  await flush(); approve();
  const { tabId } = await opening;
  const popup = () => views()[0].webContents.windowOpenHandler({ url, disposition: "foreground-tab" }).createWindow({});
  const child = popup();
  const pending = child.request(url);
  await flush();
  assert.deepEqual(child.destinations, []);
  approve(false);
  assert.deepEqual(await pending, { cancel: true });
  invoke("openwork:browser:taskControl", tabId, "pause");
  const lateChild = popup();
  assert.deepEqual(await lateChild.request(url), { cancel: true });
  assert.deepEqual(lateChild.destinations, []);
});

test("adopting a manual popup guards its existing opener without sharing the popup's grant", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const url = "https://related.example/";
  const privateUrl = "http://127.0.0.1:4173/private";
  const openerTab = invoke("openwork:browser:createTab", url, "A");
  await flush();
  const opener = views()[0].webContents;
  const popup = opener.windowOpenHandler({ url, disposition: "foreground-tab" }).createWindow({});
  await popup.loadURL(url);
  const popupId = invoke("openwork:browser:state").activeTabId;
  const adopting = panel.browserTask({ sessionId: "A", operation: "open", args: { tabId: popupId, url } });
  await flush(); approve();
  assert.equal((await adopting).ok, true);

  // This is the destination hook Chromium invokes when the adopted popup sets
  // window.opener.location. The pre-existing opener must not remain unguarded.
  assert.deepEqual(await opener.request(privateUrl), { cancel: true });
  assert.deepEqual(opener.destinations, [url]);
  invoke("openwork:browser:selectTab", openerTab.tabId);
  const sameOrigin = opener.request(url);
  await flush();
  assert.ok(invoke("openwork:browser:state").tabs[0].browserApproval, "the popup's grant does not authorize its opener");
  approve(false);
  assert.deepEqual(await sameOrigin, { cancel: true });
  const privateNavigation = opener.request(privateUrl);
  await flush();
  assert.match(invoke("openwork:browser:state").tabs[0].browserApproval.message, /http:\/\/127.0.0.1:4173/);
  assert.deepEqual(opener.destinations, [url], "the private destination is held until its own approval");
  approve();
  assert.deepEqual(await privateNavigation, { cancel: false });
  assert.deepEqual(opener.destinations, [url, privateUrl]);
});

test("parent observations preserve popup approval and grants, but deliberate lifecycle endings still revoke them", async () => {
  for (const ending of ["cancel", "takeover", "close"]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const url = "https://parent.example/";
    const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url } });
    await flush(); approve();
    const { tabId } = await opening;
    const parent = views()[0].webContents;
    const page = { title: "Parent", text: "Parent page", elements: [], viewport: { width: 800, height: 600 } };
    parent.executeJavaScriptInIsolatedWorld = async () => page;
    const observe = (options) => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } }, options);
    const firstObservation = observe();
    await flush(); approve();
    assert.equal((await firstObservation).ok, true);

    const child = parent.windowOpenHandler({ url, disposition: "foreground-tab" }).createWindow({});
    const pending = child.request("http://localhost:4173/preview");
    await flush();
    const childId = invoke("openwork:browser:state").activeTabId;
    const approvalId = invoke("openwork:browser:state").tabs.at(-1).browserApproval.id;
    assert.equal((await observe()).ok, true);
    assert.equal(invoke("openwork:browser:state").tabs.at(-1).browserApproval?.id, approvalId, "observing the parent preserves the pending popup review");
    assert.deepEqual(child.destinations, []);
    approve();
    assert.deepEqual(await pending, { cancel: false });
    assert.equal((await observe()).ok, true);
    assert.deepEqual(await child.request("http://localhost:4173/next"), { cancel: false }, "observing the parent preserves the popup's accepted grant");

    const canceledNavigation = child.request("https://another.example/");
    await flush();
    const canceledApprovalId = invoke("openwork:browser:state").tabs.at(-1).browserApproval.id;
    if (ending === "cancel") {
      /** @type {() => void} */
      let finish = () => assert.fail("The observation has not reached its wait point.");
      parent.executeJavaScriptInIsolatedWorld = () => new Promise((resolve) => { finish = () => resolve(page); });
      const controller = new AbortController();
      const inFlight = observe({ signal: controller.signal });
      await flush();
      controller.abort();
      assert.equal((await inFlight).ok, false);
      finish();
    }
    if (ending === "takeover") invoke("openwork:browser:taskControl", tabId, "pause");
    if (ending === "close") invoke("openwork:browser:closeTab", tabId);
    assert.deepEqual(await canceledNavigation, { cancel: true }, ending);
    assert.equal(invoke("openwork:browser:approve", childId, canceledApprovalId, true), false, ending);
    assert.deepEqual(await child.request("http://localhost:4173/after-ending"), { cancel: true }, "a surviving popup remains guarded after its parent's lifetime ends");
    assert.deepEqual(child.destinations, ["http://localhost:4173/preview", "http://localhost:4173/next"], ending);
  }
});
