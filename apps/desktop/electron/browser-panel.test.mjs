import assert from "node:assert/strict";
import { register } from "node:module";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

// Keep Electron and installed-browser discovery in memory: these guards must
// never touch the clipboard, show a dialog, or launch a real browser.
const electronStub = `
export const effects = [];
export const app = { on() {} };
export const clipboard = { writeText(url) { effects.push({ type: "copy", url }); } };
export const dialog = { async showMessageBox() { effects.push({ type: "dialog" }); } };
export const browserSession = {
  webRequest: { onBeforeRequest(_filter, handler) { browserSession.request = handler; } },
  on(event, handler) { this[event] = handler; },
  setPermissionCheckHandler(handler) { this.permissionCheck = handler; },
  setPermissionRequestHandler(handler) { this.permissionRequest = handler; },
};
export const session = { fromPartition() { return browserSession; } };
export const shell = { async openExternal(url) { effects.push({ type: "external", url }); } };
export const createdViews = [];
export const controls = {};
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
  constructor() {
    createdViews.push(this);
    const listeners = new Map();
    const targetId = "target-" + createdViews.length;
    let attached = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.webContents = {
      id: createdViews.length,
      mainFrame: {},
      url: "about:blank",
      title: "",
      loads: [],
      sent: [],
      send(channel, payload) { this.sent.push({ channel, payload }); this.onSend?.(channel, payload); },
      debugger: {
        commands: [],
        on() {},
        isAttached: () => attached,
        attach() { attached = true; },
        detach() { attached = false; },
        async sendCommand(method, params) { this.commands.push({ method, params }); return { targetInfo: { targetId } }; },
      },
      on(event, handler) { listeners.set(event, handler); },
      once(event, handler) { listeners.set(event, handler); },
      emit(event, ...args) { listeners.get(event)?.(null, ...args); },
      setWindowOpenHandler() {},
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      getURL() { return this.url; },
      getTitle() { return this.title; },
      isLoading() { return this.loading ?? false; },
      canGoBack() { return false; },
      canGoForward() { return false; },
      loadURL(url) { this.loads.push(url); this.url = url; return Promise.resolve(); },
      focus() {},
      close(options) {
        this.closeOptions = options;
        if (options?.waitForBeforeUnload) {
          this.beforeClose?.();
          if (this.veto || this.safetyClose?.() !== true) { this.emit("will-prevent-unload"); return; }
          if (this.deferClose) return;
        }
        this.destroyed = true; this.emit("destroyed");
      },
    };
    controls.onCreate?.(this);
  }
  setBounds(bounds) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
}
`;

