import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import test from "node:test";

// Keep the real panel, registry and task host. Only native Electron and the
// unrelated website-tool/policy integrations are replaced, as in browser-panel.test.mjs.
const electron = `
  import { EventEmitter } from "node:events";
  export const views = [];
  export const calls = [];
  export const navigation = { load: async () => {} };
  export const app = new EventEmitter();
  export class BrowserWindow {
    static getAllWindows() { return []; }
    constructor() {
      this.destroyed = false;
      this.contentView = {
        children: [],
        addChildView: (view) => this.contentView.children.push(view),
        removeChildView: (view) => {
          this.contentView.children = this.contentView.children.filter((child) => child !== view);
        },
      };
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  export class WebContentsView {
    constructor() {
      const contents = new EventEmitter();
      let destroyed = false;
      let url = "about:blank";
      Object.assign(contents, {
        id: views.length + 1,
        isDestroyed: () => destroyed,
        isCrashed: () => false,
        isFocused: () => false,
        isLoading: () => false,
        getURL: () => url,
        getTitle: () => "",
        canGoBack: () => false,
        canGoForward: () => false,
        getOrCreateDevToolsTargetId: () => "target-" + contents.id,
        debugger: { isAttached: () => false },
        loadURL: (value) => {
          calls.push({ method: "loadURL", id: contents.id, url: value });
          url = value;
          return navigation.load(contents, value);
        },
        setWindowOpenHandler() {},
        stop: () => calls.push({ method: "stop", id: contents.id }),
        close: (options) => {
          calls.push({ method: "close", id: contents.id, options });
          destroyed = true;
          contents.emit("destroyed");
        },
      });
      this.webContents = contents;
      views.push(this);
    }
    getVisible() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
    setBounds() {}
  }
  export const session = { fromPartition: () => ({
    on() {}, webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} },
  }) };
  export const clipboard = {}, dialog = {}, nativeImage = {}, shell = {};
`;
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Flush continuations without allowing setImmediate (or another native event)
// to run. Promise-only deferral must not be sufficient for either regression.
async function microtasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

