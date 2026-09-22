import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

// Keep Electron and installed-browser discovery in memory: these guards must
// never touch the clipboard, show a dialog, or launch a real browser.
const electronStub = `
import { EventEmitter } from "node:events";
export const effects = [];
export const controls = {
  ready: true,
  focusedContents: null,
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
export const menuTemplates = [];
export const Menu = { buildFromTemplate(template) { menuTemplates.push(template); return template; }, setApplicationMenu() {} };
export const createdViews = [];
export const navigation = { load: async () => {} };
export const createdWindows = [];
export class BrowserWindow {
  static getAllWindows() { return []; }
  constructor(options) {
    if (options.show !== false || options.focusable !== false) throw new Error("background host must never show or focus");
    createdWindows.push(this);
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
      input(input) {
        let prevented = false;
        listeners.emit("before-input-event", { preventDefault() { prevented = true; } }, input);
        return prevented;
      },
      setWindowOpenHandler(handler) { this.windowOpenHandler = handler; },
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      getURL() { return this.url; },
      getOrCreateDevToolsTargetId() { return targetId; },
      getTitle() { return ""; },
      copyImageAt(x, y) { effects.push({ type: "image", x, y }); },
      copy() { effects.push({ type: "edit-copy", targetId }); },
      paste() { effects.push({ type: "edit-paste", targetId }); },
      isLoading() { return this.loading; },
      isCurrentlyAudible() { return this.audible; },
      canGoBack() { return false; },
      canGoForward() { return false; },
      // Site tools the document currently registers, as the main-world getTools
      // reader would report them. The single main frame is origin-keyed.
      siteTools: [],
      siteToolCalls: [],
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
        this.emit("did-navigate", url);
        this.domReady = true;
        this.emit("dom-ready");
      },
      stop() { this.stops++; },
      reload() {
        this.emit("did-start-navigation", this.url, false, true);
        this.emit("did-navigate", this.url);
      },
      isFocused() { return controls.focusedContents === this; },
      focus() { controls.focusedContents = this; this.emit("focus"); },
      close(options) {
        if (options?.waitForBeforeUnload && this.closeMode === "pending") return;
        if (options?.waitForBeforeUnload && this.closeMode === "veto") { this.emit("will-prevent-unload"); return; }
        this.destroyed = true; this.emit("destroyed");
      },
    };
    const contents = this.webContents;
    const frame = {
      get url() { return contents.url; },
      get origin() { try { return new URL(contents.url).origin; } catch { return "null"; } },
      parent: null, frames: [], detached: false,
      isDestroyed() { return contents.destroyed; },
      ipc: new EventEmitter(),
      send(_channel, replyChannel) {
        frame.ipc.emit(replyChannel, { senderFrame: frame }, { originAgentCluster: true, domainMatchesHost: true, embedding: null });
      },
      async executeJavaScript(code) {
        if (code.includes("OPENWORK_WEBMCP_LIST")) return contents.siteTools.map((tool) => ({ ...tool, origin: frame.origin }));
        if (code.includes("OPENWORK_WEBMCP_EXECUTE")) { contents.siteToolCalls.push(code); return JSON.stringify({ saved: contents.siteToolCalls.length }); }
        return true;
      },
    };
    frame.framesInSubtree = [frame];
    contents.mainFrame = frame;
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
const { createdViews, createdWindows, effects, controls, browserSession, navigation, requestHooks, exposed, webFrame, preloadCalls, ipcRenderer, menuTemplates } = await import("electron");
const { createApplicationMenu } = await import("./app-menu.mjs");

const PANEL_BOUNDS = { x: 800, y: 40, width: 400, height: 900 };
const LINK = { url: "https://example.com/a%2Fb?x=one%20two&x=%2F#section", point: { x: 20, y: 30 }, sessionId: "A" };
const RESET_SEQUENCE = [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 0, height: 0, deviceScaleFactor: 0, mobile: false } },
  { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
];

function createPanel(checkPolicy = async (_request) => {}, remoteDebugPort = 0) {
  effects.length = 0;
  controls.focusedContents = null;
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
    contentSize: [1600, 1200],
    getContentSize() { return this.contentSize; },
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
      focus() { controls.focusedContents = this; },
    }),
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    close() { this.destroyed = true; },
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
  panel.registerWindowShortcuts(mainWindow);
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

function watchNativePlacement(t, { mainWindow, views }) {
  const snapshots = [];
  const record = () => snapshots.push(mainWindow.contentView.children.map(view => ({
    view, bounds: { ...view.getBounds() }, visible: view.getVisible(), destroyed: view.webContents.isDestroyed(),
  })));
  for (const [target, methods] of [
    [mainWindow.contentView, ["addChildView", "removeChildView"]],
    ...views().map(view => [view, ["setBounds", "setVisible"]]),
  ]) {
    for (const method of methods) {
      const original = target[method].bind(target);
      t.mock.method(target, method, (...args) => {
        const result = original(...args);
        record();
        return result;
      });
    }
  }
  return (expectedView, expectedBounds, visible = true) => {
    record();
    assert.deepEqual(mainWindow.contentView.children, expectedView ? [expectedView] : []);
    for (const snapshot of snapshots.splice(0)) {
      assert.ok(snapshot.length <= 1, "never attach two pages above the app");
      for (const entry of snapshot) {
        assert.equal(entry.view, expectedView, "only the intended page may be attached");
        assert.deepEqual(entry.bounds, expectedBounds, "size before attachment, never at background viewport dimensions");
        assert.equal(entry.visible, visible);
        assert.equal(entry.destroyed, false);
      }
    }
  };
}

function enforceDebuggerAttachment(t, view, beforeReply = async (_method, _params) => {}) {
  const contents = view.webContents;
  const cdp = contents.debugger;
  const send = cdp.sendCommand.bind(cdp);
  const witness = { inFlight: 0, maxInFlight: 0, detachedCommands: 0 };
  t.mock.method(cdp, "sendCommand", async (method, params) => {
    if (contents.isDestroyed()) throw new Error("WebContents is destroyed");
    if (!cdp.isAttached()) {
      witness.detachedCommands++;
      throw new Error("Debugger is not attached");
    }
    witness.inFlight++;
    witness.maxInFlight = Math.max(witness.maxInFlight, witness.inFlight);
    try {
      const result = await send(method, params);
      await beforeReply(method, params);
      return result;
    } finally {
      witness.inFlight--;
    }
  });
  return witness;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const shortcut = (key, extra = {}) => ({
  type: "keyDown", key, meta: process.platform === "darwin", control: process.platform !== "darwin",
  alt: false, shift: false, isAutoRepeat: false, ...extra,
});
function mainInput(contents, input) {
  let prevented = false;
  contents.emit("before-input-event", { preventDefault() { prevented = true; } }, input);
  return prevented;
}

test("native page shortcuts close once, keep the window and neighbor alive, and reopen in LIFO order with fresh targets", async () => {
  const { invoke, mainWindow, mainContents, onScreen, views, panel } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  const neighbor = invoke("openwork:browser:createTab", "https://example.com/neighbor", "B");
  const first = invoke("openwork:browser:createTab", "https://example.com/first", "A");
  const second = invoke("openwork:browser:createTab", "https://example.com/second", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  const secondContents = onScreen().webContents;
  secondContents.focus();
  assert.equal(secondContents.input(shortcut("w", { shift: true })), false);
  assert.equal(secondContents.input(shortcut("w")), true);
  assert.equal(secondContents.destroyed, true);
  assert.equal(mainWindow.destroyed, false);
  assert.equal(invoke("openwork:browser:state").activeTabId, first.tabId);
  const firstContents = onScreen().webContents;
  assert.equal(firstContents.input(shortcut("w", { isAutoRepeat: true })), true);
  assert.equal(firstContents.destroyed, false, "holding W must not close its neighbor");
  assert.equal(firstContents.input(shortcut("w")), true);
  assert.equal(mainInput(mainContents, shortcut("w")), true, "last-tab browser context protects the window");
  assert.equal(mainWindow.destroyed, false);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.id), [neighbor.tabId]);
  assert.equal(mainInput(mainContents, shortcut("t")), true);
  await flush();
  let state = invoke("openwork:browser:state");
  const reopenedFirst = state.tabs.find(tab => tab.url.endsWith("/first"));
  assert.ok(reopenedFirst && reopenedFirst.id !== first.tabId);
  assert.equal(reopenedFirst.ownerSessionId, "A");
  assert.equal(reopenedFirst.automationProtected, false);
  assert.equal(reopenedFirst.browserApproval, null);
  assert.deepEqual(reopenedFirst.siteTools, []);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  onScreen().webContents.focus();
  assert.equal(onScreen().webContents.input(shortcut("t")), true);
  // Key-up must not invalidate an in-flight reopen's focus identity.
  assert.equal(onScreen().webContents.input(shortcut("t", { type: "keyUp" })), true);
  await flush();
  state = invoke("openwork:browser:state");
  const reopenedSecond = state.tabs.find(tab => tab.url.endsWith("/second"));
  assert.ok(reopenedSecond && reopenedSecond.id !== second.tabId);
  assert.equal(state.activeTabId, reopenedSecond.id);
  assert.equal(views()[0].webContents.destroyed, false, "other conversation's native page survives");
  assert.notEqual(onScreen().webContents.targetId, secondContents.targetId);
  assert.equal(mainWindow.destroyed, false);
  panel.destroy();
});

test("toolbar and menu Close share browser focus, while chat and other windows retain native Close", async () => {
  const { invoke, mainContents, mainWindow, panel, onScreen } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  const tab = invoke("openwork:browser:createTab", "https://example.com/toolbar", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  mainContents.focus();
  invoke("openwork:browser:shortcut-focus", tab.tabId);
  createApplicationMenu({ appName: "OpenWork", docsUrl: "https://example.com/docs", getWindow: () => mainWindow,
    closeBrowserTab: host => panel.closeFocusedBrowserTab(host) }).install();
  const close = menuTemplates.at(-1).find(item => item.label === "File").submenu.find(item => item.label === "Close");
  assert.equal(close.role, undefined, "no native role can bypass browser routing");
  assert.equal(close.accelerator, "CommandOrControl+W");
  close.click(null, mainWindow);
  assert.equal(mainWindow.destroyed, false);
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
  assert.equal(mainInput(mainContents, shortcut("t")), true);
  await flush();
  const reopened = invoke("openwork:browser:state").tabs[0];
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  mainContents.focus();
  invoke("openwork:browser:shortcut-focus", reopened.id);
  assert.equal(mainInput(mainContents, shortcut("w")), true, "toolbar W is stopped before the menu");
  assert.equal(onScreen(), null);
  const otherWindow = { closed: false, close() { this.closed = true; } };
  close.click(null, otherWindow);
  assert.equal(otherWindow.closed, true);
  invoke("openwork:browser:shortcut-focus", null);
  assert.equal(mainInput(mainContents, shortcut("t")), false, "chat T reaches the existing conversation shortcut");
  close.click(null, mainWindow);
  assert.equal(mainWindow.destroyed, true, "outside browser context native Close is unchanged");
  panel.destroy();
});

test("browser shortcut ownership rejects background input, forged focus, hidden panels, and conversation changes", async () => {
  const { invoke, emit, mainContents, views, panel } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  const a = invoke("openwork:browser:createTab", "https://example.com/a", "A");
  const b = invoke("openwork:browser:createTab", "https://example.com/b", "B");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  views()[1].webContents.focus();
  assert.equal(views()[1].webContents.input(shortcut("w")), false, "emulated/background focus cannot claim shortcuts");
  mainContents.focus();
  emit("openwork:browser:shortcut-focus", { sender: views()[0].webContents }, a.tabId);
  assert.equal(mainInput(mainContents, shortcut("w")), false);
  emit("openwork:browser:shortcut-focus", { sender: mainContents, senderFrame: {} }, a.tabId);
  assert.equal(mainInput(mainContents, shortcut("t")), false);
  invoke("openwork:browser:shortcut-focus", b.tabId);
  assert.equal(mainInput(mainContents, shortcut("w")), false);
  invoke("openwork:browser:shortcut-focus", a.tabId);
  invoke("openwork:browser:hide");
  assert.equal(mainInput(mainContents, shortcut("w")), false);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:shortcut-focus", a.tabId);
  assert.equal(mainInput(mainContents, shortcut("w")), true);
  invoke("openwork:browser:setVisibleSession", "B");
  assert.equal(mainInput(mainContents, shortcut("t")), false);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  invoke("openwork:browser:shortcut-focus", b.tabId);
  assert.equal(mainInput(mainContents, shortcut("t")), true);
  await flush();
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.id), [b.tabId], "B cannot reopen A's closed tab");
  mainInput(mainContents, { type: "keyDown", key: "Tab" });
  assert.equal(mainInput(mainContents, shortcut("t")), false);
  panel.destroy();
});

test("reopen checks current policy, keeps failed history, serializes requests, and cancels a stale owner", async () => {
  let denied = false;
  let pending = null;
  const { invoke, mainContents, panel } = createPanel(async () => {
    if (denied) throw new Error("organization_policy_denied");
    if (pending) await pending.promise;
  });
  invoke("openwork:browser:setVisibleSession", "A");
  const a = invoke("openwork:browser:createTab", "https://example.com/reopen", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  mainContents.focus();
  invoke("openwork:browser:shortcut-focus", a.tabId);
  mainInput(mainContents, shortcut("w"));
  denied = true;
  mainInput(mainContents, shortcut("t"));
  await flush();
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
  assert.ok(effects.some(effect => effect.type === "dialog"));
  denied = false;
  pending = gate();
  mainInput(mainContents, shortcut("t"));
  mainInput(mainContents, shortcut("t"));
  await flush();
  pending.finish();
  pending = null;
  await flush();
  assert.equal(invoke("openwork:browser:state").tabs.length, 1, "one failed history entry reopens only once");
  const reopened = invoke("openwork:browser:state").tabs[0];
  invoke("openwork:browser:shortcut-focus", reopened.id);
  invoke("openwork:browser:closeTab", reopened.id);
  pending = gate();
  mainInput(mainContents, shortcut("t"));
  await flush();
  invoke("openwork:browser:closeSessionTabs", "A");
  pending.finish();
  pending = null;
  await flush();
  assert.deepEqual(invoke("openwork:browser:state").tabs, [], "owner deletion invalidates an in-flight reopen");
  panel.destroy();
});

test("explicit closes have bounded history, while owner and app cleanup cannot be reopened", async () => {
  const { invoke, mainContents, panel } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  for (let index = 0; index < 23; index++) {
    const tab = invoke("openwork:browser:createTab", `https://example.com/${index}`, "A");
    await flush();
    invoke("openwork:browser:shortcut-focus", tab.tabId);
    invoke("openwork:browser:closeTab", tab.tabId);
  }
  const sentinel = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  for (let index = 22; index >= 3; index--) {
    mainContents.focus();
    invoke("openwork:browser:shortcut-focus", sentinel.tabId);
    mainInput(mainContents, shortcut("t"));
    await flush();
    const tab = invoke("openwork:browser:state").tabs.find(tab => tab.id !== sentinel.tabId);
    assert.equal(tab.url, `https://example.com/${index}`);
    // A native/page close is cleanup, not another explicit user close.
    const contents = createdViews.at(-1).webContents;
    contents.close();
  }
  mainContents.focus();
  invoke("openwork:browser:shortcut-focus", sentinel.tabId);
  mainInput(mainContents, shortcut("t"));
  await flush();
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.id), [sentinel.tabId]);
  invoke("openwork:browser:closeTab", sentinel.tabId);
  invoke("openwork:browser:closeSessionTabs", "A");
  assert.equal(mainInput(mainContents, shortcut("t")), false);
  panel.destroy();
});