const installedBrowsersStub = `
import { effects } from "electron";
export async function listInstalledBrowsers() {
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
  if (specifier === "@openwork/browser-tabs") return { url: ${JSON.stringify(new URL("../../../packages/browser-tabs/index.mjs", import.meta.url).href)}, shortCircuit: true };
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
const { createdViews, effects, browserSession, controls } = await import("electron");

const PANEL_BOUNDS = { x: 800, y: 40, width: 400, height: 900 };
const LINK = { url: "https://example.com/a%2Fb?x=one%20two&x=%2F#section", point: { x: 20, y: 30 }, sessionId: "A" };
const RESET_SEQUENCE = [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 0, height: 0, deviceScaleFactor: 0, mobile: false } },
  { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
];

function createPanel(checkPolicy = async () => {}, remoteDebugPort = 0) {
  effects.length = 0;
  const policies = [];
  const children = [];
  const firstView = createdViews.length;
  const sent = [];
  const mainWindow = {
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
    webContents: {
      mainFrame: {},
      getURL: () => "http://localhost/index.html",
      getZoomFactor: () => 1,
      isDestroyed: () => false,
      send(channel, payload) { sent.push({ channel, payload }); },
    },
    isDestroyed: () => false,
  };
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    on(channel, handler) { handlers.set(channel, handler); },
  };
  createBrowserPanel({
    getWindow: () => mainWindow, remoteDebugPort, onDeepLink: () => {},
    checkPolicy: async (request) => { policies.push(request); await checkPolicy(); },
  }).registerIpc(ipcMain);
  const mainContents = mainWindow.webContents;
  const emit = (channel, event, ...args) => handlers.get(channel)(event, ...args);
  const invoke = (channel, ...args) => emit(channel, { sender: mainContents, senderFrame: mainContents.mainFrame }, ...args);
  // Electron paints every child above the BrowserWindow's primary renderer.
  const onScreen = () => children.find((view) => view.getBounds().width > 1) ?? null;
  const views = () => createdViews.slice(firstView);
  const commands = (view) => view.webContents.debugger.commands;
  const messages = (channel) => sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload);
  async function openLinkMenu(payload = LINK) {
    invoke("openwork:browser:linkContextMenu", payload);
    await flush();
    const view = views().find((view) => view.webContents.getURL() === "http://localhost/overlay.html");
    assert.ok(view, "the link menu creates an overlay renderer");
    emit("openwork:menu-overlay:ready", { sender: view.webContents });
    await flush();
    const request = view.webContents.sent.findLast((entry) => entry.channel === "openwork:menu-overlay:show")?.payload;
    assert.ok(request, "the ready overlay receives its menu");
    const choose = (itemId) => emit("openwork:menu-overlay:choose", { sender: view.webContents }, { requestId: request.id, itemId });
    return { view, request, choose };
  }
  return { invoke, emit, mainContents, onScreen, commands, children, messages, views, policies, openLinkMenu };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function safeDocument(panel, view, { method = "GET", reason = null } = {}) {
  const contents = view.webContents;
  const url = contents.getURL();
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  let generation;
  const report = (token) => ({ generation, token, url: contents.getURL(), reason });
  contents.onSend = (channel, payload) => {
    if (channel === "openwork:browser:safety-init") {
      generation = payload.generation;
      panel.emit("openwork:browser:safety-report", event(), report());
    }
    if (channel === "openwork:browser:safety-probe") {
      queueMicrotask(() => panel.emit("openwork:browser:safety-report", event(), report(payload.token)));
    }
  };
  contents.safetyClose = () => {
    const request = event();
    panel.emit("openwork:browser:safety-close", request, report());
    return request.returnValue;
  };
  contents.emit("did-start-navigation", url, false, true);
  await new Promise((resolve) => browserSession.request({ url, method, resourceType: "mainFrame", webContentsId: contents.id }, resolve));
  contents.emit("did-navigate", url, 200);
  contents.emit("did-stop-loading");
  contents.emit("did-finish-load");
  return { report, event };
}

function mockTargets(t, onList = () => {}) {
  t.mock.method(globalThis, "fetch", async () => {
    await onList();
    return { ok: true, json: async () => createdViews.filter((view) => !view.webContents.isDestroyed()).map((view) => ({
      type: "page", id: `target-${view.webContents.id}`, url: view.webContents.getURL(),
    })) };
  });
}

test("showing the panel sizes the active tab and resets viewport emulation left on it", async () => {
  const { invoke, onScreen, commands } = createPanel();
  await invoke("openwork:browser:createTab", "https://example.com");
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
  const first = await invoke("openwork:browser:createTab", "https://one.example");
  const firstView = onScreen();
  await invoke("openwork:browser:createTab", "https://two.example");
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
  await invoke("openwork:browser:createTab", "https://example.com");
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
  await invoke("openwork:browser:createTab", "https://one.example");
  const firstView = onScreen();
  await invoke("openwork:browser:createTab", "https://two.example");
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
  await invoke("openwork:browser:createTab", "https://a.example", "A");
  const visibleView = onScreen();
  await flush();
  commands(visibleView).length = 0;

  const { tabId } = await invoke("openwork:browser:createTab", "https://b.example", "B");
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
  await invoke("openwork:browser:createTab", "https://a.example", "A");
  const visibleView = onScreen();
  const { tabId } = await invoke("openwork:browser:createTab", "https://b.example", "B");
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
  await invoke("openwork:browser:createTab", "https://a.example", "A");
  const aView = onScreen();
  await invoke("openwork:browser:createTab", "https://b.example", "B");
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
  await invoke("openwork:browser:createTab", "https://a.example", "A");
  const aView = onScreen();
  const { tabId } = await invoke("openwork:browser:createTab", "https://b.example", "B");
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
  for (let i = 0; i < limit; i++) await invoke("openwork:browser:createTab", "about:blank", `owner-${i}`);
  const before = invoke("openwork:browser:state");
  await assert.rejects(invoke("openwork:browser:createTab", "about:blank", "overflow"), /12 browser tabs open.*Close.*try again/);
  await assert.rejects(invoke("openwork:browser:openUrl", "https://example.com"), /12 browser tabs open/);
  assert.equal(views().length, limit, "rejection allocates no native view");
  assert.deepEqual(invoke("openwork:browser:state").tabs, before.tabs);
  invoke("openwork:browser:closeTab", before.tabs[0].id);
  assert.equal(views()[0].webContents.isDestroyed(), true);
  await invoke("openwork:browser:createTab", "about:blank", "retry");
  assert.equal(invoke("openwork:browser:state").tabs.length, limit);
});

test("owner cleanup is exact and idempotent and releases only an empty background host", async () => {
  const { invoke, views, messages } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await invoke("openwork:browser:createTab", "about:blank", "A");
  await invoke("openwork:browser:createTab", "about:blank", null);
  const b = await invoke("openwork:browser:createTab", "about:blank", "B");
  const c = await invoke("openwork:browser:createTab", "about:blank", "C");
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
  await invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  views()[0].webContents.close();
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
});

test("failed target discovery rolls back its allocation while another owner's page survives", async () => {
  const { invoke, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await invoke("openwork:browser:createTab", "about:blank", "A");
  const before = invoke("openwork:browser:state");
  await assert.rejects(invoke("openwork:browser:openUrl", "https://example.com", "builtin", { sessionId: "B" }), /Could not resolve/);
  assert.deepEqual(invoke("openwork:browser:state").tabs, before.tabs);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
  assert.equal(views()[1].webContents.isDestroyed(), true);
  assert.equal(views()[0].webContents.isDestroyed(), false);
});

test("tabs created without a conversation stay shared and behave as before", async () => {
  const { invoke, onScreen, messages } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS);
  await invoke("openwork:browser:createTab", "https://shared.example");
  await flush();

  const state = invoke("openwork:browser:state");
  assert.equal(state.tabs[0].ownerSessionId, null);
  assert.ok(onScreen(), "a shared tab is on screen");

  invoke("openwork:browser:setVisibleSession", "A");
  assert.ok(onScreen(), "a shared tab stays on screen for every conversation");
  invoke("openwork:browser:closeAllTabs");
  assert.deepEqual(messages("openwork:browser:panel-closed"), [{ ownerSessionId: null }]);
});

test("a catalog choice launches only the selected browser with the exact link, not a built-in tab", async () => {
  const { openLinkMenu, invoke, policies } = createPanel();
  const { request, choose } = await openLinkMenu();
  assert.equal(request.source, "link");
  assert.equal(request.items.find((item) => item.id === "browser:firefox")?.label, "Open in Firefox");
  choose("browser:firefox");
  await flush();

  assert.deepEqual(policies, [{ url: LINK.url, external: true }]);
  assert.deepEqual(effects, [{ type: "browser", id: "firefox", url: LINK.url }]);
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
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

test("link menus reject untrusted senders, subframes, and non-HTTP payloads", async () => {
  const { emit, invoke, mainContents, views, policies } = createPanel();
  emit("openwork:browser:linkContextMenu", { sender: {}, senderFrame: mainContents.mainFrame }, LINK);
  emit("openwork:browser:linkContextMenu", { sender: mainContents, senderFrame: {} }, LINK);
  for (const url of ["javascript:alert(1)", "file:///tmp/link.html", "data:text/html,link", "openwork://settings"]) {
    invoke("openwork:browser:linkContextMenu", { ...LINK, url });
  }
  await flush();

  assert.deepEqual(views(), [], "rejected requests never create an overlay or tab");
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

test("forged menu requests, senders, and action IDs are ignored without dismissing the valid menu", async () => {
  const { openLinkMenu, invoke, emit, policies, children } = createPanel();
  await invoke("openwork:browser:createTab", "https://existing.example");
  const { view, request, choose } = await openLinkMenu();
  const tabs = invoke("openwork:browser:state").tabs;
  emit("openwork:menu-overlay:choose", { sender: view.webContents }, { requestId: "forged", itemId: "browser:firefox" });
  invoke("openwork:menu-overlay:choose", { requestId: request.id, itemId: "browser:firefox" });
  choose("browser:unlisted");
  choose("close-all-tabs");
  await flush();

  assert.deepEqual(policies, []);
  assert.deepEqual(effects, []);
  assert.deepEqual(invoke("openwork:browser:state").tabs, tabs);
  assert.ok(children.includes(view), "invalid choices leave the menu open");
  choose("copy-url");
  assert.deepEqual(effects, [{ type: "copy", url: LINK.url }]);
  assert.ok(!children.includes(view), "a valid choice still works and dismisses the menu");
});

test("manual suspension retains metadata and UI selection reloads the same unpinned logical tab", async () => {
  const panel = createPanel();
  const { invoke, views, onScreen } = panel;
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example/read", "A");
  const view = views()[0];
  await safeDocument(panel, view);
  view.webContents.title = "Reading";
  view.webContents.emit("page-favicon-updated", ["https://static.example/icon.png"]);
  const before = invoke("openwork:browser:state").tabs[0];
  assert.equal(await invoke("openwork:browser:suspendTab", tabId), tabId);
  const suspended = invoke("openwork:browser:state");
  assert.equal(suspended.liveTabCount, 0);
  assert.deepEqual(suspended.nativeViews, []);
  assert.equal(onScreen(), null);
  assert.deepEqual(suspended.tabs[0], { ...before, status: "suspended" });
  for (let i = 0; i < 3; i++) {
    await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    invoke("openwork:browser:bounds", PANEL_BOUNDS);
    invoke("openwork:browser:setVisibleSession", "A");
    await flush();
    assert.deepEqual(invoke("openwork:browser:state").tabs, suspended.tabs, "routine refresh cannot wake a manually suspended tab");
    assert.equal(views().length, 1);
  }
  assert.equal(await invoke("openwork:browser:selectTab", tabId), tabId);
  assert.notEqual(onScreen(), view);
  const restored = invoke("openwork:browser:state");
  assert.equal(restored.liveTabCount, 1);
  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.tabs[0].id, tabId);
  assert.equal(restored.tabs[0].ownerSessionId, "A");
  assert.equal(restored.tabs[0].url, before.url);
  assert.equal(restored.tabs[0].automationProtected, false);
  await safeDocument(panel, views()[1]);
  await invoke("openwork:browser:suspendTab", tabId);
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  assert.equal(invoke("openwork:browser:state").liveTabCount, 0, "show does not undo manual suspension");
  invoke("openwork:browser:setVisibleSession", "B");
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  assert.equal(invoke("openwork:browser:state").liveTabCount, 1, "switching back intentionally wakes the saved tab");
  assert.equal(invoke("openwork:browser:state").tabs[0].restoreError, null);
  invoke("openwork:browser:destroy");
  assert.equal(invoke("openwork:browser:state").liveTabCount, 0);
});

test("automation opens are distinct and protected; restore returns a fresh target with exact owner checks", async (t) => {
  mockTargets(t);
  const panel = createPanel(undefined, 9222);
  const { invoke, views, messages } = panel;
  const first = await invoke("openwork:browser:openUrl", "https://static.example", "builtin", { sessionId: "A" });
  const second = await invoke("openwork:browser:openUrl", first.url, "builtin", { sessionId: "A" });
  assert.notEqual(first.tab_id, second.tab_id);
  assert.notEqual(first.target_id, second.target_id);
  assert.ok(messages("openwork:browser:state").filter((state) => state.tabs.length).every((state) => state.tabs.every((tab) => tab.automationProtected)));
  const contents = views()[0].webContents;
  contents.canGoBack = () => true;
  contents.navigationHistory = {
    getAllEntries: () => [{ url: contents.loads[0] }, { url: contents.url }],
    getActiveIndex: () => 1,
  };
  await safeDocument(panel, views()[0]);
  await assert.rejects(invoke("openwork:browser:suspendTab", first.tab_id), /automation/);
  for (const owner of [undefined, null, "", " ", 1, "B"]) {
    assert.throws(() => invoke("openwork:browser:restoreTab", first.tab_id, owner), /owner/);
    await assert.rejects(invoke("openwork:browser:releaseTab", first.tab_id, owner), /owner/);
  }
  assert.equal(invoke("openwork:browser:setKeepActive", first.tab_id, true), undefined);
  assert.deepEqual(await invoke("openwork:browser:releaseTab", first.tab_id, "A"), { tabId: first.tab_id, released: true });
  await assert.rejects(invoke("openwork:browser:suspendTab", first.tab_id), /keep-active/);
  invoke("openwork:browser:setKeepActive", first.tab_id, false);
  await invoke("openwork:browser:suspendTab", first.tab_id);
  const restoring = invoke("openwork:browser:restoreTab", first.tab_id, "A");
  assert.equal(invoke("openwork:browser:state").tabs[0].automationProtected, true, "pin precedes the first async step");
  const restored = await restoring;
  assert.equal(restored.tab_id, first.tab_id);
  assert.equal(restored.owner_session_id, "A");
  assert.equal(restored.url, first.url);
  assert.notEqual(restored.target_id, first.target_id);
  assert.ok(messages("openwork:browser:state").some((state) => state.tabs[0]?.status === "restoring"));
  assert.deepEqual(invoke("openwork:browser:closeSessionTabs", "A"), [first.tab_id, second.tab_id]);
  assert.equal(invoke("openwork:browser:state").liveTabCount, 0);
});

test("reclamation selects only eligible inactive LRU views and the budget is native, not logical", async () => {
  const panel = createPanel();
  const { invoke, views } = panel;
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await invoke("openwork:browser:createTab", `https://static.example/${i}`, "A")).tabId);
  for (const index of [0, 1, 2]) await safeDocument(panel, views()[index]);
  await invoke("openwork:browser:selectTab", ids[0]);
  await invoke("openwork:browser:selectTab", ids[11]);
  invoke("openwork:browser:setKeepActive", ids[2], true);
  await invoke("openwork:browser:createTab", "about:blank", "A");
  assert.equal(views()[1].webContents.isDestroyed(), true, "the least recently used eligible page goes first");
  assert.equal(views()[0].webContents.isDestroyed(), false, "the more recently selected eligible page is retained");
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => invoke("openwork:browser:createTab", "about:blank", "A")));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(views()[1].webContents.isDestroyed(), true);
  assert.equal(views()[0].webContents.isDestroyed(), true);
  assert.equal(views()[2].webContents.isDestroyed(), false);
  const state = invoke("openwork:browser:state");
  assert.equal(state.liveTabCount, 12);
  assert.equal(state.tabs.length, 14);
  assert.deepEqual(state.tabs.filter((tab) => tab.status === "suspended").map((tab) => tab.id), [ids[0], ids[1]]);
  const attempts = views().slice(12);
  assert.equal(attempts.length, 2, "refusal does not allocate a view");
  invoke("openwork:browser:closeAllTabs");
  assert.equal(invoke("openwork:browser:state").tabs.length, 0);
});

