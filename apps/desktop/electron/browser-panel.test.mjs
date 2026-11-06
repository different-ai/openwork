import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Exercise the real panel and tab registry without opening native windows.
// Only Electron and the unrelated website-tool/policy integrations are fakes.
const electron = `
  import { EventEmitter } from "node:events";
  export const views = [];
  export const app = new EventEmitter();
  export class BrowserWindow { static getAllWindows() { return []; } }
  export class WebContentsView {
    constructor() {
      const contents = new EventEmitter();
      Object.assign(contents, {
        id: views.length + 1,
        isDestroyed: () => false,
        isFocused: () => false,
        isLoading: () => false,
        getURL: () => "about:blank",
        getTitle: () => "",
        canGoBack: () => false,
        canGoForward: () => false,
        loadURL: async () => {},
        setWindowOpenHandler: (handler) => { this.popup = handler; },
        close: () => { throw new Error("Opening a tab must not close an existing document"); },
      });
      this.webContents = contents;
      views.push(this);
    }
    getVisible() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
  }
  export const session = { fromPartition: () => ({
    on() {}, webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} },
  }) };
  export const clipboard = {}, dialog = {}, nativeImage = {}, shell = {};
`;

function stub(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

test("desktop opens more than twelve and one hundred tabs without evicting documents", async (t) => {
  const electronUrl = stub(electron);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron") return { url: electronUrl, shortCircuit: true };
      if (specifier === "@openwork/browser-tabs") return { url: new URL("../../../packages/browser-tabs/index.mjs", import.meta.url).href, shortCircuit: true };
      if (specifier === "@openwork/computer-use/browser-task") return { url: new URL("../../../packages/computer-use/browser-task.mjs", import.meta.url).href, shortCircuit: true };
      if (specifier === "@openwork/types/den/agent-permissions-runtime") return { url: stub(`
        export const agentPermissionDenialMessage = () => "Denied";
        export const decideAgentPermission = () => ({ effect: "allow" });
        export const stricterAgentPermissionDecision = (decision) => decision;
      `), shortCircuit: true };
      if (specifier === "./webmcp-host.mjs") return { url: stub("export const createWebMcpBroker = () => ({ invalidateTab() {} });"), shortCircuit: true };
      if (specifier === "./webmcp-policy.mjs") return { url: stub("export const createWebMcpFramePolicy = () => ({ install() {} });"), shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const { createBrowserPanel } = await import("./browser-panel.mjs");
  const { views } = await import("electron");
  const handlers = new Map();
  const panel = createBrowserPanel({ getWindow: () => null });
  panel.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on() {} });
  const invoke = (name, ...args) => handlers.get(`openwork:browser:${name}`)({}, ...args);

  const ids = [];
  for (let index = 0; index < 105; index++) {
    ids.push(invoke("createTab", "about:blank", null).tabId);
  }
  // Popups use the same allocation path as the tab-strip button and agents.
  const popup = views[0].popup({ url: "https://example.test/", disposition: "foreground-tab" });
  assert.equal(popup.action, "allow");
  const popupContents = popup.createWindow({});
  assert.equal(views.at(-1).webContents, popupContents);

  const state = invoke("state");
  assert.equal(state.tabs.length, 106);
  assert.equal(state.nativeViews.length, 106);
  assert.deepEqual(state.tabs.slice(0, 105).map(tab => tab.id), ids);
  assert.equal(new Set(state.tabs.map(tab => tab.id)).size, 106);
  assert.equal(Object.hasOwn(state, "tabLimit"), false);
  // In particular, the first document is still the very same native view.
  assert.equal(views[0].webContents.id, 1);
});