test("keyboard focus on an inactive browser tab never falls through to window close", async () => {
  const { invoke, mainContents, mainWindow, panel } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  const first = invoke("openwork:browser:createTab", "https://example.com/inactive", "A");
  const active = invoke("openwork:browser:createTab", "https://example.com/active", "A");
  await flush();
  // Tab-strip buttons remain focusable while an artifact occupies the viewport.
  mainContents.focus();
  invoke("openwork:browser:shortcut-focus", first.tabId);
  assert.equal(mainInput(mainContents, shortcut("w")), true);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.id), [active.tabId]);
  assert.equal(mainWindow.destroyed, false);
  panel.destroy();
});

test("reopen targets the loading tab immediately and geometry staging preserves last-tab recovery", async () => {
  const { invoke, mainContents, mainWindow, panel, views } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  const original = invoke("openwork:browser:createTab", "https://example.com/original", "A");
  const closed = invoke("openwork:browser:createTab", "https://example.com/closed", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  mainContents.focus();
  invoke("openwork:browser:shortcut-focus", closed.tabId);
  mainInput(mainContents, shortcut("w"));
  const loading = gate();
  controls.beforeLoad = () => loading.promise;
  mainInput(mainContents, shortcut("t"));
  await flush();
  const reopened = invoke("openwork:browser:state").activeTabId;
  assert.notEqual(reopened, original.tabId);
  invoke("openwork:browser:hide", { preserveShortcutFocus: true });
  mainContents.focus();
  assert.equal(mainInput(mainContents, shortcut("t", { type: "keyUp" })), true);
  assert.equal(mainInput(mainContents, shortcut("w")), true, "W closes the new target before navigation finishes");
  assert.equal(mainWindow.destroyed, false);
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.id), [original.tabId]);
  assert.equal(views().at(-1).webContents.destroyed, true);
  loading.finish();
  await flush();
  panel.destroy();
});

test("leaving the browser while reopen policy waits cancels the pending request", async () => {
  let pending = null;
  const { invoke, mainContents, panel } = createPanel(async () => { if (pending) await pending.promise; });
  invoke("openwork:browser:setVisibleSession", "A");
  const kept = invoke("openwork:browser:createTab", "https://example.com/kept", "A");
  const closed = invoke("openwork:browser:createTab", "https://example.com/closed", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  mainContents.focus();
  invoke("openwork:browser:shortcut-focus", closed.tabId);
  mainInput(mainContents, shortcut("w"));
  pending = gate();
  mainInput(mainContents, shortcut("t"));
  await flush();
  invoke("openwork:browser:hide");
  pending.finish();
  pending = null;
  await flush();
  assert.deepEqual(invoke("openwork:browser:state").tabs.map(tab => tab.id), [kept.tabId]);
  assert.equal(mainInput(mainContents, shortcut("t")), false);
  panel.destroy();
});

test("page link menus open a policy-checked tab in the source conversation without replacing the source", async () => {
  const pending = gate();
  const { invoke, onScreen, menus, policies, mainContents } = createPanel(async ({ url }) => {
    if (url === LINK.url) await pending.promise;
  });
  invoke("openwork:browser:setVisibleSession", "A");
  const source = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  const contents = onScreen().webContents;
  contents.getZoomFactor = () => 1.5;
  mainContents.getZoomFactor = () => 2;
  contents.emit("context-menu", { x: 20, y: 30, linkURL: LINK.url });
  await flush();
  assert.deepEqual(menus.at(-1).request.point, { x: 410, y: 35 });
  assert.equal(menus.at(-1).request.items[0].label, "Open Link in New Tab");
  menus.at(-1).choose("open-new-tab");
  await flush();
  assert.equal(invoke("openwork:browser:state").tabs.length, 1, "no allocation before policy resolves");
  pending.finish();
  await flush();
  const state = invoke("openwork:browser:state");
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs.find(tab => tab.id === source.tabId).url, "about:blank");
  assert.ok(state.tabs.some(tab => tab.id === state.activeTabId && tab.url === LINK.url && tab.ownerSessionId === "A"));
  assert.ok(policies.some(request => request.url === LINK.url && request.external === false));
  assert.deepEqual(effects, [], "never launches an external browser");
  invoke("openwork:browser:destroy");
});

test("page menu actions reject unsafe links, denied policy, capacity overflow, and stale documents", async () => {
  for (const mode of ["scheme", "policy", "capacity", "navigation", "frame-navigation", "closed", "conversation"]) {
    const { invoke, onScreen, menus, views } = createPanel(async ({ url }) => {
      if (mode === "policy" && url === LINK.url) throw new Error("Destination blocked");
    });
    invoke("openwork:browser:setVisibleSession", "A");
    invoke("openwork:browser:createTab", "about:blank", "A");
    if (mode === "capacity") for (let index = 1; index < 12; index++) invoke("openwork:browser:createTab", "about:blank", "A");
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    await flush();
    const contents = onScreen().webContents;
    const before = views().length;
    contents.emit("context-menu", { x: 10, y: 20, linkURL: mode === "scheme" ? "javascript:alert(1)" : LINK.url });
    await flush();
    const menu = menus.at(-1);
    if (mode === "scheme") assert.equal(menu.request.items[0].enabled, false);
    if (mode === "navigation" || mode === "frame-navigation") contents.emit("did-start-navigation", "https://changed.example", false, mode === "navigation");
    if (mode === "closed") contents.close();
    if (mode === "conversation") invoke("openwork:browser:setVisibleSession", "B");
    menu.choose("open-new-tab");
    await flush();
    assert.equal(views().length, before, mode);
    assert.deepEqual(effects, ["policy", "capacity"].includes(mode) ? [{ type: "dialog" }] : [], mode);
    invoke("openwork:browser:destroy");
  }
});