test("input, loading, media, capture, downloads, POST and unknown documents refuse manual suspension", async () => {
  const cases = [
    ["interaction", (contents) => contents.emit("before-input-event")],
    ["loading", (contents) => contents.emit("did-start-loading")],
    ["media-or-capture", (contents) => contents.emit("media-started-playing")],
    ["media-or-capture", (contents) => browserSession.permissionCheck(contents)],
    ["download", (contents) => browserSession["will-download"](null, new EventEmitter(), contents)],
    ["unsafe-navigation", (contents) => contents.emit("did-navigate-in-page", contents.url, true)],
    ["unknown-document", (contents) => { contents.emit("did-navigate", contents.url, 200); }],
    ["unsafe-navigation", (contents) => contents.emit("preload-error")],
    ["document-history", (contents) => { contents.canGoBack = () => true; }],
  ];
  for (const [reason, change] of cases) {
    const panel = createPanel();
    const { tabId } = await panel.invoke("openwork:browser:createTab", "https://static.example", "A");
    const contents = panel.views()[0].webContents;
    await safeDocument(panel, panel.views()[0]);
    change(contents);
    await assert.rejects(panel.invoke("openwork:browser:suspendTab", tabId), new RegExp(reason));
    assert.equal(contents.isDestroyed(), false, reason);
    panel.invoke("openwork:browser:destroy");
  }
  const panel = createPanel();
  const { tabId } = await panel.invoke("openwork:browser:createTab", "https://static.example/post", "A");
  await safeDocument(panel, panel.views()[0], { method: "POST" });
  await assert.rejects(panel.invoke("openwork:browser:suspendTab", tabId), /unsafe-navigation/);
  assert.equal(panel.invoke("openwork:browser:state").liveTabCount, 1);
});

