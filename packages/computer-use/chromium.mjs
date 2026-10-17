// Headed Chromium on the cloud computer. CDP stays on loopback; callers only
// get the existing conversation-owned browser contract, never arbitrary CDP.
import { readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createBrowserTaskHost } from "./browser-task.mjs";

export function createCloudBrowser({ statePath, assertActive, enabled, beforeInput, endpoint = "http://127.0.0.1:9222" }) {
  const tabs = new Map();
  const owners = new Map();
  let loaded = false;
  let saving = Promise.resolve();
  async function persist() {
    saving = saving.catch(() => {}).then(async () => {
      await writeFile(`${statePath}.tmp`, JSON.stringify([...owners]), { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    });
    await saving;
  }
  async function json(path, method = "GET") {
    const response = await fetch(`${endpoint}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("The cloud browser is unavailable. Reconnect the computer.");
    return response.json();
  }
  function connection(url) {
    // Chromium may report its host in this URL. Never follow a remote endpoint.
    const address = new URL(url);
    if (address.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(address.hostname) || address.port !== new URL(endpoint).port) throw new Error("Invalid Chromium endpoint.");
    const socket = new WebSocket(url);
    const pending = new Map();
    let sequence = 0;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Browser connection timed out.")); }, 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser connection failed.")); }, { once: true });
    });
    void ready.catch(() => {});
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) { if (message.method === "Page.frameNavigated") tabChanged(); return; }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
    let tabChanged = () => {};
    socket.addEventListener("close", () => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser disconnected; inspect before retrying input.")); }
      pending.clear();
    });
    return {
      changed(callback) { tabChanged = callback; },
      async send(method, params = {}, check = true) {
        await ready;
        if (check) assertActive();
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser receipt timed out; do not replay input.")); }, 15_000);
          pending.set(id, { resolve, reject, timer });
          try { socket.send(JSON.stringify({ id, method, params })); }
          catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
        });
      },
      close() { socket.close(); },
    };
  }
  function makeTab(target) {
    const wire = connection(target.webSocketDebuggerUrl);
    let currentUrl = target.url;
    let title = target.title;
    let destroyed = false;
    let context = null;
    const tab = { tabId: target.id, webMcpRevision: 0, view: { webContents: {
      isDestroyed: () => destroyed,
      getURL: () => currentUrl,
      getTitle: () => title,
      stop: () => { void wire.send("Page.stopLoading", {}, false).catch(() => {}); },
      async prepareInput() { await beforeInput(); await wire.send("Page.bringToFront"); },
      async executeJavaScriptInIsolatedWorld(_world, scripts) {
        assertActive();
        if (context === null) {
          const tree = await wire.send("Page.getFrameTree");
          context = (await wire.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "openwork-browser" })).executionContextId;
        }
        const result = await wire.send("Runtime.evaluate", { expression: scripts[0].code, contextId: context, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
      },
      async captureObservation(viewport) {
        if (![viewport.width, viewport.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192)) throw new Error("The browser viewport is unavailable.");
        const result = await wire.send("Page.captureScreenshot", { format: "png" });
        const png = Buffer.from(result.data, "base64");
        if (!png.length || png.length > 16 * 1024 * 1024) throw new Error("The browser image is too large.");
        // Match the native host's image-to-CSS coordinate contract at browser
        // zoom levels too; an unscaled CDP image can have different dimensions.
        return new Promise((resolve, reject) => {
          const child = execFile("convert", ["png:-", "-resize", `${viewport.width}x${viewport.height}!`, "png:-"],
            { encoding: "buffer", timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
          child.stdin.on("error", () => {});
          child.stdin.end(png);
        });
      },
      async insertText(text) { await beforeInput(); await wire.send("Page.bringToFront"); return wire.send("Input.insertText", { text }); },
      // The shared host awaits native key dispatch as well as pointer dispatch.
      async sendInputEvent(event) {
        await beforeInput();
        await wire.send("Page.bringToFront");
        return wire.send("Input.dispatchKeyEvent", { type: event.type === "keyDown" ? "keyDown" : "keyUp", key: { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Space: " " }[event.keyCode] ?? event.keyCode, windowsVirtualKeyCode: { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Space: 32, Up: 38, Down: 40, Left: 37, Right: 39 }[event.keyCode] });
      },
      debugger: { isAttached: () => true, sendCommand: async (method, params) => { await beforeInput(); await wire.send("Page.bringToFront"); return wire.send(method, params); } },
    } },
      async navigate(url) {
        await beforeInput();
        await wire.send("Page.bringToFront");
        const navigation = await wire.send("Page.navigate", { url });
        if (navigation.errorText) throw new Error("Browser navigation did not finish.");
        currentUrl = url; context = null; tab.webMcpRevision++; host.invalidate(tab.tabId);
        for (let attempt = 0; attempt < 100; attempt++) {
          const tree = await wire.send("Page.getFrameTree");
          if (!navigation.loaderId || tree.frameTree.frame.loaderId === navigation.loaderId) {
            const ready = await wire.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
            if (["interactive", "complete"].includes(ready.result.value)) return;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Browser navigation is still pending. Observe before retrying.");
      },
      update(target) { currentUrl = target.url; title = target.title; },
      close() { destroyed = true; wire.close(); },
    };
    wire.changed(() => { context = null; tab.webMcpRevision++; host.invalidate(tab.tabId); });
    void wire.send("Page.enable", {}, false).catch(() => {});
    return tab;
  }
  async function refresh() {
    if (!loaded) {
      try {
        const saved = JSON.parse(await readFile(statePath, "utf8"));
        if (Array.isArray(saved)) for (const pair of saved) if (Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === "string")) owners.set(pair[0], pair[1]);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      loaded = true;
    }
    const targets = await json("/json/list");
    const live = new Set();
    for (const target of targets) if (target.type === "page" && owners.has(target.id)) {
      live.add(target.id);
      if (!tabs.has(target.id)) tabs.set(target.id, makeTab(target));
      else tabs.get(target.id).update(target);
    }
    for (const [id, tab] of tabs) if (!live.has(id)) { host.invalidate(id, { closed: true }); tab.close(); tabs.delete(id); owners.delete(id); }
  }
  const host = createBrowserTaskHost({
    getTab: id => tabs.get(id), tabsFor: sessionId => [...tabs.values()].filter(tab => owners.get(tab.tabId) === sessionId),
    ownerOf: id => owners.get(id), activeFor: sessionId => [...owners].find(([id, owner]) => owner === sessionId && tabs.has(id))?.[0],
    // This browser is inside the member's full computer, alongside native input
    // and shell access. Local apps and private sites are intentionally reachable.
    // Network restrictions belong at the VM boundary, not solely in this tool.
    isVisible: () => true, enabled, allowed: async () => true, changed: () => {},
    beforeInput: (tab) => tab.view.webContents.prepareInput(),
    async openTab(url, sessionId, signal, admit) {
      if (tabs.size >= 12) throw new Error("Close a browser tab before opening another.");
      assertActive(); signal.throwIfAborted();
      const target = await json("/json/new?about:blank", "PUT");
      const tab = makeTab(target);
      owners.set(tab.tabId, sessionId); tabs.set(tab.tabId, tab);
      await persist();
      await admit(tab); signal.throwIfAborted(); assertActive();
      await tab.navigate(url);
      return tab;
    },
    navigate: (tab, url) => tab.navigate(url),
    siteTools: async () => ({ ok: true, tools: [] }), runSiteTool: async () => ({ ok: false, dispatched: false, code: "unsupported" }),
  });
  return {
    async request(input, options) { await refresh(); return host.request(input, options); },
    invalidate() { for (const id of tabs.keys()) host.invalidate(id); },
    pause() { for (const id of tabs.keys()) host.pause(id); },
    resume() { for (const id of tabs.keys()) host.resume(id); },
    close() { for (const tab of tabs.values()) tab.close(); tabs.clear(); },
  };
}
