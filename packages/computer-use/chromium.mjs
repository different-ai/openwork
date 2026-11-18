// Headed Chromium on the cloud computer. CDP stays on loopback; callers only
// get the existing conversation-owned browser contract, never arbitrary CDP.
import { readFile, writeFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { BrowserTaskError, createBrowserTaskHost } from "./browser-task.mjs";

/** How long open and navigate wait for a page to finish loading and stop changing before they report it still loading. */
const LOAD_SETTLE_MS = 8000;
/** How long Chromium may take to answer a navigation (it answers once the site responds). */
const NAVIGATE_TIMEOUT_MS = 30_000;
/** How long, after the site answered, navigate waits for the new document to be readable. */
const DOCUMENT_READY_MS = 10_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Chromium's net error for a failed navigation, as a coded error that says what to do next. Never the page's text. */
export function navigationError(errorText) {
  const reason = /^net::ERR_[A-Z0-9_]+$/.test(errorText) ? errorText : "net::ERR_FAILED";
  if (reason === "net::ERR_BLOCKED_BY_CLIENT") return new BrowserTaskError("website_blocked", "The cloud browser opens public websites only; this address is private or blocked.");
  if (reason === "net::ERR_NAME_NOT_RESOLVED") return new BrowserTaskError("navigation_failed", `The website's address could not be found (${reason}). Check the address.`);
  return new BrowserTaskError("navigation_failed", `The page did not load (${reason}). Check the address or try again; the tab stays open.`);
}
/** A script that was running in a document the page has since replaced, which is the page changing, not a broken browser. */
const DOCUMENT_GONE = /execution context was destroyed|cannot find (default )?(execution )?context|inspected target navigated|context with specified id|no frame (for|with) given id|frame.*(was detached|not found)/i;

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
    // A tab's connection that closed (Chromium restarted, the renderer crashed) never comes back; refresh() replaces it.
    let closed = false;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Browser connection timed out.")); }, 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); closed = true; reject(new Error("Browser connection failed.")); }, { once: true });
    });
    void ready.catch(() => {});
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) {
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
      closed = true;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Browser disconnected; inspect before retrying input.")); }
      pending.clear();
    });
    return {
      get closed() { return closed; },
      events(callback) { pageEvent = callback; },
      async send(method, params = {}, check = true, timeoutMs = 15_000) {
        await ready;
        if (check) assertActive();
        if (closed) throw new Error("Browser disconnected; inspect before retrying input.");
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("Browser receipt timed out; do not replay input."), { timedOut: true })); }, timeoutMs);
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
    // Navigations of the top document. Frames (ads, embeds, consent widgets) navigate all the time without changing the
    // document observations and refs describe, so they never count.
    let mainNavigations = 0;
    // Request id -> start time: browser tasks wait for requests an action started.
    const inFlight = new Map();
    const tab = { tabId: target.id, webMcpRevision: 0, inFlight, get disconnected() { return wire.closed; }, view: { webContents: {
      isDestroyed: () => destroyed,
      getURL: () => currentUrl,
      getTitle: () => title,
      stop: () => { void wire.send("Page.stopLoading", {}, false).catch(() => {}); },
      async prepareInput() { await guarded; await beforeInput(); await wire.send("Page.bringToFront"); },
      async executeJavaScriptInIsolatedWorld(_world, scripts) {
        await guarded;
        assertActive();
        const revision = tab.webMcpRevision;
        let result;
        try {
          if (context === null) {
            const tree = await wire.send("Page.getFrameTree");
            context = (await wire.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "openwork-browser" })).executionContextId;
          }
          // A navigation can complete while the old world's creation receipt is in flight.
          if (revision !== tab.webMcpRevision) throw new BrowserTaskError("page_changed", "The page changed while preparing to read it. Observe again.");
          result = await wire.send("Runtime.evaluate", { expression: scripts[0].code, contextId: context, returnByValue: true, awaitPromise: true });
        } catch (error) {
          // Frame lookup, world creation and evaluation can all race a self-navigation. Normalize only known races.
          if (error?.code !== "page_changed" && !DOCUMENT_GONE.test(String(error?.message))) throw error;
          context = null;
          if (tab.webMcpRevision === revision) changed();
          throw new BrowserTaskError("page_changed", "The page changed while it was read. Observe again.");
        }
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
      /**
       * Loads `url` and waits until the new document can be read. A site that reloads or redirects itself while loading
       * (YouTube adds ?themeRefresh=1 on a first visit) counts as loaded once its newest document is readable. A page
       * that is still loading after that is not a failure: the host waits for it to settle and says so.
       */
      async navigate(url) {
        await guarded;
        await beforeInput();
        await wire.send("Page.bringToFront");
        const before = mainNavigations;
        let navigation;
        try { navigation = await wire.send("Page.navigate", { url }, true, NAVIGATE_TIMEOUT_MS); }
        catch (error) {
          if (error?.timedOut) throw new BrowserTaskError("navigation_timeout", "The website did not answer within 30 seconds. Observe the tab to see whether it loaded before trying again.");
          throw error;
        }
        if (navigation.errorText && !(navigation.errorText === "net::ERR_ABORTED" && mainNavigations > before)) throw navigationError(navigation.errorText);
        if (mainNavigations === before) currentUrl = url;
        changed();
        const deadline = Date.now() + DOCUMENT_READY_MS;
        while (Date.now() < deadline) {
          try {
            const tree = await wire.send("Page.getFrameTree", {}, true, Math.max(1, deadline - Date.now()));
            if (mainNavigations > before || !navigation.loaderId || tree.frameTree.frame.loaderId === navigation.loaderId) {
              const ready = await wire.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, true, Math.max(1, deadline - Date.now()));
              if (["interactive", "complete"].includes(ready.result?.value)) return;
            }
          } catch (error) {
            // Expiring this readiness budget is not a failed navigation. The host next checks whether it settled.
            if (error?.timedOut) break;
            // Between two documents there is briefly nothing to ask; anything else is a real failure.
            if (wire.closed || !DOCUMENT_GONE.test(String(error?.message))) throw error;
          }
          await delay(Math.min(100, Math.max(0, deadline - Date.now())));
        }
      },
      update(target) { currentUrl = target.url; title = target.title; },
      close() { destroyed = true; wire.close(); },
    };
    function changed() { context = null; tab.webMcpRevision++; host.invalidate(tab.tabId); }
    // In-flight requests feed the settle wait after an action.
    wire.events((method, params) => {
      if (method === "Page.frameNavigated") {
        if (params.frame?.parentId) return;
        mainNavigations++;
        if (typeof params.frame?.url === "string") currentUrl = `${params.frame.url}${params.frame.urlFragment ?? ""}`;
        return changed();
      }
      if (method === "Runtime.executionContextsCleared") return changed();
      // Only the world observations run in matters; a frame's contexts come and go with the frame.
      if (method === "Runtime.executionContextDestroyed") { if (context !== null && params.executionContextId === context) changed(); return; }
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
  // Page targets in the order Chromium lists them: the tab most recently in front first.
  let order = [];
  async function refresh(claim, recovery) {
    if (!loaded) {
      try {
        const saved = JSON.parse(await readFile(statePath, "utf8"));
        if (Array.isArray(saved)) for (const pair of saved) if (Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === "string")) owners.set(pair[0], pair[1]);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      loaded = true;
    }
    const targets = await json("/json/list");
    // A tab the person opened belongs to no conversation until one names it, as Workbot does with the tab in front of
    // its Browser view when they send a message from there.
    if (claim && !owners.has(claim.tabId) && targets.some(target => target.type === "page" && target.id === claim.tabId)) {
      owners.set(claim.tabId, claim.sessionId);
      await persist();
    }
    order = targets.flatMap(target => target.type === "page" ? [target.id] : []);
    const live = new Set();
    for (const target of targets) if (target.type === "page" && owners.has(target.id)) {
      live.add(target.id);
      const known = tabs.get(target.id);
      if (recovery && known?.disconnected) {
        // The page is still there but our connection to it is not: reconnect instead of failing every operation on it.
        host.invalidate(target.id); known.close(); tabs.set(target.id, makeTab(target));
      } else if (!known) tabs.set(target.id, makeTab(target));
      else known.update(target);
    }
    for (const [id, tab] of tabs) if (!live.has(id)) { host.invalidate(id, { closed: true }); tab.close(); tabs.delete(id); owners.delete(id); }
  }
  const host = createBrowserTaskHost({
    getTab: id => tabs.get(id), tabsFor: sessionId => [...tabs.values()].filter(tab => owners.get(tab.tabId) === sessionId),
    // A conversation's active tab is the one of its tabs most recently in front, which is the one the person sees.
    ownerOf: id => owners.get(id), activeFor: sessionId => order.find(id => owners.get(id) === sessionId && tabs.has(id)),
    // Prompt-injected pages must not steer the agent to this VM's worker, other
    // private hosts or cloud metadata. The VM firewall backs this up for pages
    // the person opens themselves and for redirects.
    isVisible: () => true, enabled, allowed: allowedDestination, changed: () => {},
    beforeInput: (tab) => tab.view.webContents.prepareInput(),
    async openTab(url, sessionId, signal, admit) {
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
    // Open and navigate return a page the agent can read, and reads wait out a page that is still changing.
    loadSettleMs: LOAD_SETTLE_MS,
    // The guest log keeps unexpected failures; the page's text and addresses never go there.
    onFailure: (failure) => console.warn(`[cloud-browser] ${JSON.stringify(failure)}`),
  });
  return {
    async request(input, options) {
      await verifyEgress();
      const tabId = input?.args?.tabId, sessionId = input?.sessionId;
      await refresh(typeof tabId === "string" && typeof sessionId === "string" && sessionId.trim() ? { tabId, sessionId } : null, options?.recovery === true);
      return host.request(input, options);
    },
    invalidate() { for (const id of tabs.keys()) host.invalidate(id); },
    pause() { for (const id of tabs.keys()) host.pause(id); },
    resume() { for (const id of tabs.keys()) host.resume(id); },
    close() { for (const tab of tabs.values()) tab.close(); tabs.clear(); },
  };
}