test("download completion unblocks a clean page but automation release cannot clear input or capture", async (t) => {
  mockTargets(t);
  const panel = createPanel(undefined, 9222);
  const { invoke, views } = panel;
  const handle = await invoke("openwork:browser:openUrl", "https://static.example", "builtin", { sessionId: "A" });
  await safeDocument(panel, views()[0]);
  const contents = views()[0].webContents;
  const item = new EventEmitter();
  browserSession["will-download"](null, item, contents);
  await invoke("openwork:browser:releaseTab", handle.tab_id, "A");
  await assert.rejects(invoke("openwork:browser:suspendTab", handle.tab_id), /download/);
  item.emit("done", null, "completed");
  assert.equal(invoke("openwork:browser:state").tabs[0].suspensionBlockedReason, null);
  contents.emit("before-input-event");
  await invoke("openwork:browser:releaseTab", handle.tab_id, "A");
  await assert.rejects(invoke("openwork:browser:suspendTab", handle.tab_id), /interaction/);
  await safeDocument(panel, views()[0]);
  browserSession.permissionRequest(contents, "media", () => {});
  await invoke("openwork:browser:releaseTab", handle.tab_id, "A");
  await assert.rejects(invoke("openwork:browser:suspendTab", handle.tab_id), /media-or-capture/);
});

test("stale, forged and failed probes retain the page; late native input and page veto retain counts", async () => {
  for (const mode of ["subframe", "stale", "failed", "late-input", "veto", "pin-during-probe"]) {
    const panel = createPanel();
    const { invoke, views, emit } = panel;
    const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "A");
    const contents = views()[0].webContents;
    const safety = await safeDocument(panel, views()[0]);
    if (mode === "late-input") contents.beforeClose = () => contents.emit("before-input-event");
    else if (mode === "veto") contents.veto = true;
    else contents.onSend = (channel, payload) => {
      if (channel !== "openwork:browser:safety-probe") return;
      if (mode === "failed") throw new Error("disposed frame");
      if (mode === "pin-during-probe") invoke("openwork:browser:setKeepActive", tabId, true);
      const event = safety.event();
      const report = safety.report(payload.token);
      if (mode === "subframe") event.senderFrame = {};
      if (mode === "stale") report.generation -= 1;
      emit("openwork:browser:safety-report", event, report);
    };
    await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /Cannot suspend|prevented/);
    assert.equal(contents.isDestroyed(), false, mode);
    assert.equal(invoke("openwork:browser:state").liveTabCount, 1, mode);
    invoke("openwork:browser:destroy");
  }
});

test("failed restore preserves the saved tab and protection; shutdown cancels queued allocation", async () => {
  const panel = createPanel();
  const { invoke, views } = panel;
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "A");
  await safeDocument(panel, views()[0]);
  await invoke("openwork:browser:suspendTab", tabId);
  for (let i = 0; i < 12; i++) await invoke("openwork:browser:createTab", "about:blank", "B");
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "A"), /12 browser tabs/);
  const tab = invoke("openwork:browser:state").tabs[0];
  assert.equal(tab.status, "suspended");
  assert.equal(tab.automationProtected, true);
  assert.equal(tab.id, tabId);
  const queued = invoke("openwork:browser:createTab", "about:blank", "C");
  invoke("openwork:browser:destroy");
  await assert.rejects(queued, /shutdown/);
  assert.equal(invoke("openwork:browser:state").liveTabCount, 0);
  assert.equal(invoke("openwork:browser:state").tabs.length, 0);
});

