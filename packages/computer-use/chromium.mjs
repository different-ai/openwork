// Headed Chromium on the cloud computer. CDP stays on loopback; callers only
// get the existing conversation-owned browser contract, never arbitrary CDP.
import { readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { createBrowserTaskHost } from "./browser-task.mjs";

// Loopback, private, shared, link-local (including cloud metadata) and unspecified ranges.
const IPV4_PRIVATE = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]];
const IPV6_PRIVATE = [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["fc00::", 7], ["fe80::", 10]];
const PRIVATE = new BlockList();
const PRIVATE_V6 = new BlockList();
for (const [network, prefix] of IPV4_PRIVATE) PRIVATE.addSubnet(network, prefix, "ipv4");
// IPv4 translation is unsupported: both standardized NAT64 prefixes can
// otherwise hide private IPv4 destinations from IPv6-only checks.
for (const [network, prefix] of IPV6_PRIVATE) PRIVATE_V6.addSubnet(network, prefix, "ipv6");
const privateAddress = (address) => {
  const family = isIP(address);
  return family === 4 ? PRIVATE.check(address, "ipv4") : family === 6 ? PRIVATE_V6.check(address, "ipv6") : true;
};

/** Agent-chosen pages may reach the public web only; the VM firewall enforces the same boundary. */
export async function publicDestination(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return url.href === "about:blank";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  if (isIP(host)) return !privateAddress(host);
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !privateAddress(address));
  } catch { return false; }
}

// DNS admission is defense in depth. Chromium resolves independently, so the
// per-browser-UID kernel filter must exist before any automation connects.
export const BROWSER_EGRESS_CHECK = `set -eu
uid=$(id -u openwork-browser)
[ "$uid" -ne 0 ]
iptables -w -C OUTPUT -m owner --uid-owner "$uid" -j OPENWORK_DESKTOP_EGRESS
${IPV4_PRIVATE.map(([network, prefix]) => `iptables -w -C OPENWORK_DESKTOP_EGRESS -d ${network}/${prefix} -j REJECT`).join("\n")}
if [ -e /proc/net/if_inet6 ]; then
  ip6tables -w -C OUTPUT -m owner --uid-owner "$uid" -j OPENWORK_DESKTOP_EGRESS
  ${IPV6_PRIVATE.map(([network, prefix]) => `ip6tables -w -C OPENWORK_DESKTOP_EGRESS -d ${network}/${prefix} -j REJECT`).join("\n  ")}
fi`;
/** The native guard must attach complete, UID-scoped reject rules to OUTPUT. */
export function nativeBrowserEgress(payload, uid) {
  if (!Number.isInteger(uid) || uid <= 0 || !Array.isArray(payload?.nftables)) return false;
  const entries = payload.nftables.filter(entry => entry && typeof entry === "object");
  if (!entries.some(({ chain }) => chain?.family === "inet" && chain.table === "openwork_desktop"
    && chain.name === "output" && chain.type === "filter" && chain.hook === "output")) return false;
  const address = (value, family) => {
    if (typeof value !== "string" || isIP(value) !== (family === "ip" ? 4 : 6)) return null;
    return family === "ip" ? value : new URL(`http://[${value}]`).hostname;
  };
  return [["ip", IPV4_PRIVATE], ["ip6", IPV6_PRIVATE]].every(([family, required]) => entries.some(({ rule }) => {
    if (rule?.family !== "inet" || rule.table !== "openwork_desktop" || rule.chain !== "output" || rule.expr?.length !== 3) return false;
    const [owner, destination, verdict] = rule.expr;
    if (owner?.match?.op !== "==" || owner.match.left?.meta?.key !== "skuid" || owner.match.right !== uid || !verdict?.reject) return false;
    const match = destination?.match;
    if (match?.op !== "==" || match.left?.payload?.protocol !== family || match.left.payload.field !== "daddr" || !Array.isArray(match.right?.set)) return false;
    return required.every(([network, prefix]) => match.right.set.some(item => item?.prefix?.len === prefix
      && address(item.prefix.addr, family) === address(network, family)));
  }));
}
const egressCommand = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
/** Authenticated helper diagnostics contain kernel policy metadata, never page contents. */
export async function browserEgressStatus(execute = egressCommand) {
  let backend = "unknown", stage = "detect";
  try {
    const native = await execute("/bin/sh", ["-c", "command -v nft"]).then(() => true, () => false);
    backend = native ? "nft" : "iptables";
    if (!native) { stage = "legacy"; await execute("/bin/sh", ["-c", BROWSER_EGRESS_CHECK]); return { ok: true, backend }; }
    stage = "uid";
    const uid = Number((await execute("id", ["-u", "openwork-browser"])).trim());
    stage = "query";
    const rules = JSON.parse(await execute("nft", ["-n", "-j", "list", "table", "inet", "openwork_desktop"]));
    stage = "validate";
    const entries = Array.isArray(rules?.nftables) ? rules.nftables.filter(entry => entry && typeof entry === "object") : [];
    return { ok: nativeBrowserEgress(rules, uid), backend, uid, stage,
      chains: entries.flatMap(entry => entry.chain ? [entry.chain] : []),
      rejects: entries.flatMap(entry => entry.rule?.expr?.some(expr => Object.hasOwn(expr, "reject")) ? [entry.rule] : []),
    };
  } catch { return { ok: false, backend, stage }; }
}
const verifyLocalEgress = async () => {
  if (!(await browserEgressStatus()).ok) throw Object.assign(new Error("The cloud browser's private-network filter is unavailable. Reconnect the computer."), { code: "egress_unavailable" });
};