test("page menus copy linked image pixels and addresses and respect Chromium editing flags", async () => {
  const { invoke, onScreen, menus } = createPanel();
  invoke("openwork:browser:setVisibleSession", "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  const contents = onScreen().webContents;
  for (const id of ["copy-image", "copy-image-address", "copy-link"]) {
    contents.emit("context-menu", { x: 10, y: 20, linkURL: LINK.url, mediaType: "image", hasImageContents: true, srcURL: "data:image/png;base64,example" });
    await flush();
    assert.deepEqual(menus.at(-1).request.items.filter(item => item.type === "item").map(item => item.id),
      ["open-new-tab", "copy-link", "copy-image", "copy-image-address"]);
    menus.at(-1).choose(id);
    await flush();
  }
  assert.deepEqual(effects, [{ type: "image", x: 10, y: 20 }, { type: "copy", url: "data:image/png;base64,example" }, { type: "copy", url: LINK.url }]);
  effects.length = 0;
  for (const id of ["paste", "copy"]) {
    contents.emit("context-menu", { x: 10, y: 20, isEditable: true, editFlags: { canCopy: true, canPaste: false } });
    await flush();
    menus.at(-1).choose(id);
    await flush();
  }
  assert.deepEqual(effects, [{ type: "edit-copy", targetId: contents.targetId }]);
  contents.emit("context-menu", { x: 10, y: 20 });
  await flush();
  assert.deepEqual(menus.at(-1).request.items.map(({ id, enabled }) => ({ id, enabled })),
    [{ id: "back", enabled: false }, { id: "forward", enabled: false }, { id: "reload", enabled: true }]);
  menus.at(-1).choose("reload");
  await flush();
  assert.equal(invoke("openwork:browser:state").tabs.length, 1);
  invoke("openwork:browser:destroy");
});

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

test("preload routes only trusted unmodified primary anchor clicks, never scripts or middle clicks", async (t) => {
  const descriptors = new Map(["HTMLAnchorElement", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const mainFrame = Object.getOwnPropertyDescriptor(process, "isMainFrame");
  Object.defineProperty(process, "isMainFrame", { value: true, configurable: true });
  class Anchor {
    href = LINK.url;
    isContentEditable = false;
    download = false;
    getAttribute() { return this.href; }
    hasAttribute() { return this.download; }
    closest() { return { getAttribute: () => "A" }; }
  }
  Object.defineProperty(globalThis, "HTMLAnchorElement", { value: Anchor, configurable: true });
  Object.defineProperty(globalThis, "location", { value: new URL("http://localhost/index.html"), configurable: true });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    if (mainFrame) Object.defineProperty(process, "isMainFrame", mainFrame);
    else Reflect.deleteProperty(process, "isMainFrame");
  });
  await loadPreload(t);
  const click = (overrides = {}, anchor = new Anchor()) => {
    const event = new Event("click", { cancelable: true });
    for (const [key, value] of Object.entries({ isTrusted: true, button: 0, composedPath: () => [anchor], ...overrides })) {
      Object.defineProperty(event, key, { value });
    }
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(click(), true);
  assert.deepEqual(preloadCalls, [{ channel: "openwork:browser:linkClick", args: [{ url: LINK.url, sessionId: "A" }] }]);
  assert.equal(exposed.__OPENWORK_ELECTRON__.browser.linkClick, undefined);
  for (const overrides of [{ isTrusted: false }, { button: 1 }, { button: 2 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
    assert.equal(click(overrides), false);
  }
  for (const change of [{ href: "#section" }, { href: "/settings" }, { href: "javascript:alert(1)" }, { href: "http://localhost/index.html#section" }, { download: true }, { isContentEditable: true }]) {
    assert.equal(click({}, Object.assign(new Anchor(), change)), false);
  }
  assert.equal(preloadCalls.length, 1);
});

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

function mockPage(contents) {
  const inputs = [];
  let context;
  class Element {
    tagName = "INPUT";
    type = "text";
    isConnected = true;
    innerText = "Search";
    disabled = false;
    readOnly = false;
    rect = { x: 10, y: 20, width: 100, height: 40 };
    getBoundingClientRect() { return this.rect; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    matches(selector) { return selector.includes(`input[type="${this.type}"]`); }
    contains(element) { return element === this; }
    focus() { context.document.activeElement = this; }
    select() {}
  }
  const element = new Element();
  context = createContext({
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
    HTMLElement: Element, HTMLInputElement: Element,
    HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    MutationObserver: class { observe() {} disconnect() {} },
    document: {
      title: "Example", body: { innerText: "Example page" }, activeElement: element,
      querySelectorAll: (selector) => selector.startsWith("a[") || element.matches(selector) ? [element] : [],
      elementFromPoint: () => element,
    },
  });
  contents.executeJavaScriptInIsolatedWorld = async (_world, scripts) => runInContext(scripts[0].code, context);
  contents.insertText = async (text) => { inputs.push({ type: "text", text }); };
  contents.sendInputEvent = (event) => { inputs.push(event); };
  let image = "initial image";
  contents.capturePage = async () => ({ resize: () => ({ toPNG: () => Buffer.from(image) }) });
  return { context, element, inputs, setImage: (value) => { image = value; } };
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

test("stale zoom snapshots detach old geometry without changing ownership or reopening a hidden panel", async () => {
  const { invoke, mainContents, onScreen, panel } = createPanel();
  const a = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  const stale = { ...PANEL_BOUNDS, zoomFactor: 1 };
  assert.equal(invoke("openwork:browser:show", stale, "A"), true);
  const view = onScreen();
  mainContents.zoomFactor = 1.25;
  assert.equal(invoke("openwork:browser:show", stale, "B"), false);
  assert.equal(invoke("openwork:browser:bounds", stale), false);
  assert.equal(invoke("openwork:browser:state").visibleSessionId, "A");
  assert.equal(onScreen(), null);
  assert.deepEqual(view.getBounds(), PANEL_BOUNDS);
  await invoke("openwork:browser:selectTab", a.tabId);
  assert.equal(onScreen(), null, "a rejected snapshot invalidates cached placement");

  const latest = { x: 640, y: 48, width: 320, height: 600, zoomFactor: 1.25 };
  assert.equal(invoke("openwork:browser:bounds", latest), true);
  assert.equal(onScreen(), view, "fresh bounds restore an intended-visible page");
  const nativeBounds = { x: 800, y: 60, width: 400, height: 750 };
  assert.deepEqual(view.getBounds(), nativeBounds);
  mainContents.zoomFactor = 0.8;
  await invoke("openwork:browser:selectTab", a.tabId);
  assert.equal(onScreen(), null, "attachment rejects geometry measured at a previous zoom");
  assert.deepEqual(view.getBounds(), nativeBounds, "cached native bounds are never rescaled");
  mainContents.zoomFactor = 1.25;
  await invoke("openwork:browser:selectTab", a.tabId);
  assert.equal(onScreen(), null, "returning to the old zoom does not revive invalidated geometry");
  assert.equal(invoke("openwork:browser:bounds", latest), true);
  assert.equal(onScreen(), view);

  invoke("openwork:browser:hide");
  mainContents.zoomFactor = 0.8;
  assert.equal(invoke("openwork:browser:show", latest, "B"), false);
  assert.equal(onScreen(), null);
  assert.equal(invoke("openwork:browser:state").visibleSessionId, "A");
  assert.equal(invoke("openwork:browser:show", { ...latest, zoomFactor: 0.8 }, "B"), true);
  assert.notEqual(onScreen(), view);
  assert.equal(invoke("openwork:browser:state").visibleSessionId, "B");
  panel.destroy();
});

test("unstamped CSS geometry is scaled and invalid snapshots detach until fresh bounds arrive", async () => {
  const { invoke, mainContents, onScreen, views, children, panel } = createPanel();
  mainContents.zoomFactor = 1.25;
  const a = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  assert.equal(invoke("openwork:browser:show", PANEL_BOUNDS, "A"), true);
  const foreground = onScreen();
  const background = views()[1];
  const backgroundBounds = background.getBounds();
  assert.deepEqual(foreground.getBounds(), { x: 1000, y: 50, width: 500, height: 1125 });
  const latest = { x: 80, y: 40, width: 240, height: 400 };
  const expected = { x: 100, y: 50, width: 300, height: 500 };
  for (const invalid of [undefined, null, {}, { ...latest, x: NaN }, { ...latest, y: Infinity },
    { ...latest, x: "80" }, { ...latest, width: 0 }, { ...latest, height: -1 },
    { ...latest, width: 0.01 }, { ...latest, height: 0.01 },
    { ...latest, x: 1280 }, { ...latest, y: 960 }, { ...latest, x: -240 }, { ...latest, y: -400 },
    { ...latest, width: Number.MAX_VALUE }, { ...latest, x: Number.MAX_VALUE, width: Number.MAX_VALUE },
    { ...latest, zoomFactor: Infinity }, { ...latest, zoomFactor: 0 }, { ...latest, zoomFactor: null }]) {
    for (const channel of ["bounds", "show"]) {
      assert.equal(invoke("openwork:browser:bounds", latest), true);
      assert.equal(onScreen(), foreground);
      assert.deepEqual(foreground.getBounds(), expected);
      assert.equal(invoke(`openwork:browser:${channel}`, invalid), false);
      assert.deepEqual(children, [], "invalid geometry cannot leave a stale native overlay");
      await invoke("openwork:browser:selectTab", a.tabId);
      assert.equal(onScreen(), null, "tab selection cannot reuse rejected geometry");
      assert.deepEqual(background.getBounds(), backgroundBounds);
      assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 1);
    }
  }
  assert.equal(invoke("openwork:browser:bounds", latest), true);
  assert.equal(onScreen(), foreground);
  assert.equal(views().length, 2);
  assert.ok(views().every(view => !view.webContents.isDestroyed()));
  panel.destroy();
});

test("native geometry clips scaled edges to window content and rechecks cached bounds after resize", async () => {
  const { invoke, mainWindow, mainContents, onScreen, panel } = createPanel();
  mainWindow.contentSize = [1000, 700];
  mainContents.zoomFactor = 1.25;
  const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
  for (const { bounds, expected } of [
    { bounds: { x: -8.4, y: -4.4, width: 900, height: 620 }, expected: { x: 0, y: 0, width: 1000, height: 700 } },
    { bounds: { x: -10, y: 20, width: 30, height: 40 }, expected: { x: 0, y: 25, width: 25, height: 50 } },
    { bounds: { x: 0, y: 0, width: 800, height: 560 }, expected: { x: 0, y: 0, width: 1000, height: 700 } },
    { bounds: { x: 760.4, y: 500.4, width: 100, height: 100 }, expected: { x: 951, y: 626, width: 49, height: 74 } },
  ]) {
    assert.equal(invoke("openwork:browser:show", { ...bounds, zoomFactor: 1.25 }, "A"), true);
    assert.deepEqual(onScreen().getBounds(), expected);
  }
  const view = onScreen();
  mainWindow.contentSize = [970, 650];
  await invoke("openwork:browser:selectTab", tabId);
  assert.equal(onScreen(), view);
  assert.deepEqual(view.getBounds(), { x: 951, y: 626, width: 19, height: 24 });
  mainWindow.contentSize = [500, 400];
  await invoke("openwork:browser:selectTab", tabId);
  assert.equal(onScreen(), null);
  mainWindow.contentSize = [1000, 700];
  await invoke("openwork:browser:selectTab", tabId);
  assert.equal(onScreen(), null, "window growth cannot revive an invalidated rectangle");
  assert.equal(invoke("openwork:browser:bounds", { x: 0, y: 0, width: 800, height: 560 }), true);
  assert.equal(onScreen(), view);
  mainWindow.contentSize = [0, 0];
  assert.equal(invoke("openwork:browser:bounds", PANEL_BOUNDS), false);
  assert.equal(onScreen(), null);
  panel.destroy();
});

test("hidden panels require fresh show intent even after bounds, selection, or conversation changes", async () => {
  const { invoke, onScreen, views, panel } = createPanel();
  const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const view = onScreen();
  invoke("openwork:browser:setVisibleSession", "A");
  assert.equal(onScreen(), view, "an unchanged conversation preserves current geometry");
  invoke("openwork:browser:hide");
  await invoke("openwork:browser:selectTab", tabId);
  assert.equal(onScreen(), null);
  assert.equal(invoke("openwork:browser:show", null, "A"), false);
  assert.equal(invoke("openwork:browser:bounds", PANEL_BOUNDS), true);
  await invoke("openwork:browser:selectTab", tabId);
  assert.equal(onScreen(), null, "bounds alone do not reopen a hidden panel");
  invoke("openwork:browser:setVisibleSession", "B");
  invoke("openwork:browser:setVisibleSession", "A");
  assert.equal(onScreen(), null);
  const fresh = { x: 100, y: 50, width: 300, height: 500 };
  assert.equal(invoke("openwork:browser:show", fresh, "A"), true);
  assert.equal(onScreen(), view);
  assert.deepEqual(view.getBounds(), fresh);
  assert.equal(views().length, 1);
  assert.equal(view.webContents.isDestroyed(), false);
  panel.destroy();
});

test("renderer reload and crash remove native placement without destroying the browser document", async () => {
  const { invoke, mainContents, onScreen, panel } = createPanel();
  const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
  await flush();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const view = onScreen();
  mainContents.emit("did-start-navigation", {}, "http://localhost/frame", false, false);
  mainContents.emit("did-start-navigation", {}, "http://localhost/#route", true, true);
  mainContents.emit("did-start-navigation", {}, "https://example.com/rerouted", false, true);
  assert.equal(onScreen(), view, "subframe, same-document and canceled navigation retain the container");
  for (const event of ["did-navigate", "render-process-gone"]) {
    mainContents.emit(event, {}, "http://localhost/", false, true);
    assert.equal(onScreen(), null, "the old renderer cannot leave a browser overlay behind");
    invoke("openwork:browser:bounds", PANEL_BOUNDS);
    await invoke("openwork:browser:selectTab", tabId);
    assert.equal(onScreen(), null, "a new mounted container must explicitly show the page");
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    assert.equal(onScreen(), view);
    assert.equal(view.webContents.isDestroyed(), false);
  }
  panel.destroy();
});

test("geometry IPC accepts only the main renderer main frame without mutating state for other senders", async () => {
  const { invoke, emit, mainContents, onScreen, views, panel } = createPanel();
  const a = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const view = onScreen();
  const before = invoke("openwork:browser:state");
  for (const event of [
    { sender: views()[1].webContents, senderFrame: views()[1].webContents.mainFrame },
    { sender: views()[0].webContents, senderFrame: mainContents.mainFrame },
    { sender: mainContents, senderFrame: {} },
    { sender: mainContents },
  ]) {
    for (const [channel, ...args] of [
      ["show", { x: 0, y: 0, width: 200, height: 200 }, "B"],
      ["show", null, "B"], ["hide"], ["setVisibleSession", "B"],
      ["bounds", { x: 0, y: 0, width: 200, height: 200 }], ["bounds", null],
    ]) {
      assert.equal(emit(`openwork:browser:${channel}`, event, ...args), false);
      assert.equal(onScreen(), view);
      assert.deepEqual(invoke("openwork:browser:state"), before);
    }
  }
  await invoke("openwork:browser:selectTab", a.tabId);
  assert.equal(onScreen(), view, "untrusted geometry cannot invalidate the accepted cache");
  assert.deepEqual(view.getBounds(), PANEL_BOUNDS);
  invoke("openwork:browser:hide");
  assert.equal(emit("openwork:browser:show", { sender: mainContents, senderFrame: {} }, PANEL_BOUNDS, "B"), false);
  assert.equal(onScreen(), null);
  assert.equal(invoke("openwork:browser:show", PANEL_BOUNDS, "A"), true);
  panel.destroy();
});

test("neighbor reattachment clips and invalidates collapsed geometry across zoom without touching the background owner", async (t) => {
  for (const { zoomFactor, expected } of [
    { zoomFactor: 0.8, expected: { x: 320, y: 240, width: 200, height: 160 } },
    { zoomFactor: 1.25, expected: { x: 501, y: 376, width: 312, height: 250 } },
  ]) {
    const harness = createPanel();
    const { invoke, mainWindow, mainContents, views, children, messages, panel } = harness;
    t.after(() => panel.destroy());
    mainContents.zoomFactor = zoomFactor;
    invoke("openwork:browser:setVisibleSession", "A");
    const first = invoke("openwork:browser:createTab", "about:blank", "A");
    const second = invoke("openwork:browser:createTab", "about:blank", "A");
    const background = invoke("openwork:browser:createTab", "about:blank", "B");
    await flush();
    const [firstView, secondView, backgroundView] = views();
    const host = createdWindows.at(-1);
    const backgroundState = invoke("openwork:browser:state").tabs.find(tab => tab.id === background.tabId);
    const loads = views().map(view => [...view.webContents.loads]);
    const bounds = { x: 400.4, y: 300.4, width: 250.2, height: 200.2, zoomFactor };
    invoke("openwork:browser:show", bounds, "A");
    await flush();
    const verify = watchNativePlacement(t, harness);
    const before = messages("openwork:browser:bounds-invalidated").length;
    mainWindow.contentSize = [expected.x + 61, expected.y + 47];
    await invoke("openwork:browser:selectTab", first.tabId);
    const clipped = { ...expected, width: 61, height: 47 };
    verify(firstView, clipped);
    assert.equal(messages("openwork:browser:bounds-invalidated").length, before + 1);
    assert.deepEqual(firstView.getBounds(), clipped);
    mainWindow.contentSize = [1600, 1200];
    await invoke("openwork:browser:selectTab", second.tabId);
    verify(secondView, clipped);
    assert.deepEqual(secondView.getBounds(), clipped, "growth alone cannot expand cached placement into unmeasured app space");
    mainWindow.contentSize = [expected.x, 1200];
    await invoke("openwork:browser:selectTab", first.tabId);
    verify(null, null);
    assert.deepEqual(children, []);
    mainWindow.contentSize = [1600, 1200];
    await invoke("openwork:browser:selectTab", second.tabId);
    assert.deepEqual(children, [], "growth cannot revive the fully clipped cache");
    assert.equal(invoke("openwork:browser:bounds", bounds), true);
    verify(secondView, expected);
    assert.deepEqual(children, [secondView]);
    assert.deepEqual(views().map(view => view.webContents.loads), loads);
    mainWindow.contentSize = [1600, expected.y + 23];
    invoke("openwork:browser:closeTab", second.tabId);
    verify(firstView, { ...expected, height: 23 });
    assert.deepEqual(children, [firstView], "closing the active page sizes its surviving neighbor before attaching");
    mainWindow.contentSize = [0, 0];
    assert.equal(invoke("openwork:browser:bounds", bounds), false);
    verify(null, null);
    mainWindow.contentSize = [1600, 1200];
    await invoke("openwork:browser:selectTab", first.tabId);
    assert.deepEqual(children, []);
    assert.equal(invoke("openwork:browser:bounds", bounds), true);
    verify(firstView, expected);
    assert.deepEqual(firstView.webContents.loads, loads[0]);
    assert.equal(firstView.webContents.isDestroyed(), false);
    assert.deepEqual(host.contentView.children, [backgroundView]);
    assert.equal(host.isDestroyed(), false);
    assert.deepEqual(backgroundView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
    assert.deepEqual(invoke("openwork:browser:state").tabs.find(tab => tab.id === background.tabId), backgroundState);
    assert.equal(invoke("openwork:browser:state").activeTabIdByOwner.B, background.tabId);
    panel.destroy();
  }
});

test("direct multi-tab session switches and hidden stale updates never attach a background-sized page", async (t) => {
  const harness = createPanel();
  const { invoke, panel, views, mainContents, children } = harness;
  t.after(() => panel.destroy());
  invoke("openwork:browser:setVisibleSession", "A");
  const first = invoke("openwork:browser:createTab", "about:blank", "A");
  const second = invoke("openwork:browser:createTab", "about:blank", "A");
  const b1 = invoke("openwork:browser:createTab", "about:blank", "B");
  const b2 = invoke("openwork:browser:createTab", "about:blank", "B");
  const other = invoke("openwork:browser:createTab", "about:blank", "C");
  await flush();
  const [a1View, a2View, b1View, b2View, cView] = views();
  const host = createdWindows.at(-1);
  const loads = views().map(view => [...view.webContents.loads]);
  const otherState = invoke("openwork:browser:state").tabs.find(tab => tab.id === other.tabId);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  const verify = watchNativePlacement(t, harness);
  await invoke("openwork:browser:selectTab", first.tabId);
  verify(a1View, PANEL_BOUNDS);
  b1View.webContents.emit("did-start-navigation", "https://example.com/background", false, true);
  assert.deepEqual(children, [a1View]);
  assert.equal(invoke("openwork:browser:state").activeTabIdByOwner.B, b1.tabId);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  verify(b1View, PANEL_BOUNDS);
  await invoke("openwork:browser:selectTab", b2.tabId);
  verify(b2View, PANEL_BOUNDS);
  invoke("openwork:browser:hide");
  verify(null, null);
  mainContents.zoomFactor = 0.8;
  assert.equal(invoke("openwork:browser:show", { ...PANEL_BOUNDS, zoomFactor: 1 }, "A"), false);
  assert.equal(invoke("openwork:browser:bounds", { ...PANEL_BOUNDS, zoomFactor: 1 }), false);
  assert.equal(invoke("openwork:browser:state").visibleSessionId, "B");
  a2View.webContents.emit("did-start-navigation", "https://example.com/hidden", false, true);
  await invoke("openwork:browser:selectTab", b1.tabId);
  assert.equal(invoke("openwork:browser:bounds", { ...PANEL_BOUNDS, zoomFactor: 0.8 }), true);
  assert.deepEqual(children, [], "hidden selection, navigation and fresh bounds never restore show intent");
  invoke("openwork:browser:show", { ...PANEL_BOUNDS, zoomFactor: 0.8 }, "A");
  verify(a2View, { x: 640, y: 32, width: 320, height: 720 });
  await flush();
  assert.equal(invoke("openwork:browser:state").activeTabId, second.tabId);
  assert.equal(invoke("openwork:browser:state").activeTabIdByOwner.B, b1.tabId);
  assert.deepEqual(children, [a2View]);
  assert.deepEqual(new Set(host.contentView.children), new Set([b1View, b2View, cView]));
  assert.equal(host.isDestroyed(), false);
  assert.deepEqual(invoke("openwork:browser:state").tabs.find(tab => tab.id === other.tabId), otherState);
  assert.deepEqual(views().map(view => view.webContents.loads), loads);
  assert.ok(views().every(view => !view.webContents.isDestroyed()));
});

test("pending approval masks survive tab and session reattachment and hidden acceptance cannot cover the neighbor", async (t) => {
  const harness = createPanel();
  const { invoke, panel, views, approve, children } = harness;
  t.after(() => panel.destroy());
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://example.com/review" } });
  await flush();
  approve();
  const { tabId } = await opening;
  const neighbor = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  const [reviewView, neighborView, bView] = views();
  const loads = views().map(view => [...view.webContents.loads]);
  const { inputs } = mockPage(reviewView.webContents);
  await invoke("openwork:browser:selectTab", tabId);
  const observed = await panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } });
  const pending = panel.browserTask({ sessionId: "A", operation: "act", args: {
    tabId, observationId: observed.observationId, action: { type: "fill", ref: "e1", text: "Reviewed text" },
  } });
  await flush();
  const review = invoke("openwork:browser:state").tabs.find(tab => tab.id === tabId).browserApproval;
  assert.ok(review);
  assert.equal(reviewView.getVisible(), false);
  const verify = watchNativePlacement(t, harness);
  await invoke("openwork:browser:selectTab", neighbor.tabId);
  verify(neighborView, PANEL_BOUNDS);
  await invoke("openwork:browser:selectTab", tabId);
  verify(reviewView, PANEL_BOUNDS, false);
  invoke("openwork:browser:hide");
  verify(null, null);
  invoke("openwork:browser:bounds", PANEL_BOUNDS);
  assert.deepEqual(children, []);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  verify(bView, PANEL_BOUNDS);
  assert.equal(invoke("openwork:browser:approve", tabId, review.id, true), false, "another owner cannot finish the masked approval");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  verify(reviewView, PANEL_BOUNDS, false);
  assert.deepEqual(invoke("openwork:browser:state").tabs.find(tab => tab.id === tabId).browserApproval, review);
  await invoke("openwork:browser:selectTab", neighbor.tabId);
  verify(neighborView, PANEL_BOUNDS);
  approve(true, tabId);
  const result = await pending;
  verify(neighborView, PANEL_BOUNDS);
  assert.equal(result.ok, false);
  assert.equal(result.dispatched, false);
  assert.equal(invoke("openwork:browser:approve", tabId, review.id, true), false);
  assert.deepEqual(inputs, []);
  assert.deepEqual(children, [neighborView]);
  assert.deepEqual(views().map(view => view.webContents.loads), loads);
  assert.ok(views().every(view => !view.webContents.isDestroyed()));
});

test("late restoration after renderer loss or owner switching never reuses the previous native rectangle", async (t) => {
  for (const ending of ["hide", "renderer-crash", "session-switch", "close"]) {
    const harness = createPanel();
    const { invoke, panel, views, mainContents, children } = harness;
    const document = gate();
    t.after(() => { document.finish(); panel.destroy(); });
    invoke("openwork:browser:setVisibleSession", "A");
    const saved = invoke("openwork:browser:createTab", "about:blank", "A");
    const neighbor = invoke("openwork:browser:createTab", "about:blank", "B");
    await flush();
    controls.confirm = async () => 1;
    await invoke("openwork:browser:suspendTab", saved.tabId);
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const host = createdWindows.at(-1);
    const backgroundView = views()[1];
    controls.beforeLoad = () => document.promise;
    const restoring = invoke("openwork:browser:selectTab", saved.tabId);
    const settled = restoring.then(value => ({ value }), error => ({ error }));
    const restoredView = views()[2];
    assert.deepEqual(children, [restoredView]);
    const verify = watchNativePlacement(t, harness);
    if (ending === "renderer-crash") mainContents.emit("render-process-gone");
    else if (ending === "session-switch") invoke("openwork:browser:setVisibleSession", "B");
    else if (ending === "close") invoke("openwork:browser:closeTab", saved.tabId);
    else invoke("openwork:browser:hide");
    verify(null, null);
    invoke("openwork:browser:bounds", PANEL_BOUNDS);
    document.finish();
    const result = await settled;
    await flush();
    verify(null, null);
    assert.deepEqual(children, [], ending);
    assert.equal(backgroundView.webContents.isDestroyed(), false);
    assert.equal(invoke("openwork:browser:state").activeTabIdByOwner.B, neighbor.tabId);
    if (ending === "close") {
      assert.match(result.error.message, /destroyed|closed/);
      assert.equal(restoredView.webContents.isDestroyed(), true);
    } else {
      assert.equal(result.value, saved.tabId);
      assert.equal(restoredView.webContents.isDestroyed(), false);
      assert.deepEqual(restoredView.webContents.loads, ["about:blank"]);
      invoke("openwork:browser:show", { x: 100, y: 50, width: 200, height: 300 }, "A");
      verify(restoredView, { x: 100, y: 50, width: 200, height: 300 });
    }
    assert.deepEqual(host.contentView.children, [backgroundView]);
    assert.equal(host.isDestroyed(), false);
    panel.destroy();
  }
});

test("host clipping or invalidation asks preload and the renderer to resend identical fresh bounds", async (t) => {
  const { invoke, mainWindow, mainContents, onScreen, panel } = createPanel();
  const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
  const browser = await loadPreload(t);
  controls.invoke = async (channel, ...args) => invoke(channel, ...args);
  t.mock.method(mainContents, "send", (channel, payload) => ipcRenderer.emit(channel, {}, payload));
  let invalidations = 0;
  window.addEventListener("openwork:browser:bounds-invalidated", () => { invalidations++; });
  await browser.show(PANEL_BOUNDS, "A");
  const view = onScreen();
  for (const width of [1000, 400]) {
    const before = invalidations;
    mainWindow.contentSize = [width, 1200];
    await invoke("openwork:browser:selectTab", tabId);
    assert.ok(invalidations > before, "host geometry changes invalidate both renderer caches");
    mainWindow.contentSize = [1600, 1200];
    await browser.setBounds(PANEL_BOUNDS);
    assert.equal(onScreen(), view);
    assert.deepEqual(view.getBounds(), PANEL_BOUNDS, "same-rectangle recovery must reach the host");
  }
  panel.destroy();
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

test("switching conversations detaches before surfacing and waits for fresh show geometry", async (t) => {
  const { invoke, onScreen, commands, children, views, panel } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "https://a.example", "A");
  const aView = onScreen();
  invoke("openwork:browser:createTab", "https://b.example", "B");
  const bView = views().find((view) => view !== aView);
  await flush();
  commands(aView).length = 0;
  commands(bView).length = 0;
  const loads = views().map(view => [...view.webContents.loads]);
  const setBackgroundBounds = aView.setBounds.bind(aView);
  t.mock.method(aView, "setBounds", (bounds) => {
    assert.deepEqual(children, [], "detach the foreground before background surfacing resizes it");
    setBackgroundBounds(bounds);
  });

  invoke("openwork:browser:setVisibleSession", "B");
  assert.deepEqual(children, [], "neither conversation may paint at the previous rectangle");
  await flush();

  assert.equal(onScreen(), null);
  assert.deepEqual(bView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
  assert.deepEqual(commands(bView), FOREGROUND_SEQUENCE, "B's emulation is undone before it is shown");
  assert.equal(bView.webContents.debugger.isAttached(), false, "our session is released for the user-driven reset path");
  assert.deepEqual(commands(aView), BACKGROUND_SEQUENCE, "A's tab now keeps painting in the background");
  assert.deepEqual(aView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
  const state = invoke("openwork:browser:state");
  assert.equal(state.visibleSessionId, "B");
  assert.equal(state.activeTabId, state.activeTabIdByOwner.B);
  await invoke("openwork:browser:selectTab", state.activeTabId);
  assert.equal(onScreen(), null);
  const fresh = { x: 400, y: 80, width: 600, height: 700 };
  assert.equal(invoke("openwork:browser:bounds", fresh), true);
  assert.equal(onScreen(), null, "a session switch requires fresh show intent, not only bounds");
  assert.equal(invoke("openwork:browser:show", fresh, "B"), true);
  assert.deepEqual(children, [bView]);
  assert.deepEqual(bView.getBounds(), fresh);
  assert.deepEqual(views().map(view => view.webContents.loads), loads);
  assert.ok(views().every(view => !view.webContents.isDestroyed()));
  panel.destroy();
});

test("rapid conversation round trips cannot let a late foreground cleanup clear background emulation", async (t) => {
  const harness = createPanel();
  const { invoke, panel, views, commands, children } = harness;
  const pending = gate();
  t.after(() => { pending.finish(); panel.destroy(); });
  invoke("openwork:browser:setVisibleSession", "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  const b = invoke("openwork:browser:createTab", "about:blank", "B");
  invoke("openwork:browser:createTab", "about:blank", "C");
  await flush();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  const [aView, bView, cView] = views();
  const loads = views().map(view => [...view.webContents.loads]);
  const host = createdWindows.at(-1);
  const cCommands = [...commands(cView)];
  const verify = watchNativePlacement(t, harness);
  const send = bView.webContents.debugger.sendCommand.bind(bView.webContents.debugger);
  t.mock.method(bView.webContents.debugger, "sendCommand", async (method, params) => {
    await send(method, params);
    if (method === "Emulation.setFocusEmulationEnabled" && params.enabled === false) await pending.promise;
  });
  commands(bView).length = 0;
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  verify(bView, PANEL_BOUNDS);
  await flush();
  assert.deepEqual(commands(bView), [FOREGROUND_SEQUENCE[0]], "hold foreground cleanup between its CDP commands");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  verify(aView, PANEL_BOUNDS);
  await flush();
  pending.finish();
  await flush();
  verify(aView, PANEL_BOUNDS);
  assert.deepEqual(commands(bView).slice(-2), BACKGROUND_SEQUENCE, "the final background transition must win over late cleanup");
  assert.equal(bView.webContents.debugger.isAttached(), true, "late cleanup cannot release the background owner's debugger");
  assert.deepEqual(children, [aView]);
  assert.deepEqual(host.contentView.children, [cView, bView]);
  assert.equal(host.isDestroyed(), false);
  assert.deepEqual(commands(cView), cCommands);
  assert.equal(invoke("openwork:browser:state").activeTabIdByOwner.B, b.tabId);
  assert.deepEqual(views().map(view => view.webContents.loads), loads);
  assert.ok(views().every(view => !view.webContents.isDestroyed()));
});

test("a queued foreground viewport reset cannot outlive a same-turn background transition", async (t) => {
  const harness = createPanel();
  const { invoke, panel, views, commands, children } = harness;
  t.after(() => panel.destroy());
  invoke("openwork:browser:setVisibleSession", "A");
  const a = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  const [aView, bView] = views();
  commands(aView).length = 0;
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const verify = watchNativePlacement(t, harness);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  verify(bView, PANEL_BOUNDS);
  await flush();
  assert.deepEqual(commands(aView), BACKGROUND_SEQUENCE, "queued user reset cannot clear the background viewport or release its debugger");
  assert.equal(aView.webContents.debugger.isAttached(), true);
  assert.deepEqual(children, [bView]);
  assert.deepEqual(createdWindows.at(-1).contentView.children, [aView]);
  assert.equal(invoke("openwork:browser:state").activeTabIdByOwner.A, a.tabId);
  assert.deepEqual(aView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
});

test("in-flight viewport resets stop after backgrounding or destruction without touching surviving pages", async (t) => {
  for (const ending of ["background", "closed"]) {
    const harness = createPanel();
    const { invoke, panel, views, commands, children } = harness;
    const pending = gate();
    t.after(() => { pending.finish(); panel.destroy(); });
    invoke("openwork:browser:setVisibleSession", "A");
    const a = invoke("openwork:browser:createTab", "about:blank", "A");
    const b = invoke("openwork:browser:createTab", "about:blank", "B");
    await flush();
    const [aView, bView] = views();
    const cdp = aView.webContents.debugger;
    const send = cdp.sendCommand.bind(cdp);
    t.mock.method(cdp, "sendCommand", async (method, params) => {
      await send(method, params);
      if (method === "Emulation.setDeviceMetricsOverride" && params.width === 0) await pending.promise;
    });
    const detach = t.mock.method(cdp, "detach");
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    await flush();
    assert.deepEqual(commands(aView), [RESET_SEQUENCE[0]]);
    const verify = watchNativePlacement(t, harness);
    if (ending === "closed") {
      invoke("openwork:browser:closeTab", a.tabId);
      verify(null, null);
    }
    invoke("openwork:browser:show", PANEL_BOUNDS, "B");
    verify(bView, PANEL_BOUNDS);
    await flush();
    assert.deepEqual(commands(aView), [RESET_SEQUENCE[0]], "background initialization waits for the foreground reply");
    pending.finish();
    await flush();
    verify(bView, PANEL_BOUNDS);
    assert.deepEqual(commands(aView), [RESET_SEQUENCE[0], ...(ending === "background" ? BACKGROUND_SEQUENCE : [])],
      "only queued background work may follow the obsolete foreground command, never a late clear");
    assert.equal(detach.mock.callCount(), 0, "no late debugger detach after destruction or background ownership");
    assert.equal(aView.webContents.isDestroyed(), ending === "closed");
    if (ending === "background") {
      assert.deepEqual(commands(aView).slice(-2), BACKGROUND_SEQUENCE);
      assert.equal(cdp.isAttached(), true);
    }
    assert.deepEqual(children, [bView]);
    assert.equal(invoke("openwork:browser:state").activeTabIdByOwner.B, b.tabId);
    assert.equal(bView.webContents.isDestroyed(), false);
    assert.deepEqual(bView.webContents.loads, ["about:blank"]);
    panel.destroy();
  }
});

test("hide-show recovery at newer bounds waits for an app-owned reset but respects an external debugger", async (t) => {
  const harness = createPanel();
  const { invoke, panel, views, commands, children } = harness;
  const pending = gate();
  t.after(async () => { pending.finish(); panel.destroy(); await flush(); });
  invoke("openwork:browser:setVisibleSession", "A");
  const a = invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  const [view, backgroundView] = views();
  const targetId = view.webContents.targetId;
  const loads = views().map(candidate => [...candidate.webContents.loads]);
  const backgroundCommands = [...commands(backgroundView)];
  const cdp = view.webContents.debugger;
  const attach = t.mock.method(cdp, "attach");
  const detach = t.mock.method(cdp, "detach");
  const commandBounds = [];
  let delayed = false;
  const debuggerState = enforceDebuggerAttachment(t, view, async (method) => {
    commandBounds.push({ ...view.getBounds() });
    if (!delayed && method === "Emulation.setDeviceMetricsOverride") {
      delayed = true;
      await pending.promise;
    }
  });
  const initial = { x: 692, y: 90, width: 310, height: 721 };
  const latest = { ...initial, width: 447 };
  invoke("openwork:browser:show", initial, "A");
  await flush();
  assert.deepEqual(commands(view), [RESET_SEQUENCE[0]]);
  assert.equal(cdp.isAttached(), true);
  const verify = watchNativePlacement(t, harness);
  invoke("openwork:browser:hide");
  verify(null, null);
  invoke("openwork:browser:show", latest, "A");
  verify(view, latest);
  invoke("openwork:browser:bounds", latest);
  await flush();
  assert.deepEqual(commands(view), [RESET_SEQUENCE[0]], "new show intent waits without concurrent commands");
  assert.equal(attach.mock.callCount(), 1);
  assert.equal(detach.mock.callCount(), 0);
  pending.finish();
  await flush();
  verify(view, latest);
  assert.deepEqual(commands(view), [...RESET_SEQUENCE, ...RESET_SEQUENCE], "the newer show must not lose its recovery reset");
  assert.deepEqual(commandBounds, [initial, latest, latest, latest], "the queued recovery executes at the latest native bounds");
  assert.equal(attach.mock.callCount(), 2);
  assert.equal(detach.mock.callCount(), 2);
  assert.equal(cdp.isAttached(), false);
  assert.equal(debuggerState.maxInFlight, 1);
  assert.equal(debuggerState.detachedCommands, 0);
  const completed = [...commands(view)];
  for (const timing of ["before-show", "after-show"]) {
    invoke("openwork:browser:hide");
    verify(null, null);
    if (timing === "before-show") cdp.attach("1.3");
    invoke("openwork:browser:show", latest, "A");
    if (timing === "after-show") cdp.attach("1.3");
    const attached = attach.mock.callCount();
    const detached = detach.mock.callCount();
    await flush();
    verify(view, latest);
    assert.deepEqual(commands(view), completed, "an external debugger present when the queue runs is left untouched");
    assert.equal(cdp.isAttached(), true);
    assert.equal(attach.mock.callCount(), attached);
    assert.equal(detach.mock.callCount(), detached);
    cdp.detach();
  }
  assert.equal(view.webContents.isFocused(), false, "recovery needs no page focus event");
  assert.equal(view.webContents.targetId, targetId);
  assert.equal(invoke("openwork:browser:state").activeTabId, a.tabId);
  assert.deepEqual(children, [view]);
  assert.deepEqual(views().map(candidate => candidate.webContents.loads), loads);
  assert.deepEqual(commands(backgroundView), backgroundCommands);
  assert.deepEqual(backgroundView.getBounds(), { x: 0, y: 0, width: 1280, height: 800 });
  assert.equal(views().length, 2);
  assert.ok(views().every(candidate => !candidate.webContents.isDestroyed()));
});

test("delayed background metrics serialize an A-B-A round trip without detached commands or a poisoned queue", async (t) => {
  const harness = createPanel();
  const { invoke, panel, views, commands, children } = harness;
  const pending = gate();
  const errors = t.mock.method(console, "error", () => {});
  t.after(async () => { pending.finish(); panel.destroy(); await flush(); });
  invoke("openwork:browser:setVisibleSession", "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:createTab", "about:blank", "C");
  await flush();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  const b = invoke("openwork:browser:createTab", "about:blank", "B");
  const [aView, cView, bView] = views();
  let delayed = false;
  const debuggerState = enforceDebuggerAttachment(t, bView, async (method, params) => {
    if (!delayed && method === "Emulation.setDeviceMetricsOverride" && params.width === 1280) {
      delayed = true;
      await pending.promise;
    }
  });
  await flush();
  assert.deepEqual(commands(bView), [BACKGROUND_SEQUENCE[0]]);
  const loads = views().map(view => [...view.webContents.loads]);
  const cCommands = [...commands(cView)];
  const host = createdWindows.at(-1);
  const verify = watchNativePlacement(t, harness);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  await flush();
  verify(bView, PANEL_BOUNDS);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  verify(aView, PANEL_BOUNDS);
  pending.finish();
  await flush();
  assert.equal(debuggerState.detachedCommands, 0, "late background focus must not use a debugger detached by foreground cleanup");
  assert.equal(debuggerState.maxInFlight, 1, "all transitions for this page share one queue");
  assert.deepEqual(errors.mock.calls.map(call => call.arguments), []);
  assert.deepEqual(commands(bView).slice(-2), BACKGROUND_SEQUENCE);
  assert.equal(bView.webContents.debugger.isAttached(), true);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  await flush();
  verify(bView, PANEL_BOUNDS);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  verify(aView, PANEL_BOUNDS);
  const handle = await invoke("openwork:browser:restoreTab", b.tabId, "B");
  assert.equal(handle.target_id, bView.webContents.targetId);
  assert.deepEqual(commands(bView).filter(command => command.method.startsWith("Emulation.")).slice(-2), BACKGROUND_SEQUENCE);
  assert.deepEqual(children, [aView]);
  assert.deepEqual(host.contentView.children, [cView, bView]);
  assert.deepEqual(commands(cView), cCommands);
  assert.deepEqual(views().map(view => view.webContents.loads), loads);
  assert.equal(views().length, 3);
  assert.ok(views().every(view => !view.webContents.isDestroyed()));
  assert.deepEqual(errors.mock.calls.map(call => call.arguments), []);
});

test("failed emulation transitions log their own error and later background initialization recovers", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  for (const phase of ["background", "foreground", "reset"]) {
    errors.mock.resetCalls();
    const { invoke, panel, views, commands } = createPanel();
    t.after(() => panel.destroy());
    invoke("openwork:browser:setVisibleSession", "A");
    invoke("openwork:browser:createTab", "about:blank", "A");
    const b = invoke("openwork:browser:createTab", "about:blank", "B");
    await flush();
    const [aView, bView] = views();
    if (phase !== "foreground") {
      invoke("openwork:browser:show", PANEL_BOUNDS, "B");
      await flush();
    }
    const failure = new Error(`test ${phase} emulation failure`);
    let failed = false;
    const debuggerState = enforceDebuggerAttachment(t, bView, async (method) => {
      if (!failed && method.startsWith("Emulation.")) { failed = true; throw failure; }
    });
    if (phase === "foreground") invoke("openwork:browser:setVisibleSession", "B");
    else invoke("openwork:browser:show", PANEL_BOUNDS, phase === "background" ? "A" : "B");
    await flush();
    assert.equal(failed, true);
    await assert.rejects(invoke("openwork:browser:restoreTab", b.tabId, "B"), error => error === failure,
      "the failed transition is observable to a handle waiter, not silently converted to success");
    invoke("openwork:browser:show", PANEL_BOUNDS, "B");
    await flush();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    await flush();
    assert.deepEqual(commands(bView).slice(-2), BACKGROUND_SEQUENCE, "a failed promise must not poison later initialization");
    const handle = await invoke("openwork:browser:restoreTab", b.tabId, "B");
    assert.equal(handle.target_id, bView.webContents.targetId);
    assert.equal(handle.owner_session_id, "B");
    assert.equal(bView.webContents.debugger.isAttached(), true);
    assert.equal(debuggerState.detachedCommands, 0);
    assert.equal(debuggerState.maxInFlight, 1);
    const label = phase === "background" ? "emulate background browser tab"
      : phase === "foreground" ? "restore foreground browser tab" : "reset browser viewport emulation";
    assert.deepEqual(errors.mock.calls.map(call => call.arguments), [[`[desktop] ${label} failed`, failure]],
      "each failed operation is logged once under its own label, not relogged by recovery");
    assert.deepEqual(aView.webContents.loads, ["about:blank"]);
    assert.deepEqual(bView.webContents.loads, ["about:blank"]);
    assert.ok(views().every(view => !view.webContents.isDestroyed()));
    panel.destroy();
  }
});

test("destroyed tab emulation cannot act on a restored native instance sharing its logical id", async (t) => {
  const harness = createPanel();
  const { invoke, panel, views, commands, children } = harness;
  const pending = gate();
  const errors = t.mock.method(console, "error", () => {});
  t.after(async () => { pending.finish(); panel.destroy(); await flush(); });
  invoke("openwork:browser:setVisibleSession", "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  const b = invoke("openwork:browser:createTab", "about:blank", "B");
  const [aView, oldView] = views();
  enforceDebuggerAttachment(t, oldView, async (method) => {
    if (method === "Emulation.setDeviceMetricsOverride") await pending.promise;
  });
  await flush();
  assert.deepEqual(commands(oldView), [BACKGROUND_SEQUENCE[0]]);
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  await flush();
  assert.deepEqual(commands(oldView), [BACKGROUND_SEQUENCE[0]], "foreground cleanup is queued behind the old reply");
  controls.confirm = async () => 1;
  await invoke("openwork:browser:suspendTab", b.tabId);
  assert.equal(oldView.webContents.isDestroyed(), true);
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const restoring = invoke("openwork:browser:selectTab", b.tabId);
  const restoredView = views()[2];
  const restoredDebugger = enforceDebuggerAttachment(t, restoredView);
  assert.equal(await restoring, b.tabId, "the new instance's queue is independent of the old unresolved reply");
  assert.notEqual(restoredView.webContents.targetId, oldView.webContents.targetId);
  assert.deepEqual(commands(restoredView), BACKGROUND_SEQUENCE);
  const verify = watchNativePlacement(t, harness);
  pending.finish();
  await flush();
  verify(aView, PANEL_BOUNDS);
  assert.deepEqual(commands(oldView), [BACKGROUND_SEQUENCE[0]], "the old loop stops at the destroyed instance");
  assert.deepEqual(commands(restoredView), BACKGROUND_SEQUENCE, "old cleanup cannot clear or focus the replacement");
  assert.equal(restoredView.webContents.debugger.isAttached(), true);
  assert.equal(restoredDebugger.detachedCommands, 0);
  assert.deepEqual(errors.mock.calls.map(call => call.arguments), []);
  const state = invoke("openwork:browser:state");
  assert.equal(state.activeTabIdByOwner.B, b.tabId);
  assert.equal(state.tabs.find(tab => tab.id === b.tabId).ownerSessionId, "B");
  assert.deepEqual(children, [aView]);
  assert.deepEqual(createdWindows.at(-1).contentView.children, [restoredView]);
  assert.deepEqual(aView.webContents.loads, ["about:blank"]);
  assert.deepEqual(restoredView.webContents.loads, ["about:blank"]);
  assert.equal(restoredView.webContents.isDestroyed(), false);
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
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
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
  assert.equal(onScreen(), null, "shared tabs also wait for the current conversation's geometry");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  assert.ok(onScreen(), "a shared tab remains available for every conversation");
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
  const navigationListeners = mainContents.listenerCount("did-start-navigation");
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
  assert.equal(mainContents.listenerCount("did-start-navigation"), navigationListeners);
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
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  approve();
  const opened = await opening;
  assert.deepEqual(opened, {
    provider: "builtin", browser_url: "http://127.0.0.1:9222", target_id: views()[1].webContents.getOrCreateDevToolsTargetId(),
    tab_id: invoke("openwork:browser:state").activeTabIdByOwner.B, url: "https://b.example/", owner_session_id: "B", visible: true,
  });
  invoke("openwork:browser:setVisibleSession", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
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
  assert.equal(pending.browserApproval.approveLabel, "Allow for this thread");
  assert.equal(pending.browserApproval.title, "Allow browser control for this thread?");
  assert.match(pending.browserApproval.detail, /navigating allowed websites, reading and scrolling using the signed-in browser/);
  assert.match(pending.browserApproval.detail, /Clicking, typing, key input and website tools require separate confirmations/);
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
  mockPage(views()[0].webContents);
  const reading = await panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId: result.tabId } });
  assert.equal(reading.ok, true);
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval, null, "thread control also permits reading");
});

test("a late tool-change relay after discovery still asks for consent before running a listed site tool", async () => {
  const { invoke, emit, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "http://127.0.0.1:4173/" } });
  await flush();
  approve();
  const opened = await opening;
  assert.equal(opened.ok, true);
  const contents = views()[0].webContents;
  // The document registered its tool during load; the preload relays that
  // registration to the host only after its debounce.
  contents.siteTools = [{ name: "save_draft", description: "Save the draft in this controlled project." }];
  const listing = panel.browserTask({ sessionId: "A", operation: "site_tools", args: { tabId: opened.tabId } });
  const listed = await listing;
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval, null);
  assert.equal(listed.ok, true);
  assert.equal(listed.tools.length, 1);
  emit("openwork:webmcp:tools-changed", { sender: contents });
  const executing = panel.browserTask({ sessionId: "A", operation: "site_tool", args: { tabId: opened.tabId, toolId: listed.tools[0].toolId, input: {} } });
  await flush();
  const review = invoke("openwork:browser:state").tabs[0].browserApproval;
  assert.equal(review?.title, "Allow website action?", "the relay did not retire the listed handle before the consent prompt");
  assert.deepEqual(contents.siteToolCalls, [], "nothing runs before approval");
  approve();
  await flush();
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval?.title, "Share website result?");
  approve();
  const result = await executing;
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(contents.siteToolCalls.length, 1);
  // A tool the page changed or removed after listing is still refused as stale.
  contents.siteTools = [];
  const removed = await panel.browserTask({ sessionId: "A", operation: "site_tool", args: { tabId: opened.tabId, toolId: listed.tools[0].toolId, input: {} } });
  assert.equal(removed.code, "stale_tool");
  assert.equal(contents.siteToolCalls.length, 1);
  invoke("openwork:browser:closeTab", opened.tabId);
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

test("thread consent can outlive the operation timeout without navigating early", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { invoke, panel, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  let settled = false;
  let earlyResult;
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://slow.example/" } })
    .then((result) => { settled = true; earlyResult = result; return result; });
  await flush();
  const tab = invoke("openwork:browser:state").tabs[0];
  t.mock.timers.tick(31_000);
  await flush();
  assert.equal(settled, false, JSON.stringify(earlyResult));
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval.id, tab.browserApproval.id);
  assert.deepEqual(views()[0].webContents.loads, []);
  assert.deepEqual(views()[0].webContents.destinations, []);
  assert.equal(invoke("openwork:browser:approve", tab.id, tab.browserApproval.id, true), true);
  assert.equal((await opening).ok, true);
  assert.deepEqual(views()[0].webContents.loads, ["https://slow.example/"]);
  assert.deepEqual(views()[0].webContents.destinations, ["https://slow.example/"]);
});

test("human link clicks open without control state but later agent reads require consent", async () => {
  for (const allowed of [false, true]) {
    const { invoke, panel, views, approve, policies, mainContents } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    invoke("openwork:browser:linkClick", { url: LINK.url, sessionId: "A" });
    invoke("openwork:browser:setVisibleSession", "B");
    mainContents.emit("did-start-navigation", {}, "http://localhost/index.html#B", true, true);
    await flush();
    const tab = invoke("openwork:browser:state").tabs[0];
    assert.equal(tab.ownerSessionId, "A");
    assert.equal(tab.browserTask, undefined);
    assert.equal(tab.browserApproval, null);
    assert.equal(tab.automationProtected, false);
    assert.deepEqual(views()[0].webContents.destinations, [LINK.url]);
    assert.ok(policies.some(request => request.url === LINK.url && request.external === false));
    invoke("openwork:browser:setVisibleSession", "A");
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    mockPage(views()[0].webContents);
    let reads = 0;
    const read = views()[0].webContents.executeJavaScriptInIsolatedWorld;
    views()[0].webContents.executeJavaScriptInIsolatedWorld = (...args) => { reads += 1; return read(...args); };
    const observing = panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId: tab.id } });
    await flush();
    assert.equal(reads, 0);
    assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval.approveLabel, "Allow for this thread");
    assert.ok(invoke("openwork:browser:state").tabs[0].browserTask);
    approve(allowed, tab.id);
    const result = await observing;
    assert.equal(result.ok, allowed);
    if (allowed) assert.equal(result.text, "Example page");
    else assert.equal(result.text, undefined);
    assert.equal(reads > 0, allowed);
    invoke("openwork:browser:destroy");
  }
});