test("owner cleanup cancels queued creations and missing tab IDs never fall back to the visible tab", async () => {
  const { invoke } = createPanel();
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = await invoke("openwork:browser:createTab", "about:blank", "A");
  assert.throws(() => invoke("openwork:browser:restoreTab", undefined, null), /owner/);
  await assert.rejects(invoke("openwork:browser:releaseTab", undefined, null), /owner/);
  await assert.rejects(invoke("openwork:browser:suspendTab", undefined), /Unknown/);
  assert.throws(() => invoke("openwork:browser:setKeepActive", undefined, true), /Expected/);
  const queued = invoke("openwork:browser:createTab", "about:blank", "A");
  assert.deepEqual(invoke("openwork:browser:closeSessionTabs", "A"), [tabId]);
  await assert.rejects(queued, /owner cleanup/);
  assert.equal(invoke("openwork:browser:state").liveTabCount, 0);
});

test("a delayed native close keeps its slot occupied until destroyed without detaching the debugger", async () => {
  const panel = createPanel();
  const { invoke, views } = panel;
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "B");
  const view = views()[0];
  await safeDocument(panel, view);
  await flush();
  view.webContents.deferClose = true;
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /still pending/);
  assert.equal(invoke("openwork:browser:state").liveTabCount, 1);
  assert.equal(view.webContents.debugger.isAttached(), true);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 1);
  assert.throws(() => invoke("openwork:browser:restoreTab", tabId, "B"), /still pending/);
  view.webContents.close();
  assert.equal(invoke("openwork:browser:state").liveTabCount, 0);
  assert.equal(invoke("openwork:browser:state").tabs[0].status, "suspended");
  assert.deepEqual(invoke("openwork:browser:closeSessionTabs", "B"), [tabId]);
});

test("a tab selected while an automatic safety probe is pending cannot be reclaimed", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const panel = createPanel();
  const { invoke, views } = panel;
  invoke("openwork:browser:setVisibleSession", "A");
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await invoke("openwork:browser:createTab", `https://static.example/${i}`, "A")).tabId);
  const safety = await safeDocument(panel, views()[0]);
  await invoke("openwork:browser:selectTab", ids[11]);
  views()[0].webContents.onSend = (channel, payload) => {
    if (channel !== "openwork:browser:safety-probe") return;
    void invoke("openwork:browser:selectTab", ids[0]);
    panel.emit("openwork:browser:safety-report", safety.event(), safety.report(payload.token));
  };
  await assert.rejects(invoke("openwork:browser:createTab", "about:blank", "A"), /12 browser tabs/);
  assert.equal(views()[0].webContents.isDestroyed(), false);
  assert.equal(views().length, 12);
  assert.equal(warnings.length, 1, "a failed reclaim is reported, not silently swallowed");
});

test("live UI handle requests do not navigate and preserve a preexisting debugger session", async () => {
  const panel = createPanel(undefined, 9222);
  const { invoke, views } = panel;
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "A");
  const view = views()[0];
  await flush();
  view.webContents.debugger.attach();
  const handle = await invoke("openwork:browser:restoreTab", tabId, "A");
  assert.equal(handle.tab_id, tabId);
  assert.equal(handle.url, "https://static.example");
  assert.equal(views().length, 1);
  assert.equal(view.webContents.debugger.isAttached(), true);
});

test("CDP discovery failure never marks a live document with input for reload-on-select", async (t) => {
  const panel = createPanel(undefined, 9222);
  const { invoke, views, messages } = panel;
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example/draft", "A");
  const contents = views()[0].webContents;
  await safeDocument(panel, views()[0]);
  contents.draft = "Unsaved input";
  contents.emit("before-input-event");
  const load = contents.loadURL;
  contents.loadURL = (url) => { contents.draft = ""; return load.call(contents, url); };
  const sendCommand = contents.debugger.sendCommand;
  t.mock.method(contents.debugger, "sendCommand", async function (method, params) {
    if (method === "Target.getTargetInfo") throw new Error("CDP discovery failed");
    return sendCommand.call(this, method, params);
  });
  const loads = [...contents.loads];
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "A"), /CDP discovery failed/);
  assert.equal(invoke("openwork:browser:state").tabs[0].restoreError, null);
  assert.ok(messages("openwork:browser:state").every((state) => state.tabs.every((tab) => tab.restoreError === null)));
  await invoke("openwork:browser:selectTab", tabId);
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  assert.deepEqual(contents.loads, loads, "neither discovery failure nor selection may reload the page");
  assert.equal(contents.draft, "Unsaved input");
  assert.equal(views().length, 1);
  assert.equal(contents.isDestroyed(), false);
  await invoke("openwork:browser:releaseTab", tabId, "A");
  await assert.rejects(invoke("openwork:browser:suspendTab", tabId), /interaction/);
});

