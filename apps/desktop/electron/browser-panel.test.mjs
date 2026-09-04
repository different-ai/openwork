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
  const mainWindow = {
    contentView: {
      children,
      addChildView(view) { children.push(view); },
      removeChildView(view) { children.splice(children.indexOf(view), 1); },
    },
    webContents: { getZoomFactor: () => 1, isDestroyed: () => false, send() {} },
    isDestroyed: () => false,
  };
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    on(channel, handler) { handlers.set(channel, handler); },
  };
  createBrowserPanel({ getWindow: () => mainWindow, remoteDebugPort: 0, onDeepLink: () => {} }).registerIpc(ipcMain);
  const invoke = (channel, ...args) => handlers.get(channel)(null, ...args);
  const onScreen = () => children[0] ?? null;
  const commands = (view) => view.webContents.debugger.commands;
  return { invoke, onScreen, commands };
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