test("human link routing rejects other senders, unsafe URLs, denied policy and stale source documents", async () => {
  const held = gate();
  const { invoke, emit, mainContents, views, policies } = createPanel(async ({ url }) => {
    if (url === LINK.url) throw new Error("managed denial");
    await held.promise;
  });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  emit("openwork:browser:linkClick", { sender: {}, senderFrame: mainContents.mainFrame }, LINK);
  emit("openwork:browser:linkClick", { sender: mainContents, senderFrame: {} }, LINK);
  for (const url of ["javascript:alert(1)", "file:///tmp/link.html", "https://user:password@example.com"]) {
    invoke("openwork:browser:linkClick", { url });
  }
  assert.deepEqual(policies, []);
  invoke("openwork:browser:linkClick", LINK);
  await flush();
  assert.equal(views().length, 0);
  invoke("openwork:browser:linkClick", { url: "https://stale.example/" });
  mainContents.mainFrame = {};
  held.finish();
  await flush();
  assert.equal(views().length, 0);
});

test("automated main-window navigation fallback requires consent and retains its originating owner", async () => {
  for (const allowed of [false, true]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    panel.routeBlockedMainWindowNavigation("https://linked.example/private");
    invoke("openwork:browser:setVisibleSession", "B");
    await flush();
    const tab = invoke("openwork:browser:state").tabs[0];
    assert.equal(tab.ownerSessionId, "A", "the destination belongs to the conversation that initiated the navigation");
    assert.equal(tab.browserApproval.approveLabel, "Allow for this thread");
    assert.deepEqual(views()[0].webContents.destinations, []);
    assert.equal(approve(true, tab.id), false, "another conversation cannot authorize the destination");
    invoke("openwork:browser:setVisibleSession", "A");
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    approve(allowed, tab.id);
    await flush();
    assert.deepEqual(views()[0].webContents.destinations, allowed ? ["https://linked.example/private"] : []);
    if (!allowed) assert.equal(views()[0].webContents.isDestroyed(), true);
  }
});

