import assert from "node:assert/strict";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Keep Electron and installed-browser discovery in memory: these guards must
// never touch the clipboard, show a dialog, or launch a real browser.
const electronStub = `
export const effects = [];
export const app = { on() {} };
export const clipboard = { writeText(url) { effects.push({ type: "copy", url }); } };
export const dialog = { async showMessageBox() { effects.push({ type: "dialog" }); } };
export const requestHooks = new Map();
export const session = { fromPartition(partition) { return { webRequest: { onBeforeRequest(filter, handler) { requestHooks.set(partition, handler); } } }; } };
export const shell = { async openExternal(url) { effects.push({ type: "external", url }); } };
export const createdViews = [];
export const createdWindows = [];
export const loadGates = new Map();
export class BrowserWindow {
  static getAllWindows() { return []; }
  constructor(options) {
    createdWindows.push(this);
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
    this.options = options;
    this.targetId = 'target-' + createdViews.length;
    const listeners = new Map();
    let attached = false;
    let destroyed = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.webContents = {
      url: "about:blank",
      sent: [],
      loads: [],
      send(channel, payload) { this.sent.push({ channel, payload }); },
      debugger: {
        commands: [],
        isAttached: () => attached,
        attach() { attached = true; },
        detach() { attached = false; },
        async sendCommand(method, params) {
          this.commands.push({ method, params });
          if (method === "Target.getTargetInfo") return { targetInfo: { type: "page", targetId: createdViews.find((view) => view.webContents?.debugger === this).targetId } };
        },
      },
      on(event, handler) { listeners.set(event, handler); },
      once(event, handler) { listeners.set(event, handler); },
      emit(event, ...args) { listeners.get(event)?.(null, ...args); },
      input(input) { let prevented = false; listeners.get("before-input-event")?.({ preventDefault() { prevented = true; } }, input); return prevented; },
      setWindowOpenHandler(handler) { this.openPopup = handler; },
      isDestroyed() { return destroyed; },
      getURL() { return this.url; },
      getTitle() { return ""; },
      isLoading() { return this.loading === true; },
      stop() { this.loading = false; },
      canGoBack() { return this.backEnabled === true; },
      canGoForward() { return this.forwardEnabled === true; },
      goBack() { this.wentBack = true; },
      goForward() { this.wentForward = true; },
      reload() { this.reloaded = true; },
      loadURL(url) { this.loads.push(url); this.url = url; return loadGates.get(url.startsWith("data:") ? "marker" : url) ?? Promise.resolve(); },
      focus() {},
      close(options) { this.closeOptions = options; destroyed = true; this.emit("destroyed"); },
    };
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
const browserPackage = ${JSON.stringify(new URL("../../../packages/browser-tabs/", import.meta.url).href)};
export function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: "electron-stub:main", shortCircuit: true };
  if (specifier === "./installed-browsers.mjs") return { url: "installed-browsers-stub:main", shortCircuit: true };
  if (specifier === "@openwork/browser-tabs/electron") return { url: new URL("electron.mjs", browserPackage).href, shortCircuit: true };
  if (specifier === "@openwork/browser-tabs/preload") return { url: new URL("browser-content-preload.cjs", browserPackage).href, shortCircuit: true };
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
const { createBrowserPanel: createBrowserHost } = await import("../../../packages/browser-tabs/electron.mjs");
const { runDetachedTask } = await import("./process-resilience.mjs");
// @ts-expect-error The registered test-only Electron stub exports its witnesses.
const { createdViews, createdWindows, effects, requestHooks, loadGates } = await import("electron");

const PANEL_BOUNDS = { x: 800, y: 40, width: 400, height: 900 };
const LINK = { url: "https://example.com/a%2Fb?x=one%20two&x=%2F#section", point: { x: 20, y: 30 }, sessionId: "A" };
const RESET_SEQUENCE = [
  { method: "Emulation.setDeviceMetricsOverride", params: { width: 0, height: 0, deviceScaleFactor: 0, mobile: false } },
  { method: "Emulation.clearDeviceMetricsOverride", params: undefined },
];

function createPanel(checkPolicy = async () => {}, { shared = false, ...hostOptions } = {}) {
  effects.length = 0;
  const policies = [];
  const children = [];
  const firstView = createdViews.length;
  const firstWindow = createdWindows.length;
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
  const factory = shared ? createBrowserHost : createBrowserPanel;
  const host = factory({
    getWindow: () => mainWindow, remoteDebugPort: 0, onDeepLink: () => {},
    checkPolicy: async (request) => { policies.push(request); await checkPolicy(request); },
    ...(shared ? {
      remoteDebugPort: 9222,
      partition: "persist:coworker-browser-test",
      preloadPath: fileURLToPath(new URL("../../../packages/browser-tabs/browser-content-preload.cjs", import.meta.url)),
      runDetachedTask,
      openExternal: async (url) => { effects.push({ type: "external", url }); },
      onEvent: (channel, payload) => sent.push({ channel, payload }),
    } : {}),
    ...hostOptions,
  });
  if (!shared) host.registerIpc(ipcMain);
  const mainContents = mainWindow.webContents;
  const emit = (channel, event, ...args) => handlers.get(channel)(event, ...args);
  const invoke = (channel, ...args) => emit(channel, { sender: mainContents, senderFrame: mainContents.mainFrame }, ...args);
  // Electron paints every child above the BrowserWindow's primary renderer.
  const onScreen = () => children.find((view) => view.getBounds().width > 1) ?? null;
  const views = () => createdViews.slice(firstView);
  const windows = () => createdWindows.slice(firstWindow);
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
  return { host, invoke, emit, mainContents, onScreen, commands, children, messages, views, windows, policies, openLinkMenu };
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
  await assert.rejects(invoke("openwork:browser:openUrl", "https://example.com"), /12 browser tabs open/);
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
  assert.ok(views().every(view => view.webContents.closeOptions?.waitForBeforeUnload === false));
});

test("external target destruction releases owner state and the empty hidden host", async () => {
  const { invoke, views, windows, messages } = createPanel();
  invoke("openwork:browser:createTab", "about:blank", "B");
  await flush();
  views()[0].webContents.close();
  assert.deepEqual(invoke("openwork:browser:state").tabs, []);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
  assert.deepEqual(windows()[0].contentView.children, []);
  assert.equal(windows()[0].isDestroyed(), true);
  assert.deepEqual(messages("openwork:browser:panel-closed"), [{ ownerSessionId: "B" }]);
});

test("failed target discovery rolls back its allocation while another owner's page survives", async (context) => {
  const { invoke, views } = createPanel();
  invoke("openwork:browser:show", PANEL_BOUNDS, "A");
  invoke("openwork:browser:createTab", "about:blank", "A");
  const before = invoke("openwork:browser:state");
  await assert.rejects(invoke("openwork:browser:openUrl", "https://example.com", "builtin", { sessionId: "B" }), /Could not resolve/);
  assert.deepEqual(invoke("openwork:browser:state").tabs, before.tabs);
  assert.equal(invoke("openwork:browser:state").backgroundWindowCount, 0);
  assert.equal(views()[1].webContents.isDestroyed(), true);
  assert.equal(views()[0].webContents.isDestroyed(), false);

  stubCdp(context);
  for (const phase of ["marker", "destination"]) {
    for (const signal of [undefined, new AbortController().signal]) {
      const { host, views } = createPanel(undefined, { shared: true });
      const existing = await host.createBrowser({ ownerId: "A", url: "https://existing.example" });
      const key = phase === "marker" ? "marker" : "https://failed.example";
      const gate = Promise.withResolvers();
      loadGates.set(key, gate.promise);
      try {
        const opening = host.createBrowser({ ownerId: "B", url: "https://failed.example", signal, shouldPreserveOnAbort: () => {
          assert.fail("a navigation failure is not a takeover handoff");
        } });
        const rejected = assert.rejects(opening, /load failed/);
        await flush();
        gate.reject(new Error("load failed"));
        await rejected;
        assert.deepEqual(host.listBrowsers("A"), [existing]);
        assert.deepEqual(host.listBrowsers("B"), []);
        assert.equal(views()[1].webContents.isDestroyed(), true);
        assert.equal(views()[0].webContents.isDestroyed(), false);
        assert.equal(host.state().backgroundWindowCount, 1, "the surviving owner keeps its parking host");
      } finally {
        loadGates.delete(key);
        host.destroy();
      }
    }
  }
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
  invoke("openwork:browser:createTab", "https://existing.example");
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

function stubCdp(context) {
  context.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "http://127.0.0.1:9222/json/list");
    return { ok: true, json: async () => [
      { id: "main-renderer", type: "page", url: "http://localhost/index.html" },
      ...createdViews.filter((view) => !view.webContents.isDestroyed()).map((view) => ({
        id: view.targetId, type: "page", url: view.webContents.getURL(),
      })),
    ] };
  });
}

test("the shared host creates exact marker targets and scopes list, selection and close without registering IPC", async (context) => {
  stubCdp(context);
  const { host, views, onScreen, windows, messages } = createPanel(undefined, { shared: true });
  host.show(PANEL_BOUNDS, { sessionId: "A" });
  const a = await host.createBrowser({ ownerId: "A", url: "https://same.example" });
  const b = await host.createBrowser({ ownerId: "B", url: "https://same.example" });
  const [aView, bView] = views();
  assert.equal(a.targetId, aView.targetId);
  assert.equal(b.targetId, bView.targetId);
  assert.notEqual(a.targetId, b.targetId, "identical destination URLs do not determine ownership or CDP identity");
  assert.equal(b.browserUrl, "http://127.0.0.1:9222");
  assert.equal(b.ownerId, "B");
  assert.equal(b.url, "https://same.example");
  assert.equal(b.visible, false);
  assert.equal(onScreen(), aView);
  assert.deepEqual(host.listBrowsers("B"), [b]);
  assert.deepEqual(host.listBrowsers("missing"), []);
  assert.throws(() => host.listBrowsers(null), /ownerId is required/);
  await assert.rejects(host.createBrowser({ ownerId: "", url: "https://example.com" }), /ownerId is required/);
  for (const method of [host.closeBrowser, host.selectBrowser]) {
    assert.throws(() => method({ ownerId: "A", targetId: b.targetId }), /does not belong/);
    assert.throws(() => method({ ownerId: "B", tabId: b.tabId, targetId: a.targetId }), /does not belong/);
    assert.throws(() => method({ ownerId: "B" }), /tabId or targetId is required/);
  }
  assert.equal(views().length, 2, "no optional overlay or IPC renderer is needed");
  for (const view of views()) {
    assert.deepEqual(view.webContents.loads.slice(1), ["https://same.example"], "no queued blank navigation aborts the marker");
    assert.match(decodeURIComponent(view.webContents.loads[0]), /openwork-browser-tab:tab_/);
    assert.equal(view.options.webPreferences.partition, "persist:coworker-browser-test");
    assert.equal(view.options.webPreferences.preload, fileURLToPath(new URL("../../../packages/browser-tabs/browser-content-preload.cjs", import.meta.url)));
    assert.equal(view.options.webPreferences.sandbox, true);
    assert.equal(view.options.webPreferences.contextIsolation, true);
    assert.equal(view.options.webPreferences.nodeIntegration, false);
  }
  host.setVisibleSession("B");
  host.selectBrowser({ ownerId: "B", targetId: b.targetId });
  await flush();
  assert.equal(onScreen(), bView);
  assert.equal(host.listBrowsers("B")[0].targetId, b.targetId, "moving the native view preserves the target");
  assert.equal(host.closeBrowser({ ownerId: "A", tabId: a.tabId }), a.tabId);
  assert.equal(onScreen(), bView, "scoped background close leaves B on screen");
  assert.equal(windows().length, 1, "all background owners share one parking host");
  assert.deepEqual(messages("openwork:browser:panel-closed"), [{ ownerSessionId: "A" }]);
  host.destroy();
  assert.ok(windows()[0].isDestroyed());
  assert.ok(views().every((view) => view.webContents.isDestroyed()));
});

test("explicit background opens stay parked for the visible owner and direct controls use the selected page", async (context) => {
  stubCdp(context);
  const { host, views, onScreen, messages, windows } = createPanel(undefined, { shared: true });
  host.show(PANEL_BOUNDS, { sessionId: "A" });
  const first = await host.createBrowser({ ownerId: "A", url: "https://first.example", inBackground: true });
  assert.equal(first.visible, false);
  assert.equal(host.state().activeTabId, null);
  assert.equal(onScreen(), null, "the first background open does not become a foreground fallback");
  assert.deepEqual(messages("openwork:browser:panel-opened"), []);
  host.selectBrowser({ ownerId: "A", tabId: first.tabId });
  await flush();
  const firstView = onScreen();
  assert.equal(host.state().backgroundWindowCount, 0);
  assert.equal(windows()[0].isDestroyed(), true, "selecting the last parked tab releases its empty host");
  const second = await host.createBrowser({ ownerId: "A", url: "https://second.example", inBackground: true });
  const secondView = views()[1];
  secondView.webContents.emit("did-start-navigation", "https://second.example/next", false, true);
  assert.equal(onScreen(), firstView, "background navigation cannot replace the selected page");
  assert.equal(host.state().activeTabId, first.tabId);
  assert.equal(windows().filter((window) => !window.isDestroyed()).length, 1, "only one parking host is live");
  assert.equal(windows().length, 2, "a later background open recreates the released host");
  host.selectBrowser({ ownerId: "A", targetId: second.targetId });
  await flush();
  assert.equal(onScreen(), secondView);
  assert.equal(host.state().backgroundWindowCount, 0);
  secondView.webContents.backEnabled = true;
  secondView.webContents.forwardEnabled = true;
  host.back();
  host.forward();
  host.reload();
  host.navigate("next.example");
  await flush();
  assert.equal(secondView.webContents.wentBack, true);
  assert.equal(secondView.webContents.wentForward, true);
  assert.equal(secondView.webContents.reloaded, true);
  assert.equal(secondView.webContents.getURL(), "https://next.example");
  assert.equal(firstView.webContents.getURL(), "https://first.example");
  const bounds = { x: 10, y: 20, width: 500, height: 600 };
  host.setBounds(bounds);
  assert.deepEqual(secondView.getBounds(), bounds);
  host.hide();
  assert.equal(onScreen(), null);
  host.show(bounds);
  assert.equal(onScreen(), secondView);
  host.destroy();
});

test("the shared host parks multiple owners without a main window instead of creating a visible fallback", async (context) => {
  stubCdp(context);
  const { host, windows, views } = createPanel(undefined, { shared: true, getWindow: () => null });
  for (const ownerId of ["A", "B", "C"]) {
    await host.createBrowser({ ownerId, url: "https://example.com" });
  }
  await flush();
  assert.equal(windows().length, 1);
  assert.deepEqual(windows()[0].contentView.children, views());
  assert.equal(host.state().backgroundWindowVisible, false);
  assert.ok(host.state().nativeViews.every((view) => !view.attached));
  host.destroy();
});

test("aborting an opening preserves only a shell-selected handoff tab, and reports uncertain cleanup", async (context) => {
  stubCdp(context);
  for (const preserve of [false, true, "uncertain"]) {
    const { host, views } = createPanel(undefined, { shared: true });
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    const loading = Promise.withResolvers();
    const opening = host.createBrowser({ ownerId: "A", url: "https://loading.example", signal: controller.signal, shouldPreserveOnAbort: ({ ownerId, tabId }) => {
      assert.equal(ownerId, "A");
      assert.equal(tabId, host.listBrowsers("A")[0].tabId);
      return preserve !== false;
    } });
    const view = views()[0];
    view.webContents.loadURL = (url) => { view.webContents.url = url; entered.resolve(); return loading.promise; };
    view.webContents.stop = () => { loading.reject(new Error("Loading stopped")); if (preserve === "uncertain") throw new Error("Cannot confirm stop"); };
    const close = view.webContents.close;
    view.webContents.close = () => { close.call(view.webContents); loading.reject(new Error("Closed")); };
    const rejected = assert.rejects(opening, preserve === "uncertain" ? { code: "BROWSER_ABORT_CLEANUP_UNCERTAIN" } : /cancelled/);
    await entered.promise;
    const original = host.listBrowsers("A")[0];
    controller.abort(new Error("Opening cancelled"));
    await rejected;
    assert.equal(view.webContents.isDestroyed(), preserve === false);
    assert.equal(host.state().backgroundWindowCount, preserve === false ? 0 : 1, "takeover keeps its tab's parking host; cancellation releases it");
    if (preserve !== false) {
      const remaining = host.listBrowsers("A")[0];
      assert.equal(remaining.tabId, original.tabId);
      assert.equal(remaining.targetId, original.targetId);
      assert.equal(remaining.url, "https://loading.example");
    }
    host.destroy();
  }
  for (const phase of ["marker", "discovery"]) {
    const { host, views } = createPanel(undefined, { shared: true });
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const controller = new AbortController();
    let discovery;
    if (phase === "marker") loadGates.set("marker", gate.promise);
    else discovery = context.mock.method(globalThis, "fetch", async () => { entered.resolve(); await gate.promise; return { ok: true, json: async () => [] }; });
    const opening = host.createBrowser({ ownerId: "A", url: "https://must-not-reload.example", signal: controller.signal, shouldPreserveOnAbort: () => true });
    const rejected = assert.rejects(opening, /cancelled/);
    const view = views()[0];
    view.webContents.stop = () => { view.webContents.loading = false; if (phase === "marker") gate.reject(new Error("Marker stopped")); };
    if (phase === "discovery") await entered.promise;
    assert.equal(host.listBrowsers("A")[0].targetId, null);
    controller.abort(new Error("Opening cancelled"));
    if (phase === "discovery") gate.resolve();
    await rejected;
    const preserved = host.listBrowsers("A")[0];
    assert.equal(preserved.targetId, view.targetId, phase);
    assert.equal(preserved.identityOnly, true);
    assert.equal(view.webContents.loads.length, 1, "identity recovery neither reloads the marker nor starts the destination");
    assert.ok(view.webContents.debugger.commands.some(({ method }) => method === "Target.getTargetInfo"));
    assert.equal(view.webContents.isDestroyed(), false);
    loadGates.delete("marker");
    discovery?.mock.restore();
    let stops = 0;
    view.webContents.loading = true;
    view.webContents.stop = () => { stops++; view.webContents.loading = false; };
    await assert.rejects(host.stopBrowser({ ownerId: "B", tabId: preserved.tabId, targetId: preserved.targetId }), { code: "BROWSER_ABORT_CLEANUP_UNCERTAIN" });
    assert.equal(stops, 0);
    await host.stopBrowser({ ownerId: "A", tabId: preserved.tabId, targetId: preserved.targetId });
    assert.equal(stops, 1);
    assert.equal(view.webContents.isLoading(), false);
    host.destroy();
  }
});

test("watch capture stays parked at the supplied viewport, bounds JPEG output, and scopes fullscreen Escape", async (context) => {
  stubCdp(context);
  const exits = [];
  const { host, views, onScreen, mainContents, commands } = createPanel(undefined, { shared: true, backgroundViewport: { width: 1280, height: 900 }, onPresentationExit: (target) => exits.push(target) });
  let focused = 0;
  mainContents.focus = () => { focused++; };
  const tab = await host.createBrowser({ ownerId: "A", url: "https://example.com" });
  const view = views()[0];
  await flush();
  assert.deepEqual(view.getBounds(), { x: 0, y: 0, width: 1280, height: 900 });
  assert.equal(commands(view)[0].params.height, 900);
  const sizes = [];
  let bytes = 8;
  view.webContents.capturePage = async () => ({ isEmpty: () => false, getSize: () => ({ width: 3200, height: 2000 }), resize(size) {
    sizes.push(size);
    return { toJPEG(quality) { sizes.at(-1).jpegQuality = quality; return Buffer.alloc(bytes); } };
  } });
  for (const size of ["thumbnail", "watch"]) {
    const image = await host.captureBrowserThumbnail({ ownerId: "A", tabId: tab.tabId, size });
    assert.ok(image.capturedAt <= Date.now() && image.capturedAt > 0);
    assert.deepEqual([image.width, image.height], size === "watch" ? [1600, 1000] : [480, 300]);
    assert.equal(sizes.at(-1).jpegQuality, size === "watch" ? 70 : 60);
  }
  bytes = 1536 * 1024 + 1;
  assert.equal(await host.captureBrowserThumbnail({ ownerId: "A", tabId: tab.tabId, size: "watch" }), null);
  bytes = 512 * 1024 + 1;
  assert.equal(await host.captureBrowserThumbnail({ ownerId: "A", tabId: tab.tabId }), null);
  assert.equal(onScreen(), null);
  assert.equal(host.listBrowsers("A")[0].targetId, tab.targetId);
  const escape = { type: "keyDown", key: "Escape" };
  host.setPresentation({ ownerId: "A", tabId: tab.tabId, mode: "fullscreen" });
  assert.equal(view.webContents.input(escape), false, "a parked page cannot trigger shell Escape");
  host.show(PANEL_BOUNDS, { sessionId: "A" });
  assert.equal(host.state().backgroundWindowCount, 0, "showing the only parked owner releases the empty host");
  host.setPresentation({ ownerId: "A", tabId: "other", mode: "fullscreen" });
  assert.equal(view.webContents.input(escape), false);
  host.setPresentation({ ownerId: "A", tabId: tab.tabId, mode: "side" });
  assert.equal(view.webContents.input(escape), false);
  host.setPresentation({ ownerId: "A", tabId: tab.tabId, mode: "fullscreen" });
  assert.equal(view.webContents.input(escape), true);
  assert.equal(focused, 1);
  assert.deepEqual(exits, [{ ownerId: "A", tabId: tab.tabId }]);
  host.hide();
  assert.equal(view.webContents.input(escape), false);
  host.destroy();
});

test("the injected partition retains the request policy boundary for navigation, frames and uploads", async (context) => {
  stubCdp(context);
  const { host, policies } = createPanel(async ({ url }) => {
    if (url.includes("blocked")) throw new Error("blocked");
  }, { shared: true });
  await host.createBrowser({ ownerId: "A", url: "https://example.com" });
  const hook = requestHooks.get("persist:coworker-browser-test");
  const request = (url, method = "GET", uploadData = []) => new Promise((resolve) => hook({ url, method, uploadData }, resolve));
  assert.deepEqual(await request("https://allowed.example/frame"), { cancel: false });
  assert.deepEqual(await request("https://blocked.example/cdp"), { cancel: true });
  assert.deepEqual(await request("https://blocked.example/upload", "POST", [{}]), { cancel: true });
  assert.deepEqual(await request("data:text/html,marker"), { cancel: false });
  assert.deepEqual(policies, [
    { url: "https://allowed.example/frame", method: "GET", hasUpload: false },
    { url: "https://blocked.example/cdp", method: "GET", hasUpload: false },
    { url: "https://blocked.example/upload", method: "POST", hasUpload: true },
  ]);
  host.destroy();
});

test("embedded popup adapters retain the opener's owner across focus changes and resolve their own target", async (context) => {
  stubCdp(context);
  let choose;
  const popups = [];
  const { host, views, policies } = createPanel(undefined, {
    shared: true,
    popupDisposition: (popup) => { popups.push(popup); return new Promise((resolve) => { choose = resolve; }); },
  });
  host.setVisibleSession("A");
  const opener = await host.createBrowser({ ownerId: "A", url: "https://opener.example" });
  assert.deepEqual(views()[0].webContents.openPopup({ url: "https://popup.example" }), { action: "deny" });
  await flush();
  host.setVisibleSession("B");
  choose("embedded");
  await flush();
  assert.deepEqual(popups, [{ ownerId: "A", tabId: opener.tabId, url: "https://popup.example" }]);
  assert.deepEqual(policies, [{ url: "https://popup.example", external: false }]);
  const popup = host.listBrowsers("A")[1];
  assert.equal(popup.url, "https://popup.example");
  assert.equal(popup.targetId, views()[1].targetId);
  assert.equal(popup.visible, false);
  assert.deepEqual(host.listBrowsers("B"), []);
  assert.deepEqual(effects, []);
  host.destroy();
});

test("Desktop keeps its external popup behavior and owner-preserving policy fallback", async () => {
  for (const allowed of [true, false]) {
    const { invoke, views, policies, host } = createPanel(async () => { if (!allowed) throw new Error("blocked"); });
    invoke("openwork:browser:createTab", "https://opener.example", "A");
    assert.equal(views()[0].options.webPreferences.partition, "persist:openwork-browser");
    views()[0].webContents.openPopup({ url: "https://popup.example" });
    invoke("openwork:browser:setVisibleSession", "B");
    await flush();
    assert.deepEqual(policies, [{ url: "https://popup.example", external: true }]);
    assert.deepEqual(effects, allowed ? [{ type: "external", url: "https://popup.example" }] : []);
    assert.equal(host.state().tabs.length, allowed ? 1 : 2);
    assert.ok(host.state().tabs.every((tab) => tab.ownerSessionId === "A"));
    host.destroy();
  }
});

test("deep-link handling is injected while Desktop keeps both current handoff schemes", async (context) => {
  stubCdp(context);
  const links = [];
  const { host, views, onScreen } = createPanel(undefined, {
    shared: true,
    handleDeepLink(url) {
      if (!url.startsWith("coworker-test://")) return false;
      links.push(url);
      return true;
    },
  });
  host.show(PANEL_BOUNDS, { sessionId: "A" });
  await host.createBrowser({ ownerId: "A", url: "https://example.com" });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  views()[0].webContents.emit("did-start-navigation", "coworker-test://handoff", false, true);
  assert.deepEqual(links, ["coworker-test://handoff"]);
  context.mock.timers.tick(200);
  await flush();
  assert.equal(views()[0].webContents.getURL(), "about:blank");
  assert.equal(onScreen(), null);
  host.destroy();
  const desktopLinks = [];
  const desktop = createPanel(undefined, { onDeepLink: (urls) => desktopLinks.push(...urls) });
  desktop.invoke("openwork:browser:createTab", "https://example.com");
  for (const url of ["openwork://handoff", "openwork-dev://handoff"]) {
    desktop.views()[0].webContents.emit("did-start-navigation", url, false, true);
  }
  assert.deepEqual(desktopLinks, ["openwork://handoff", "openwork-dev://handoff"]);
  context.mock.timers.tick(200);
  await flush();
  desktop.host.destroy();
});