test("browser panel keeps navigation routing and canceled opens off the native stack", async (t) => {
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
  const { views, calls, navigation } = await import("electron");

  function fixture(checkPolicy = async () => {}) {
    const mainContents = { mainFrame: {}, isDestroyed: () => false, send() {} };
    const mainWindow = { webContents: mainContents, isDestroyed: () => false, contentView: { children: [] } };
    const panel = createBrowserPanel({ getWindow: () => mainWindow, checkPolicy });
    const handlers = new Map();
    panel.registerIpc({ handle: (name, handler) => handlers.set(name, handler), on() {} });
    const invoke = (name, ...args) => handlers.get(`openwork:browser:${name}`)({ sender: mainContents, senderFrame: mainContents.mainFrame }, ...args);
    invoke("setVisibleSession", "original-conversation");
    return { panel, invoke };
  }

  await t.test("blocked navigation waits for a macrotask and retains its original conversation", async (t) => {
    const policyCalls = [];
    const { panel, invoke } = fixture(async (input) => { policyCalls.push(input); });
    t.after(() => panel.destroy());
    const start = views.length;
    const url = "https://example.test/linked-page";
    panel.routeBlockedMainWindowNavigation(url);
    assert.equal(views.length, start);
    assert.deepEqual(policyCalls, []);

    // The person changes conversations before Electron unwinds navigation.
    invoke("setVisibleSession", "other-conversation");
    await microtasks();
    assert.equal(views.length, start, "Promise continuations must not allocate a native view");
    assert.deepEqual(policyCalls, [], "even the first policy/task-host work waits for the macrotask");

    await nextMacrotask();
    assert.equal(views.length, start + 1);
    assert.equal(views.at(-1).webContents.getURL(), url);
    const original = await panel.browserTask({ sessionId: "original-conversation", operation: "tabs" });
    const other = await panel.browserTask({ sessionId: "other-conversation", operation: "tabs" });
    assert.equal(original.ok, true);
    assert.equal(original.tabs.length, 1);
    assert.equal(original.tabs[0].url, url);
    assert.equal(original.tabs[0].visible, false);
    assert.deepEqual(other.tabs, []);
  });

  await t.test("abort and rejected open coalesce cleanup into one later macrotask", async (t) => {
    const { panel, invoke } = fixture();
    t.after(() => panel.destroy());
    const loading = deferred();
    const started = deferred();
    navigation.load = () => { started.resolve(); return loading.promise; };
    t.after(() => { navigation.load = async () => {}; });
    const controller = new AbortController();
    const opening = panel.browserTask({ sessionId: "original-conversation", operation: "open", args: { url: "https://example.test/pending" } }, { signal: controller.signal });
    await started.promise;
    const contents = views.at(-1).webContents;
    const tabId = invoke("state").tabs[0].id;
    const nativeCleanup = () => calls.filter((call) => call.id === contents.id && ["stop", "close"].includes(call.method));
    const scheduled = [];
    const schedule = globalThis.setImmediate;
    t.mock.method(globalThis, "setImmediate", (...args) => { scheduled.push(args); return schedule(...args); });

    const error = new Error("Opening canceled during navigation");
    controller.abort(error);
    assert.deepEqual(nativeCleanup(), [], "abort must not call stop or close synchronously");
    assert.equal(invoke("state").tabs.some((tab) => tab.id === tabId), false, "abort immediately removes the logical tab");
    assert.equal(scheduled.length, 1);
    // A rejected load drives openBrowserTab's catch after its abort handler has
    // already requested cleanup, while the native navigation stack is still live.
    loading.reject(error);
    await microtasks();
    const result = await opening;
    assert.equal(result.ok, false);
    assert.equal(result.dispatched, true);
    assert.deepEqual(nativeCleanup(), [], "neither abort nor catch may destroy navigation in a microtask");
    assert.equal(scheduled.length, 1, "catch must reuse the abort handler's queued cleanup");
    assert.equal(invoke("state").tabs.some((tab) => tab.id === tabId), false, "catch must not restore the canceled tab");

    await nextMacrotask();
    assert.deepEqual(nativeCleanup(), [{ method: "close", id: contents.id, options: { waitForBeforeUnload: false } }]);
    assert.equal(invoke("state").tabs.some((tab) => tab.id === tabId), false);
    await nextMacrotask();
    assert.equal(nativeCleanup().length, 1, "the canceled document is closed exactly once");
  });

  for (const waitForApproval of [false, true]) {
    await t.test(`canceled open cleanup preserves a retry ${waitForApproval ? "waiting for policy approval" : "already opened before native cleanup"}`, async (t) => {
      const approval = deferred();
      const approvalStarted = deferred();
      let holdApproval = false;
      const { panel, invoke } = fixture(async () => {
        if (holdApproval) {
          approvalStarted.resolve();
          await approval.promise;
        }
      });
      t.after(() => panel.destroy());
      const loading = deferred();
      const started = deferred();
      navigation.load = () => { started.resolve(); return loading.promise; };
      t.after(() => { navigation.load = async () => {}; });
      const controller = new AbortController();
      // Retry the exact same address: a canceled document must not be reused
      // just because its native contents are still alive until the next turn.
      const request = { sessionId: "original-conversation", operation: "open", args: { url: "https://example.test/retry" } };
      const opening = panel.browserTask(request, { signal: controller.signal });
      await started.promise;
      const oldContents = views.at(-1).webContents;
      const oldTabId = invoke("state").tabs[0].id;
      const cleanupStart = calls.length;
      const nativeCleanup = () => calls.slice(cleanupStart).filter((call) => ["stop", "close"].includes(call.method));
      const error = new Error("Canceled before retry");
      controller.abort(error);
      loading.reject(error);
      assert.equal((await opening).ok, false);
      assert.deepEqual(invoke("state").tabs, [], "the canceled tab is unavailable before a newer request starts");
      assert.equal(oldContents.isDestroyed(), false, "logical cancellation must not synchronously destroy native contents");
      assert.deepEqual(nativeCleanup(), []);

      navigation.load = async () => {};
      holdApproval = waitForApproval;
      let retrySettled = false;
      const retry = panel.browserTask(request).then((result) => { retrySettled = true; return result; });
      let result;
      if (waitForApproval) {
        await approvalStarted.promise;
        await microtasks();
        assert.equal(retrySettled, false);
        assert.deepEqual(invoke("state").tabs, [], "the retry has not allocated a tab while policy approval is pending");
      } else {
        result = await retry;
        assert.equal(result.ok, true, "the retry must acquire fresh control and a fresh tab");
        assert.notEqual(result.tabId, oldTabId);
      }
      assert.deepEqual(nativeCleanup(), [], "the newer request starts before old native cleanup runs");

      await nextMacrotask();
      assert.deepEqual(nativeCleanup(), [{ method: "close", id: oldContents.id, options: { waitForBeforeUnload: false } }]);
      if (waitForApproval) {
        assert.equal(retrySettled, false, "old native cleanup must not revoke a newer request awaiting approval");
        approval.resolve();
        result = await retry;
      }
      assert.equal(result.ok, true, "the newer request survives the old document's native close");
      assert.notEqual(result.tabId, oldTabId);
      const newContents = views.at(-1).webContents;
      assert.notEqual(newContents, oldContents);
      assert.equal(newContents.isDestroyed(), false);
      const tabs = await panel.browserTask({ sessionId: request.sessionId, operation: "tabs" });
      assert.equal(tabs.ok, true);
      assert.deepEqual(tabs.tabs.map((tab) => tab.tabId), [result.tabId]);
      assert.equal(tabs.tabs[0].url, request.args.url);
      await nextMacrotask();
      assert.equal(nativeCleanup().length, 1, "delayed cleanup must close only the canceled document, once");
      assert.equal(newContents.isDestroyed(), false);
    });
  }
});