test("thread control reuses navigation and reading consent across origins and tabs while DOM inputs require review", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "http://127.0.0.1:4173/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const contents = views()[0].webContents;
  const page = mockPage(contents);
  for (const url of ["http://127.0.0.1:4173/next", "http://127.0.0.1:4174/", "https://127.0.0.1:4173/", "http://localhost:4173/", "http://127.0.0.1.example:4173/", "http://2130706433:4175/", "http://[::1]:4173/"]) {
    assert.equal((await panel.browserTask({ sessionId: "A", operation: "navigate", args: { tabId, url } })).ok, true);
    const observed = await panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } });
    assert.equal(observed.ok, true);
    const filling = panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId: observed.observationId, action: { type: "fill", ref: "e1", text: "Example" } } });
    await flush();
    assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval?.title, "Allow browser action?");
    approve();
    assert.equal((await filling).dispatched, true);
    assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval, null);
  }
  assert.equal(page.inputs.length, 7);
  const sibling = await panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://sibling.example/" } });
  assert.equal(sibling.ok, true);
  mockPage(views()[1].webContents);
  assert.equal((await panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId: sibling.tabId } })).ok, true);
  assert.deepEqual(views()[1].webContents.destinations, ["https://sibling.example/"]);
  assert.ok(invoke("openwork:browser:state").tabs.every(tab => !tab.browserApproval));
});