test("address-bar navigation replaces a failed restore destination with or without a native view", async (t) => {
  t.after(() => { delete controls.onCreate; });
  for (const existingView of [false, true]) {
    const panel = createPanel();
    const { invoke, views } = panel;
    invoke("openwork:browser:setVisibleSession", "A");
    const { tabId } = await invoke("openwork:browser:createTab", "https://static.example/A", "A");
    await safeDocument(panel, views()[0]);
    await invoke("openwork:browser:suspendTab", tabId);
    if (existingView) {
      controls.onCreate = (view) => {
        delete controls.onCreate;
        view.webContents.loadURL = async () => {
          view.webContents.url = "chrome-error://chromewebdata/";
          throw new Error("A failed");
        };
      };
      await assert.rejects(invoke("openwork:browser:selectTab", tabId), /A failed/);
    } else {
      for (let i = 0; i < 12; i++) await invoke("openwork:browser:createTab", "about:blank", "B");
      await assert.rejects(invoke("openwork:browser:selectTab", tabId), /12 browser tabs/);
      invoke("openwork:browser:closeTab", invoke("openwork:browser:state").tabs[1].id);
    }
    const tabState = () => invoke("openwork:browser:state").tabs.find((tab) => tab.id === tabId);
    assert.ok(tabState().restoreError);
    const loads = [];
    let fail = false;
    const prepareView = (view) => {
      delete controls.onCreate;
      view.webContents.loadURL = async (url) => {
        loads.push(url);
        view.webContents.emit("did-start-navigation", url, false, true);
        view.webContents.url = fail ? "chrome-error://chromewebdata/" : url;
        view.webContents.title = fail ? "Network error" : "New destination";
        view.webContents.emit("did-navigate", view.webContents.url, fail ? -1 : 200);
        view.webContents.emit("did-stop-loading");
        if (fail) throw new Error("New destination failed");
      };
    };
    if (existingView) prepareView(views()[1]);
    else controls.onCreate = prepareView;
    const allocatedBefore = views().length;
    assert.equal(await invoke("openwork:browser:navigate", "https://static.example/B"), undefined);
    assert.deepEqual(loads, ["https://static.example/B"], "do not first reload failed URL A");
    assert.equal(views().length, allocatedBefore + Number(!existingView));
    assert.equal(tabState().url, "https://static.example/B");
    assert.equal(tabState().label, "New destination");
    assert.equal(tabState().restoreError, null);
    assert.equal(tabState().ownerSessionId, "A");
    fail = true;
    await assert.rejects(invoke("openwork:browser:navigate", "https://static.example/C"), /New destination failed/);
    assert.equal(tabState().url, "https://static.example/C", "failure recovery targets the latest explicit destination");
    assert.equal(tabState().restoreError, "New destination failed");
    fail = false;
    await invoke("openwork:browser:selectTab", tabId);
    assert.deepEqual(loads, ["https://static.example/B", "https://static.example/C", "https://static.example/C"]);
    assert.equal(tabState().restoreError, null);
    assert.equal(tabState().url, "https://static.example/C");
    invoke("openwork:browser:destroy");
  }
});

test("a failed restored load retains the logical URL and live slot for an explicit retry", async (t) => {
  const panel = createPanel(undefined, 9222);
  const { invoke, views } = panel;
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "A");
  await safeDocument(panel, views()[0]);
  await invoke("openwork:browser:suspendTab", tabId);
  t.after(() => { delete controls.onCreate; });
  controls.onCreate = (view) => { view.webContents.loadURL = async () => { throw new Error("navigation failed"); }; };
  await assert.rejects(invoke("openwork:browser:restoreTab", tabId, "A"), /navigation failed/);
  const state = invoke("openwork:browser:state");
  assert.equal(state.liveTabCount, 1);
  assert.equal(state.tabs[0].url, "https://static.example");
  assert.equal(state.tabs[0].automationProtected, true);
  assert.equal(state.tabs[0].restoreError, "navigation failed");
  const contents = views()[1].webContents;
  contents.loadURL = async (url) => { contents.url = url; };
  const handle = await invoke("openwork:browser:restoreTab", tabId, "A");
  assert.equal(handle.url, "https://static.example");
  assert.equal(handle.tab_id, tabId);
  assert.equal(views().length, 2, "retry uses the retained native page, not another allocation");
  assert.equal(invoke("openwork:browser:state").tabs[0].restoreError, null);
});

test("UI restore failures retain the logical URL and retry an existing view once with restoring status", async (t) => {
  const panel = createPanel();
  const { invoke, views } = panel;
  const originalUrl = "https://static.example/read";
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = await invoke("openwork:browser:createTab", originalUrl, "A");
  await safeDocument(panel, views()[0]);
  views()[0].webContents.title = "Saved title";
  await invoke("openwork:browser:suspendTab", tabId);
  let attempts = 0;
  t.after(() => { delete controls.onCreate; });
  controls.onCreate = (view) => {
    delete controls.onCreate;
    view.webContents.loadURL = async (url) => {
      attempts += 1;
      assert.equal(url, originalUrl);
      view.webContents.url = "chrome-error://chromewebdata/";
      view.webContents.title = "Network error";
      view.webContents.emit("did-navigate", view.webContents.url, -1);
      view.webContents.emit("did-stop-loading");
      throw new Error(`Offline ${attempts}`);
    };
  };
  const stateTab = () => invoke("openwork:browser:state").tabs[0];
  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(invoke("openwork:browser:selectTab", tabId), new RegExp(`Offline ${attempt}`));
    assert.equal(stateTab().restoreError, `Offline ${attempt}`);
    assert.equal(stateTab().url, originalUrl);
    assert.equal(stateTab().label, "Saved title");
    assert.equal(stateTab().status, "ready");
    assert.equal(stateTab().automationProtected, false);
    assert.equal(invoke("openwork:browser:state").liveTabCount, 1);
    for (let i = 0; i < 3; i++) {
      await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
      invoke("openwork:browser:bounds", PANEL_BOUNDS);
      await flush();
    }
    assert.equal(attempts, attempt, "refresh must not retry a failed restore");
    assert.equal(views().length, 2, "a failed native page stays allocated for retry");
  }
  const contents = views()[1].webContents;
  let complete;
  contents.loadURL = (url) => {
    attempts += 1;
    assert.equal(url, originalUrl);
    contents.emit("did-start-loading");
    return new Promise((resolve) => { complete = () => {
      contents.url = originalUrl;
      contents.title = "Reloaded title";
      contents.emit("did-stop-loading");
      resolve();
    }; });
  };
  const first = invoke("openwork:browser:selectTab", tabId);
  const second = invoke("openwork:browser:selectTab", tabId);
  await flush();
  assert.equal(stateTab().status, "restoring", "existing-view retry publishes restoring, not just loading");
  assert.equal(stateTab().restoreError, "Offline 2", "error clears only when the retry succeeds");
  assert.equal(stateTab().url, originalUrl);
  assert.equal(attempts, 3, "concurrent selections await the same UI restore");
  complete();
  assert.deepEqual(await Promise.all([first, second]), [tabId, tabId]);
  assert.equal(stateTab().status, "ready");
  assert.equal(stateTab().restoreError, null);
  assert.equal(stateTab().label, "Reloaded title");
  assert.equal(views().length, 2);
});