export function createCloudBrowser({ statePath, assertActive, enabled, beforeInput, endpoint = "http://127.0.0.1:9222", privateBrowsing = false, verifyEgress = verifyLocalEgress }) {
  // privateBrowsing is only for operator diagnostics on a dedicated VM.
  const allowedDestination = privateBrowsing ? async () => true : publicDestination;
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
      if (!message.id) {
        if (["Page.frameNavigated", "Runtime.executionContextsCleared", "Runtime.executionContextDestroyed"].includes(message.method)) tabChanged();
        // Every network resource and redirect hop is checked before it loads.
        if (message.method === "Fetch.requestPaused") void admitRequest(message.params);
        else pageEvent(message.method, message.params ?? {});
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
    let tabChanged = () => {};
    const reply = (method, params) => { try { socket.send(JSON.stringify({ id: ++sequence, method, params })); } catch {} };
    async function admitRequest({ requestId, request }) {
      let allowed = false;
      try {
        const url = new URL(request.url);
        if (["ws:", "wss:"].includes(url.protocol)) url.protocol = url.protocol === "ws:" ? "http:" : "https:";
        allowed = ["http:", "https:"].includes(url.protocol) ? await allowedDestination(url.href)
          : ["about:", "data:", "blob:"].includes(url.protocol);
      } catch { allowed = false; }
      if (allowed) reply("Fetch.continueRequest", { requestId });
      else reply("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    }
    let pageEvent = (_method, _params) => {};
    socket.addEventListener("close", () => {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser disconnected; inspect before retrying input.")); }
      pending.clear();
    });
    return {
      changed(callback) { tabChanged = callback; },
      events(callback) { pageEvent = callback; },
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
    // Request id -> start time: browser tasks wait for requests an action started.
    const inFlight = new Map();
    const tab = { tabId: target.id, webMcpRevision: 0, inFlight, view: { webContents: {
      isDestroyed: () => destroyed,
      getURL: () => currentUrl,
      getTitle: () => title,
      stop: () => { void wire.send("Page.stopLoading", {}, false).catch(() => {}); },
      async prepareInput() { await guarded; await beforeInput(); await wire.send("Page.bringToFront"); },
      async executeJavaScriptInIsolatedWorld(_world, scripts) {
        await guarded;
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
        await guarded;
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
        const held = new Set(event.modifiers ?? []);
        const character = /^[A-Z0-9]$/.test(event.keyCode) ? event.keyCode : null;
        return wire.send("Input.dispatchKeyEvent", { type: event.type === "keyDown" ? "keyDown" : "keyUp",
          modifiers: (held.has("alt") ? 1 : 0) | (held.has("control") ? 2 : 0) | (held.has("meta") ? 4 : 0) | (held.has("shift") ? 8 : 0),
          key: character ? (held.has("shift") ? character : character.toLowerCase()) : { Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Space: " " }[event.keyCode] ?? event.keyCode,
          ...(character ? { code: /\d/.test(character) ? `Digit${character}` : `Key${character}` } : {}),
          windowsVirtualKeyCode: character ? character.charCodeAt(0) : { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34, Up: 38, Down: 40, Left: 37, Right: 39 }[event.keyCode] });
      },
      debugger: { isAttached: () => true, sendCommand: async (method, params) => { await beforeInput(); await wire.send("Page.bringToFront"); return wire.send(method, params); } },
    } },
      async navigate(url) {
        await guarded;
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
    // In-flight requests feed the settle wait after an action.
    wire.events((method, params) => {
      if (method === "Network.requestWillBeSent" && !["WebSocket", "EventSource"].includes(params.type) && !String(params.request?.url).startsWith("data:")) inFlight.set(params.requestId, Date.now());
      else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") inFlight.delete(params.requestId);
    });
    // Omitting resourceType covers images, scripts, fetches and other resources,
    // not just documents. Navigation and observation must wait for enforcement.
    const guarded = Promise.all([
      wire.send("Page.enable", {}, false),
      wire.send("Runtime.enable", {}, false),
      wire.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, false),
    ]);
    void guarded.catch(() => {});
    void wire.send("Network.enable", {}, false).catch(() => {});
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
    // Prompt-injected pages must not steer the agent to this VM's worker, other
    // private hosts or cloud metadata. The VM firewall backs this up for pages
    // the person opens themselves and for redirects.
    isVisible: () => true, enabled, allowed: allowedDestination, changed: () => {},
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
    inFlight: (tab, since) => [...tab.inFlight.values()].filter((started) => started >= since).length,
    siteTools: async () => ({ ok: true, tools: [] }), runSiteTool: async () => ({ ok: false, dispatched: false, code: "unsupported" }),
  });
  return {
    async request(input, options) { await verifyEgress(); await refresh(); return host.request(input, options); },
    invalidate() { for (const id of tabs.keys()) host.invalidate(id); },
    pause() { for (const id of tabs.keys()) host.pause(id); },
    resume() { for (const id of tabs.keys()) host.resume(id); },
    close() { for (const tab of tabs.values()) tab.close(); tabs.clear(); },
  };
}