test("cross-origin redirects reuse thread control but remain fenced by policy, cancellation and closure", async (t) => {
  for (const outcome of ["deny", "allow", "cancel", "close", "background"]) {
    const held = gate();
    const { invoke, panel, views, approve } = createPanel(async ({ url, method }) => {
      if (url === "http://127.0.0.1:4173/private" && method) {
        await held.promise;
        if (outcome === "deny") throw new Error("managed denial");
      }
    });
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
    const tab = invoke("openwork:browser:state").tabs[0];
    assert.equal(tab.browserApproval, null);
    if (outcome === "cancel") controller.abort();
    if (outcome === "close") invoke("openwork:browser:closeTab", tab.id);
    if (outcome === "background") invoke("openwork:browser:setVisibleSession", "B");
    held.finish();
    const allowed = outcome === "allow" || outcome === "background";
    assert.equal((await opening).ok, allowed, outcome);
    await flush();
    assert.deepEqual(views()[0].webContents.destinations, allowed ? [start, destination] : [start], outcome);
    t.mock.restoreAll();
  }
});

test("thread control never crosses conversations and closed approval cannot be revived", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://owned.example/" } });
  await flush(); approve();
  const first = await opening;
  assert.equal((await panel.browserTask({ sessionId: "B", operation: "navigate", args: { tabId: first.tabId, url: "https://owned.example/next" } })).code, "wrong_conversation");
  for (const sessionId of ["B", "C"]) {
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

test("managed subresource warnings survive aborted navigation and persist until a document commits", async () => {
  let failureCode = "policy_unavailable";
  const { invoke, views, policies } = createPanel(async ({ url }) => {
    if (url.endsWith("/blocked.css")) throw Object.assign(new Error(url), { code: failureCode });
  });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  await flush();
  const contents = views()[0].webContents;
  const loadError = () => invoke("openwork:browser:state").tabs[0].loadError;
  const stylesheet = "https://cdn.example/blocked.css";
  const loads = [...contents.loads];
  contents.emit("did-start-navigation", "https://page.example/", false, true);
  contents.emit("did-navigate", "https://page.example/");
  assert.deepEqual(await contents.request(stylesheet, { resourceType: "stylesheet" }), { cancel: true });
  const warning = {
    code: "policy_unavailable",
    message: "This page may be incomplete. Your organization's policy could not be verified.",
  };
  assert.deepEqual(loadError(), warning);
  assert.deepEqual(await contents.request("https://cdn.example/ok.js", { resourceType: "script" }), { cancel: false });
  for (const [event, ...args] of [
    ["did-start-navigation", "https://frame.example/", false, false],
    ["did-start-navigation", "https://page.example/#section", true, true],
    ["did-navigate-in-page", "https://page.example/#section", true],
    ["did-start-navigation", "https://page.example/aborted", false, true],
    ["did-fail-provisional-load", -3, "ERR_ABORTED", "https://page.example/aborted", true],
    ["did-stop-loading"],
  ]) {
    contents.emit(event, ...args);
    assert.deepEqual(loadError(), warning, `${event} must retain the warning`);
  }
  await flush();
  assert.equal(policies.filter(({ url }) => url === stylesheet).length, 1, "no policy retry");
  assert.deepEqual(contents.loads, loads, "no automatic reload");
  contents.emit("did-start-navigation", "https://page.example/next", false, true);
  assert.deepEqual(loadError(), warning, "a pending navigation still displays the old document");
  contents.emit("did-navigate", "https://page.example/next");
  assert.equal(loadError(), null);
  failureCode = "organization_policy_denied";
  assert.deepEqual(await contents.request(stylesheet, { resourceType: "image" }), { cancel: true });
  assert.deepEqual(loadError(), {
    code: "organization_policy_denied",
    message: "This page may be incomplete. Your organization's policy blocked a browser request.",
  });
  invoke("openwork:browser:reload");
  assert.equal(loadError(), null, "manual reload commits a new document");
  failureCode = "user_denied";
  assert.deepEqual(await contents.request(stylesheet, { resourceType: "stylesheet" }), { cancel: true });
  assert.equal(loadError(), null, "non-policy errors must not become policy warnings");
});

test("late managed subresource failures belong to the committed document, not a pending navigation", async () => {
  for (const ending of ["navigate", "reload", "close", "abort"]) {
    /** @type {() => void} */
    let fail = () => assert.fail("Policy check has not started");
    const { invoke, views } = createPanel(async ({ url }) => {
      if (url.endsWith("/held.css")) await new Promise((_resolve, reject) => {
        fail = () => reject(Object.assign(new Error("Private response details"), { code: "policy_unavailable" }));
      });
    });
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const { tabId } = invoke("openwork:browser:createTab", "about:blank", "A");
    await flush();
    const contents = views()[0].webContents;
    const request = contents.request("https://cdn.example/held.css", { resourceType: "stylesheet" });
    await flush();
    if (ending === "navigate" || ending === "abort") {
      contents.emit("did-start-navigation", "https://next.example/", false, true);
      if (ending === "navigate") contents.emit("did-navigate", "https://next.example/");
      else contents.emit("did-fail-provisional-load", -3, "ERR_ABORTED", "https://next.example/", true);
    }
    if (ending === "reload") invoke("openwork:browser:reload");
    if (ending === "close") {
      invoke("openwork:browser:closeTab", tabId);
      invoke("openwork:browser:createTab", "about:blank", "B");
    }
    fail();
    assert.deepEqual(await request, { cancel: true });
    const loadError = invoke("openwork:browser:state").tabs[0].loadError;
    if (ending === "abort") assert.equal(loadError?.code, "policy_unavailable", "the old document's pending resources still warn");
    else assert.equal(loadError, null, ending);
    assert.deepEqual(contents.destinations, [], "stale failures remain fail-closed");
  }
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

test("task popups share thread control while late popups after pause stay blocked", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const url = "https://owned.example/";
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url } });
  await flush(); approve();
  const { tabId } = await opening;
  const popup = () => views()[0].webContents.windowOpenHandler({ url, disposition: "foreground-tab" }).createWindow({});
  const child = popup();
  assert.deepEqual(await child.request(url), { cancel: false });
  assert.deepEqual(child.destinations, [url]);
  assert.equal(invoke("openwork:browser:state").tabs.at(-1).browserApproval, null);
  invoke("openwork:browser:taskControl", tabId, "pause");
  const lateChild = popup();
  assert.deepEqual(await lateChild.request(url), { cancel: true });
  assert.deepEqual(lateChild.destinations, []);
});