test("background UI restore failure publishes an error without a refresh retry loop", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const panel = createPanel();
  const { invoke, views } = panel;
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "A");
  await safeDocument(panel, views()[0]);
  await invoke("openwork:browser:suspendTab", tabId);
  for (let i = 0; i < 12; i++) await invoke("openwork:browser:createTab", "about:blank", "B");
  invoke("openwork:browser:setVisibleSession", "B");
  invoke("openwork:browser:setVisibleSession", "A");
  await flush();
  const stateTab = () => invoke("openwork:browser:state").tabs.find((tab) => tab.id === tabId);
  assert.match(stateTab().restoreError, /12 browser tabs/);
  assert.equal(stateTab().status, "suspended");
  assert.equal(errors.length, 1, "background failure is surfaced and reported");
  for (let i = 0; i < 3; i++) {
    await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
    invoke("openwork:browser:bounds", PANEL_BOUNDS);
    await flush();
  }
  assert.equal(errors.length, 1);
  assert.equal(views().length, 13);
  invoke("openwork:browser:closeTab", invoke("openwork:browser:state").tabs[1].id);
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  assert.equal(stateTab().status, "suspended", "freeing capacity alone must not loop a failed restore");
  await invoke("openwork:browser:selectTab", tabId);
  assert.equal(stateTab().restoreError, null);
  assert.equal(stateTab().status, "ready");
  assert.equal(stateTab().automationProtected, false);
});

test("completed automation leases allow user viewport resets but never allow reclamation", async (t) => {
  let finishDiscovery;
  mockTargets(t, () => new Promise((resolve) => { finishDiscovery = resolve; }));
  const panel = createPanel(undefined, 9222);
  const { invoke, views, commands } = panel;
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const opening = invoke("openwork:browser:openUrl", "https://static.example", "builtin", { sessionId: "A" });
  await flush();
  const view = views()[0];
  view.webContents.emit("focus");
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  assert.deepEqual(commands(view), [], "an openUrl operation in flight keeps its viewport");
  finishDiscovery();
  const handle = await opening;
  for (const action of [
    () => invoke("openwork:browser:show", PANEL_BOUNDS, "A"),
    () => view.webContents.emit("focus"),
    () => invoke("openwork:browser:selectTab", handle.tab_id),
  ]) {
    commands(view).length = 0;
    await action();
    await flush();
    assert.deepEqual(commands(view), RESET_SEQUENCE, "the long-lived automation lease must not suppress user resets");
  }
  await safeDocument(panel, view);
  await assert.rejects(invoke("openwork:browser:suspendTab", handle.tab_id), /automation/);
  for (let i = 0; i < 11; i++) await invoke("openwork:browser:createTab", "about:blank", "B");
  invoke("openwork:browser:setVisibleSession", "B");
  await assert.rejects(invoke("openwork:browser:createTab", "about:blank", "B"), /12 browser tabs/);
  assert.equal(view.webContents.isDestroyed(), false, "an inactive leased page cannot be reclaimed");
  assert.equal(views().length, 12);
});

test("UI selection awaits a pending beforeunload close before restoring the logical tab", async () => {
  const panel = createPanel();
  const { invoke, views } = panel;
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "A");
  const contents = views()[0].webContents;
  await safeDocument(panel, views()[0]);
  contents.deferClose = true;
  const suspending = invoke("openwork:browser:suspendTab", tabId);
  await flush();
  assert.deepEqual(contents.closeOptions, { waitForBeforeUnload: true });
  const selecting = invoke("openwork:browser:selectTab", tabId);
  await invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  await flush();
  assert.equal(views().length, 1, "selection cannot allocate before native destruction");
  assert.equal(invoke("openwork:browser:state").liveTabCount, 1);
  contents.close();
  assert.equal(await suspending, tabId);
  assert.equal(await selecting, tabId);
  assert.equal(views().length, 2);
  assert.equal(invoke("openwork:browser:state").tabs[0].restoreError, null);
  assert.equal(invoke("openwork:browser:state").tabs[0].status, "ready");
});

test("concurrent restores reserve live slots and pin both identities before asynchronous loading", async (t) => {
  const panel = createPanel(undefined, 9222);
  const { invoke, views, messages } = panel;
  const saved = [];
  for (let i = 0; i < 2; i++) {
    const { tabId } = await invoke("openwork:browser:createTab", `https://static.example/${i}`, "A");
    await safeDocument(panel, views().at(-1));
    await invoke("openwork:browser:suspendTab", tabId);
    saved.push(tabId);
  }
  for (let i = 0; i < 10; i++) await invoke("openwork:browser:createTab", "about:blank", "B");
  let finishLoad;
  t.after(() => { delete controls.onCreate; });
  controls.onCreate = (view) => {
    delete controls.onCreate;
    view.webContents.loadURL = (url) => new Promise((resolve) => { finishLoad = () => { view.webContents.url = url; resolve(); }; });
  };
  const first = invoke("openwork:browser:restoreTab", saved[0], "A");
  const second = invoke("openwork:browser:restoreTab", saved[1], "A");
  assert.ok(invoke("openwork:browser:state").tabs.slice(0, 2).every((tab) => tab.automationProtected));
  const overflow = assert.rejects(invoke("openwork:browser:createTab", "about:blank", "C"), /12 browser tabs/);
  await flush();
  assert.equal(invoke("openwork:browser:state").liveTabCount, 11);
  assert.equal(invoke("openwork:browser:state").tabs[0].status, "restoring");
  finishLoad();
  const restored = await Promise.all([first, second]);
  await overflow;
  assert.notEqual(restored[0].target_id, restored[1].target_id);
  assert.equal(invoke("openwork:browser:state").liveTabCount, 12);
  assert.ok(messages("openwork:browser:state").every((state) => state.liveTabCount <= 12));
});