test("adopting a manual popup shares control with its opener without bypassing managed policy", async () => {
  const { invoke, panel, views, approve } = createPanel(async ({ url }) => {
    if (url === "http://127.0.0.1:4173/private") throw new Error("managed denial");
  });
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
  assert.deepEqual(await opener.request(url), { cancel: false });
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval, null);
  assert.deepEqual(await opener.request(privateUrl), { cancel: true });
  assert.deepEqual(opener.destinations, [url, url]);
});

test("parent observations preserve popup control while lifecycle endings fence pending redirects", async () => {
  for (const ending of ["cancel", "takeover", "close"]) {
    const held = gate();
    const { invoke, panel, views, approve } = createPanel(async ({ url, method }) => {
      if (url === "https://another.example/" && method) await held.promise;
    });
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const url = "https://parent.example/";
    const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url } });
    await flush(); approve();
    const { tabId } = await opening;
    const parent = views()[0].webContents;
    const page = { title: "Parent", text: "Parent page", elements: [], viewport: { width: 800, height: 600 } };
    parent.executeJavaScriptInIsolatedWorld = async () => page;
    const observe = (options) => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } }, options);
    assert.equal((await observe()).ok, true);

    const child = parent.windowOpenHandler({ url, disposition: "foreground-tab" }).createWindow({});
    assert.deepEqual(await child.request("http://localhost:4173/preview"), { cancel: false });
    assert.equal(invoke("openwork:browser:state").tabs.at(-1).browserApproval, null);
    assert.equal((await observe()).ok, true);
    assert.deepEqual(await child.request("http://localhost:4173/next"), { cancel: false }, "observing the parent preserves the popup's accepted grant");

    const canceledNavigation = child.request("https://another.example/");
    await flush();
    assert.deepEqual(child.destinations, ["http://localhost:4173/preview", "http://localhost:4173/next"]);
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
    held.finish();
    assert.deepEqual(await canceledNavigation, { cancel: true }, ending);
    assert.deepEqual(await child.request("http://localhost:4173/after-ending"), { cancel: true }, "a surviving popup remains guarded after its parent's lifetime ends");
    assert.deepEqual(child.destinations, ["http://localhost:4173/preview", "http://localhost:4173/next"], ending);
  }
});

test("concurrent same-thread requests share one approval and a busy request cannot clear its owner", async () => {
  for (const accepted of [true, false]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const first = invoke("openwork:browser:createTab", "https://first.example/", "A");
    const second = invoke("openwork:browser:createTab", "https://second.example/", "A");
    await invoke("openwork:browser:selectTab", first.tabId);
    await flush();
    const navigate = (tabId) => panel.browserTask({ sessionId: "A", operation: "navigate", args: { tabId, url: "https://destination.example/" } });
    const pending = navigate(first.tabId);
    await flush();
    assert.equal((await navigate(first.tabId)).code, "busy");
    assert.equal((await navigate(first.tabId)).code, "busy");
    const sibling = navigate(second.tabId);
    await flush();
    assert.equal(invoke("openwork:browser:state").tabs.filter(tab => tab.browserApproval).length, 1);
    approve(accepted, first.tabId);
    for (const result of await Promise.all([pending, sibling])) {
      assert.equal(result.ok, accepted);
      if (!accepted) assert.equal(result.code, "user_denied");
    }
    assert.equal(views().flatMap(view => view.webContents.destinations).filter(url => url === "https://destination.example/").length, accepted ? 2 : 0);
    panel.destroy();
  }
});

test("canceling a grant waiter fences late acceptance without reviving or revoking a newer grant", async () => {
  let hold = false;
  const policy = gate();
  const { invoke, panel, views, approve } = createPanel(async () => { if (hold) await policy.promise; });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const first = invoke("openwork:browser:createTab", "https://first.example/", "A");
  const second = invoke("openwork:browser:createTab", "https://second.example/", "A");
  await invoke("openwork:browser:selectTab", first.tabId);
  await flush();
  const navigate = (tabId, options) => panel.browserTask({ sessionId: "A", operation: "navigate", args: { tabId, url: "https://destination.example/" } }, options);
  const pending = navigate(first.tabId);
  await flush();
  const controller = new AbortController();
  const sibling = navigate(second.tabId, { signal: controller.signal });
  await flush();
  const approval = invoke("openwork:browser:state").tabs[0].browserApproval;
  hold = true;
  approve();
  await flush();
  controller.abort();
  for (const result of await Promise.all([pending, sibling])) assert.equal(result.ok, false);
  assert.equal(invoke("openwork:browser:approve", first.tabId, approval.id, true), false);
  assert.ok(views().every(view => view.webContents.destinations.every(url => url !== "https://destination.example/")));
  hold = false;
  const fresh = navigate(second.tabId);
  await flush();
  assert.equal((await fresh).code, "needs_attention");
  await invoke("openwork:browser:selectTab", second.tabId);
  const regrant = navigate(second.tabId);
  await flush(); approve();
  assert.equal((await regrant).ok, true);
  policy.finish();
  await flush();
  assert.equal((await navigate(first.tabId)).ok, true, "the old waiter cannot overwrite newer consent");
  assert.equal(views()[0].webContents.destinations.filter(url => url === "https://destination.example/").length, 1, "the canceled navigation was not replayed");
  panel.destroy();
});

test("pause and disable revoke approved control thread-wide and resume always needs a new grant", async () => {
  for (const ending of ["pause", "disable"]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://first.example/" } });
    await flush(); approve();
    const first = await opening;
    const second = await panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://second.example/" } });
    mockPage(views()[1].webContents);
    const observe = () => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId: second.tabId } });
    assert.equal((await observe()).ok, true);
    if (ending === "disable") invoke("openwork:browser:setControlEnabled", false);
    else invoke("openwork:browser:taskControl", first.tabId, "pause");
    assert.equal((await observe()).code, ending === "disable" ? "browser_disabled" : "paused");
    assert.ok(invoke("openwork:browser:state").tabs.every(tab => tab.browserTask.status === "paused"));
    assert.deepEqual(await views()[1].webContents.request("https://late.example/"), { cancel: true });
    if (ending === "disable") invoke("openwork:browser:setControlEnabled", true);
    invoke("openwork:browser:taskControl", first.tabId, "resume");
    assert.ok(invoke("openwork:browser:state").tabs.every(tab => !tab.browserApproval));
    const resumed = observe();
    await flush();
    assert.equal(invoke("openwork:browser:state").tabs[1].browserApproval?.title, "Allow browser control for this thread?");
    approve();
    assert.equal((await resumed).ok, true);
    assert.equal((await panel.browserTask({ sessionId: "A", operation: "navigate", args: { tabId: first.tabId, url: "https://next.example/" } })).ok, true);
    panel.destroy();
  }
});

test("closing one owned tab preserves consent but closing the last live tab drops only its thread's grant", async () => {
  const { invoke, panel, approve } = createPanel();
  const open = (sessionId, url) => panel.browserTask({ sessionId, operation: "open", args: { url } });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const first = open("A", "https://first.example/");
  await flush(); approve();
  const a = await first;
  const sibling = await open("A", "https://sibling.example/");
  invoke("openwork:browser:closeTab", a.tabId);
  assert.equal((await open("A", "https://sibling.example/")).ok, true);
  const other = open("B", "https://first.example/");
  await flush();
  const b = invoke("openwork:browser:state").tabs.at(-1);
  assert.ok(b.browserApproval);
  assert.equal(approve(true, b.id), false);
  invoke("openwork:browser:setVisibleSession", "B");
  invoke("openwork:browser:show", PANEL_BOUNDS, "B");
  approve();
  assert.equal((await other).ok, true);
  invoke("openwork:browser:closeTab", sibling.tabId);
  assert.equal((await open("B", "https://second.example/")).ok, true);
  const reopened = open("A", "https://first.example/");
  await flush();
  invoke("openwork:browser:setVisibleSession", "A");
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  assert.equal(invoke("openwork:browser:state").tabs.at(-1).browserApproval?.title, "Allow browser control for this thread?");
  approve();
  assert.equal((await reopened).ok, true);
  panel.destroy();
});

test("closing the last tab cancels a pending open before policy resolves and releases its opening lock", async () => {
  let hold = false;
  const policy = gate();
  const { invoke, panel, approve } = createPanel(async () => { if (hold) await policy.promise; });
  const open = (url) => panel.browserTask({ sessionId: "A", operation: "open", args: { url } });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = open("https://first.example/");
  await flush(); approve();
  const first = await opening;
  hold = true;
  let settled = false;
  const pending = open("https://pending.example/").then((value) => { settled = true; return value; });
  try {
    await flush();
    invoke("openwork:browser:closeTab", first.tabId);
    await flush();
    assert.equal(settled, true, "closure cancels the pending open without waiting for its policy check");
    assert.equal((await pending).ok, false);
    hold = false;
    const retry = open("https://retry.example/");
    await flush();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    assert.equal(invoke("openwork:browser:state").tabs.at(-1).browserApproval?.title, "Allow browser control for this thread?");
    approve();
    assert.equal((await retry).ok, true, "the opening lock is released and fresh consent is required");
  } finally {
    hold = false;
    policy.finish();
    await pending;
    panel.destroy();
  }
});

test("DOM wheel dispatch keeps signed CSS deltas, reports page scroll and never replays uncertain input", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://scroll.example/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const contents = views()[0].webContents;
  const { context, inputs } = mockPage(contents);
  const observe = () => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } });
  const scroll = (observationId, deltaY) => panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId, action: { type: "scroll", x: 25.5, y: 50.5, deltaY } } });
  for (const deltaY of [600, 1200, -1200]) {
    const observed = await observe();
    const result = await scroll(observed.observationId, deltaY);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "not_yet_verified");
    assert.equal(result.retrySafe, false);
    assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval, null);
    assert.deepEqual(contents.debugger.commands.at(-1), { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 25.5, y: 50.5, deltaX: 0, deltaY } });
    assert.equal(contents.debugger.isAttached(), false);
    assert.equal((await scroll(observed.observationId, deltaY)).code, "stale_observation");
  }
  context.scrollX = 17;
  context.scrollY = 600;
  const observed = await observe();
  assert.deepEqual({ ...observed.scroll }, { x: 17, y: 600 });
  assert.equal((await scroll(observed.observationId, 1201)).code, "invalid_scroll");
  const fresh = await observe();
  controls.beforeCommand = async (method) => { if (method === "Input.dispatchMouseEvent") throw new Error("receipt unavailable"); };
  const failed = await scroll(fresh.observationId, 600);
  assert.equal(failed.ok, false);
  assert.equal(failed.dispatched, true);
  assert.equal(failed.mayHaveChangedState, true);
  assert.equal(failed.retrySafe, false);
  assert.equal((await scroll(fresh.observationId, 600)).code, "stale_observation");
  assert.equal(contents.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent").length, 4);
  assert.deepEqual(inputs, [], "wheel events never use native sendInputEvent");
  panel.destroy();
});

test("every click, fill and key requires fresh approval and dispatches only the reviewed payload", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://inputs.example/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const contents = views()[0].webContents;
  const { inputs } = mockPage(contents);
  const observe = () => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } });
  const act = (observationId, action) => panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId, action } });
  const mouseEvents = () => contents.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent");
  for (const requested of [{ type: "click", ref: "e1" }, { type: "fill", ref: "e1", text: "Reviewed text" }, { type: "key", key: "Enter" }]) {
    contents.debugger.commands.length = 0;
    inputs.length = 0;
    const observed = await observe();
    const denied = act(observed.observationId, requested);
    await flush();
    const review = invoke("openwork:browser:state").tabs[0].browserApproval;
    assert.equal(review?.title, "Allow browser action?");
    assert.equal(review.approveLabel, "Allow once");
    assert.match(review.detail, /Target:/);
    assert.match(review.detail, /may submit information or change website data/);
    if (requested.type === "fill") assert.match(review.detail, /Text to enter: Reviewed text/);
    if (requested.type === "key") assert.match(review.detail, /focused control from this observation\. Key: Enter/);
    else assert.match(review.detail, /Search\. Reference: e1/);
    assert.deepEqual(inputs, []);
    assert.deepEqual(mouseEvents(), []);
    approve(false);
    assert.equal((await denied).code, "user_denied");
    assert.deepEqual(inputs, []);
    assert.deepEqual(mouseEvents(), []);
    assert.equal((await act(observed.observationId, requested)).code, "stale_observation");
    const fresh = await observe();
    const payload = { ...requested };
    const accepted = act(fresh.observationId, payload);
    await flush();
    assert.notEqual(invoke("openwork:browser:state").tabs[0].browserApproval?.id, review.id);
    assert.deepEqual(inputs, []);
    assert.deepEqual(mouseEvents(), []);
    Object.assign(payload, { type: "scroll", ref: "e99", text: "Unreviewed text", key: "Escape", x: 300, y: 200, deltaY: 600 });
    approve();
    assert.equal((await accepted).dispatched, true);
    if (requested.type === "click") {
      assert.deepEqual(mouseEvents().map(event => event.params), [
        { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 },
        { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 },
      ]);
      assert.deepEqual(inputs, []);
    } else {
      assert.deepEqual(mouseEvents(), []);
      assert.deepEqual(inputs, requested.type === "fill" ? [{ type: "text", text: "Reviewed text" }] : [{ type: "keyDown", keyCode: "Enter" }, { type: "keyUp", keyCode: "Enter" }]);
    }
  }
  panel.destroy();
});

test("only the current approval wait is excluded from the action freshness budget", async (t) => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://review.example/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const contents = views()[0].webContents;
  const { inputs } = mockPage(contents);
  const observe = () => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } });
  const act = (observationId) => panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId, action: { type: "fill", ref: "e1", text: "Reviewed text" } } });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const observed = await observe();
  t.mock.timers.tick(14_000);
  const accepted = act(observed.observationId);
  await flush();
  t.mock.timers.tick(20_000);
  assert.deepEqual(inputs, []);
  approve();
  assert.equal((await accepted).ok, true, "an unchanged page remains usable after a 20-second review");
  assert.deepEqual(inputs, [{ type: "text", text: "Reviewed text" }]);
  const expired = await observe();
  t.mock.timers.tick(15_001);
  assert.equal((await act(expired.observationId)).code, "stale_observation", "review time never extends another observation's age");
  assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval, null);
  const fresh = await observe();
  t.mock.timers.tick(14_000);
  const delayed = act(fresh.observationId);
  await flush();
  t.mock.timers.tick(20_000);
  const evaluate = contents.executeJavaScriptInIsolatedWorld;
  contents.executeJavaScriptInIsolatedWorld = async (...args) => { const result = await evaluate(...args); t.mock.timers.tick(1_001); return result; };
  approve();
  const result = await delayed;
  assert.equal(result.code, "stale_observation", "preparation still consumes the remaining age budget");
  assert.equal(result.dispatched, false);
  assert.equal(inputs.length, 1);
  panel.destroy();
});

test("approval cannot authorize a changed document, layout, focus, image, target or policy", async (t) => {
  let blocked = false;
  const { invoke, panel, views, approve } = createPanel(async () => { if (blocked) throw new Error("managed denial"); });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://controls.example/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const contents = views()[0].webContents;
  const page = mockPage(contents);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const { change, reset, action } of [
    { change: () => { blocked = true; }, reset: () => { blocked = false; } },
    { change: () => { page.context.__openworkBrowserObservation.id = "replaced"; }, reset: () => {} },
    { change: () => { page.context.__openworkBrowserObservation.changed = true; }, reset: () => {} },
    { change: () => contents.emit("did-start-navigation", contents.url, false, true), reset: () => {} },
    { change: () => { contents.url += "next"; }, reset: () => { contents.url = "https://controls.example/"; } },
    { change: () => { page.context.innerWidth = 900; }, reset: () => { page.context.innerWidth = 800; } },
    { change: () => { page.context.scrollY = 1; }, reset: () => { page.context.scrollY = 0; } },
    { change: () => { page.element.rect.x += 20; }, reset: () => { page.element.rect.x -= 20; } },
    { change: () => { page.element.isConnected = false; }, reset: () => { page.element.isConnected = true; } },
    { change: () => { page.element.disabled = true; }, reset: () => { page.element.disabled = false; } },
    { change: () => { page.element.type = "password"; }, reset: () => { page.element.type = "text"; } },
    { change: () => { page.context.document.activeElement = new page.context.HTMLElement(); }, reset: () => { page.context.document.activeElement = page.element; }, action: { type: "key", key: "Enter" } },
    { change: () => page.setImage("changed"), reset: () => page.setImage("initial image"), action: { type: "click", x: 30, y: 30 } },
  ]) {
    const observed = await panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId, includeImage: true } });
    assert.equal(observed.ok, true);
    const pending = panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId: observed.observationId, action: action ?? { type: "click", ref: "e1" } } });
    await flush();
    assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval?.title, "Allow browser action?");
    t.mock.timers.tick(20_000);
    change();
    approve();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    reset();
  }
  assert.deepEqual(page.inputs, []);
  assert.equal(contents.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent").length, 0);
  panel.destroy();
});

test("approved keys refuse frame and shadow-capable focus hosts even when the host identity stays unchanged", async () => {
  const { invoke, panel, views, approve } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://inputs.example/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const page = mockPage(views()[0].webContents);
  for (const tagName of ["IFRAME", "FRAME", "DIV", "SPAN", "BODY", "CUSTOM-EDITOR"]) {
    page.element.tagName = tagName;
    const observed = await panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } });
    const pending = panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId: observed.observationId, action: { type: "key", key: "Enter" } } });
    await flush();
    assert.equal(invoke("openwork:browser:state").tabs[0].browserApproval?.title, "Allow browser action?");
    approve();
    const result = await pending;
    assert.equal(result.code, "unverifiable_focus", tagName);
    assert.equal(result.dispatched, false, tagName);
    assert.deepEqual(page.inputs, [], "an unchanged host does not prove a stable focused descendant");
  }
  panel.destroy();
});

test("hidden, paused and timed-out input approvals send no events and reject late acceptance", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  for (const ending of ["hide", "pause", "timeout"]) {
    const { invoke, panel, views, approve } = createPanel();
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://inputs.example/" } });
    await flush(); approve();
    const { tabId } = await opening;
    const contents = views()[0].webContents;
    const { inputs } = mockPage(contents);
    const observed = await panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId } });
    const pending = panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId: observed.observationId, action: { type: "key", key: "Enter" } } });
    await flush();
    const review = invoke("openwork:browser:state").tabs[0].browserApproval;
    assert.equal(review?.title, "Allow browser action?");
    if (ending === "hide") { invoke("openwork:browser:hide"); approve(true, tabId); }
    if (ending === "pause") invoke("openwork:browser:taskControl", tabId, "pause");
    if (ending === "timeout") t.mock.timers.tick(30_000);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, false);
    if (ending === "timeout") assert.equal(result.code, "timeout");
    assert.equal(invoke("openwork:browser:approve", tabId, review.id, true), false);
    assert.deepEqual(inputs, []);
    assert.equal(contents.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent").length, 0);
    panel.destroy();
  }
});

test("DOM actions retain policy, visibility, bounded age, geometry, page, image and sensitive-input gates", async (t) => {
  let blocked = false;
  const { invoke, panel, views, approve } = createPanel(async () => { if (blocked) throw new Error("managed denial"); });
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://controls.example/" } });
  await flush(); approve();
  const { tabId } = await opening;
  const contents = views()[0].webContents;
  const page = mockPage(contents);
  const observe = () => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId, includeImage: true } });
  const act = (observationId, action = undefined) => panel.browserTask({ sessionId: "A", operation: "act", args: { tabId, observationId, action: action ?? { type: "fill", ref: "e1", text: "Example" } } });
  for (const { code, change, reset, action } of [
    { code: "website_blocked", change: () => { blocked = true; }, reset: () => { blocked = false; } },
    { code: "needs_attention", change: () => invoke("openwork:browser:hide"), reset: () => invoke("openwork:browser:show", PANEL_BOUNDS, "A") },
    { code: "stale_observation", change: () => { page.context.innerWidth = 900; }, reset: () => { page.context.innerWidth = 800; } },
    { code: "stale_observation", change: () => { page.context.scrollY = 1; }, reset: () => { page.context.scrollY = 0; } },
    { code: "stale_observation", change: () => { page.context.__openworkBrowserObservation.changed = true; }, reset: () => {} },
    { code: "stale_observation", change: () => contents.emit("did-start-navigation", contents.url, false, true), reset: () => {} },
    { code: "stale_observation", change: () => { contents.url += "next"; }, reset: () => { contents.url = "https://controls.example/"; } },
    { code: "sign_in_required", change: () => { page.element.type = "password"; }, reset: () => { page.element.type = "text"; } },
    { code: "sign_in_required", change: () => { page.element.type = "file"; }, reset: () => { page.element.type = "text"; }, action: { type: "key", key: "Enter" } },
    { code: "stale_observation", change: () => page.setImage("changed"), reset: () => page.setImage("initial image"), action: { type: "click", x: 30, y: 30 } },
  ]) {
    const observed = await observe();
    assert.equal(observed.ok, true);
    change();
    const pending = act(observed.observationId, action);
    await flush();
    if (invoke("openwork:browser:state").tabs[0].browserApproval) approve();
    assert.equal((await pending).code, code);
    reset();
  }
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const expired = await observe();
  t.mock.timers.tick(15_001);
  assert.equal((await act(expired.observationId)).code, "stale_observation");
  assert.deepEqual(page.inputs, []);
  assert.equal(contents.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent").length, 0);
  panel.destroy();
});

test("canceling policy, approval, preparation or dispatch revokes thread consent and fences late DOM writes", async () => {
  for (const phase of ["policy", "approval", "prepare", "dispatch"]) {
    let hold = false;
    const held = gate();
    const { invoke, panel, views, approve } = createPanel(async () => { if (hold && phase === "policy") await held.promise; });
    invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    const opening = panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://first.example/" } });
    await flush(); approve();
    const first = await opening;
    const second = await panel.browserTask({ sessionId: "A", operation: "open", args: { url: "https://second.example/" } });
    const contents = views()[1].webContents;
    mockPage(contents);
    const observe = () => panel.browserTask({ sessionId: "A", operation: "observe", args: { tabId: second.tabId } });
    const observed = await observe();
    const evaluate = contents.executeJavaScriptInIsolatedWorld;
    if (phase === "prepare") contents.executeJavaScriptInIsolatedWorld = async (...args) => { await held.promise; return evaluate(...args); };
    if (phase === "dispatch") controls.beforeCommand = async (method) => { if (method === "Input.dispatchMouseEvent") await held.promise; };
    const controller = new AbortController();
    hold = true;
    const action = panel.browserTask({ sessionId: "A", operation: "act", args: { tabId: second.tabId, observationId: observed.observationId, action: { type: "click", ref: "e1" } } }, { signal: controller.signal });
    await flush();
    const review = invoke("openwork:browser:state").tabs[1].browserApproval;
    if (phase === "prepare" || phase === "dispatch") { approve(); await flush(); }
    controller.abort();
    const result = await action;
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, phase === "dispatch");
    assert.equal(result.retrySafe, false);
    if (review) assert.equal(invoke("openwork:browser:approve", second.tabId, review.id, true), false);
    hold = false;
    held.finish();
    await flush();
    assert.equal(contents.debugger.commands.filter(command => command.method === "Input.dispatchMouseEvent").length, phase === "dispatch" ? 1 : 0);
    assert.deepEqual(await views()[0].webContents.request("https://late.example/"), { cancel: true });
    const regrant = observe();
    await flush();
    assert.ok(invoke("openwork:browser:state").tabs[1].browserApproval);
    approve();
    assert.equal((await regrant).ok, true);
    assert.equal((await panel.browserTask({ sessionId: "A", operation: "navigate", args: { tabId: first.tabId, url: "https://next.example/" } })).ok, true);
    panel.destroy();
  }
});