test("isolated preload scans mutations linearly and stops permanently on input or document risk", async () => {
  const source = await readFile(new URL("./browser-content-preload.cjs", import.meta.url), "utf8");
  function preload() {
    const listeners = new Map();
    const ipc = new Map();
    const reports = [];
    let observe;
    let queued = [];
    const scans = { full: 0, children: 0, own: 0, disconnected: false };
    const element = (name = "div", children = [], attributeNames = []) => ({
      nodeType: 1, localName: name, shadowRoot: null,
      attributes: attributeNames.map((name) => ({ name })),
      matches(selector) {
        scans.own += 1;
        return selector.split(",").includes(name) || attributeNames.some((name) => selector.includes(`[${name}]`));
      },
      get children() { scans.children += 1; return children; },
    });
    const bodyChildren = [];
    const body = element("body", bodyChildren);
    const document = { nodeType: 9, readyState: "complete", designMode: "off",
      get children() { scans.full += 1; return [body]; } };
    runInNewContext(source, {
      require: () => ({ ipcRenderer: {
        on(channel, handler) { ipc.set(channel, handler); },
        send(channel, report) { if (channel === "openwork:browser:safety-report") reports.push(report); },
        sendSync() { return false; },
      } }),
      process: { isMainFrame: true }, document, location: { href: "https://static.example" }, history: { state: null },
      window: { addEventListener(event, handler) { const list = listeners.get(event) ?? []; list.push(handler); listeners.set(event, list); } },
      MutationObserver: class {
        constructor(handler) { observe = handler; }
        observe() {}
        takeRecords() { const records = queued; queued = []; return records; }
        disconnect() { scans.disconnected = true; queued = []; }
      },
    });
    ipc.get("openwork:browser:safety-init")(null, { generation: 1 });
    return { reports, document, body, bodyChildren, element, scans,
      queue: (records) => { queued = records; },
      init: () => ipc.get("openwork:browser:safety-init")(null, { generation: 1 }),
      observe: (records) => observe(records), dispatch: (event, payload = {}) => listeners.get(event)?.forEach((handler) => handler(payload)),
      probe: () => ipc.get("openwork:browser:safety-probe")(null, { token: 1, generation: 1 }) };
  }
  const batch = preload();
  assert.equal(batch.scans.full, 1);
  batch.init();
  assert.equal(batch.scans.full, 1, "initialization scans the document only once");
  const nodes = Array.from({ length: 100 }, () => batch.element());
  batch.bodyChildren.push(...nodes);
  const before = { ...batch.scans };
  batch.observe(nodes.map((node) => ({ target: batch.body, addedNodes: [node], removedNodes: [] })));
  assert.equal(batch.scans.full, 1, "mutation reports must not rescan the document");
  assert.equal(batch.scans.children - before.children, nodes.length, "walk only the added subtrees, never the growing target subtree");
  assert.equal(batch.scans.own - before.own, nodes.length * 2, "inspect each record's target attributes and added node once");
  const leaves = Array.from({ length: 20 }, () => batch.element());
  const parent = batch.element("div", leaves);
  batch.bodyChildren.push(parent);
  const beforeOverlap = batch.scans.children;
  batch.observe([parent, ...leaves].map((node) => ({ target: batch.body, addedNodes: [node], removedNodes: [] })));
  assert.equal(batch.scans.children - beforeOverlap, leaves.length + 1, "overlapping added trees are visited only once per batch");
  batch.probe();
  assert.equal(batch.scans.full, 2, "one full scan per explicit probe");
  assert.equal(batch.reports.at(-1).reason, null);
  for (const event of ["pointerdown", "keydown", "input", "change", "drop", "paste", "submit"]) {
    const page = preload();
    assert.equal(page.reports.at(-1).reason, null);
    page.dispatch(event);
    const stopped = { ...page.scans };
    page.observe([{ target: page.body, addedNodes: [page.element()], removedNodes: [] }]);
    page.probe();
    assert.equal(page.reports.at(-1).reason, "interaction", event);
    assert.equal(page.scans.disconnected, true);
    assert.deepEqual(page.scans, stopped, "interaction permanently stops DOM scan work");
  }
  for (const [name, attributes] of [["script", []], ["input", []], ["img", ["onerror"]]]) {
    const page = preload();
    const removed = page.element("div", [page.element(name, [], attributes)]);
    page.observe([{ target: page.body, addedNodes: [], removedNodes: [removed] }]);
    assert.equal(page.reports.at(-1).reason, "document-risk", `removed ${name} remains protected`);
    const stopped = { ...page.scans };
    page.probe();
    page.observe([{ target: page.body, addedNodes: [page.element()], removedNodes: [] }]);
    assert.equal(page.scans.disconnected, true);
    assert.deepEqual(page.scans, stopped, "a permanent document risk stops all subsequent scanning");
  }
  const removedHandler = preload();
  removedHandler.observe([{ target: removedHandler.body, attributeName: "onclick", addedNodes: [], removedNodes: [] }]);
  assert.equal(removedHandler.reports.at(-1).reason, "document-risk", "an already-removed inline handler is still latched");
  const failedScan = preload();
  const unreadable = { nodeType: 1, matches() { throw new Error("scan failed"); } };
  failedScan.observe([{ target: failedScan.body, addedNodes: [unreadable], removedNodes: [] }]);
  assert.equal(failedScan.reports.at(-1).reason, "document-risk", "inspection failures fail closed");
  assert.equal(failedScan.scans.disconnected, true);
  const page = preload();
  page.queue([{ target: page.body, addedNodes: [], removedNodes: [page.element("script")] }]);
  let prevented = false;
  page.dispatch("beforeunload", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.scans.disconnected, true, "the final close check drains pending removals before considering the page safe");
  assert.equal(preload().reports.at(-1).reason, null, "a fresh document has fresh latches");
});

test("saved metadata has its own bound without preventing restoration at that bound", async () => {
  const panel = createPanel(undefined, 9222);
  const { invoke, views } = panel;
  let first;
  for (let i = 0; i < 100; i++) {
    const { tabId } = await invoke("openwork:browser:createTab", "https://static.example", "A");
    first ??= tabId;
    await safeDocument(panel, views().at(-1));
    await invoke("openwork:browser:suspendTab", tabId);
  }
  assert.equal(invoke("openwork:browser:state").liveTabCount, 0);
  await assert.rejects(invoke("openwork:browser:createTab", "about:blank", "B"), /100 saved browser tabs/);
  const handle = await invoke("openwork:browser:restoreTab", first, "A");
  assert.equal(handle.tab_id, first);
  assert.equal(invoke("openwork:browser:state").tabs.length, 100);
  assert.equal(invoke("openwork:browser:state").liveTabCount, 1);
  invoke("openwork:browser:destroy");
  assert.equal(invoke("openwork:browser:state").tabs.length, 0);
});
