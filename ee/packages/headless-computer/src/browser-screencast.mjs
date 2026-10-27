/**
 * Streams the browser's front tab to one viewer with Chromium's screencast instead of remote-desktop video. Chromium
 * sends a JPEG only when the page changes, and the next one only after the viewer acknowledges the last, so a slow
 * connection gets fewer frames instead of a growing backlog.
 *
 * To the viewer: binary messages are JPEG frames; text messages are JSON. `{ type: "page", id, url, title, loading,
 * back, forward, tabs }` whenever the front tab, its address, its loading state, its history, or the open tabs change.
 * `tabs` lists every open tab `{ id, url, title }` in the order they opened, so the viewer can draw a tab strip that
 * doesn't reshuffle as tabs come to the front. `{ type: "clipboard", text }` answers a copy.
 *
 * From the viewer: the text "ack" after each drawn frame, and `{ type: "tab", action: "activate" | "close", id }` for
 * one of those tabs. With `control` (the person took control) also pointer, wheel, key and text input for the front
 * tab, with positions as fractions of the frame; `{ type: "navigate", url }` and `{ type: "history", action: "back" |
 * "forward" | "reload" }` for the front tab; `{ type: "tab", action: "new" }`; and `{ type: "copy" }` for the text
 * selected on the page. Anything else ends the stream. The viewer never reaches Chromium's debugging protocol itself:
 * the guest checks each message and sends only these commands.
 */
// Tab ids in the order they first appeared, per browser. Chromium's own list reorders on every switch, and each viewer
// connection lasts a minute, so the order lives here to keep tabs in their places across connections.
const tabOrders = new Map();

export function streamBrowser(viewer, { endpoint = "http://127.0.0.1:9222", control = false, pollMs = 1000, quality = 70, maxWidth = 1600, maxHeight = 1200, onClose = () => {} } = {}) {
  let closed = false;
  let tab = null;
  let page = null;
  // The latest tab list: the front tab, and every page target.
  let latest = null;
  // The front tab's viewport in CSS pixels, from the latest frame, to place input given as fractions of the frame.
  let viewport = null;
  // Frames sent but not yet drawn, oldest first. Chromium holds back new frames while too many are outstanding.
  let unacknowledged = [];
  let timer;
  let polling = false;
  let pollAgain = false;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    tab?.socket.close();
    onClose();
  };

  const deliver = (message) => { if (viewer.readyState === 1) viewer.send(message); };

  const publish = () => {
    if (!latest || closed) return;
    const { front, targets } = latest;
    const ids = new Set(targets.map((entry) => entry.id));
    const known = tabOrders.get(endpoint) ?? [];
    // New tabs join at the end, in the order Chromium lists them: least recently used first, as they were opened.
    const opened = [...known.filter((id) => ids.has(id)), ...targets.map((entry) => entry.id).filter((id) => !known.includes(id)).reverse()];
    tabOrders.set(endpoint, opened);
    const byId = new Map(targets.map((entry) => [entry.id, entry]));
    const tabs = opened.map((id) => { const { url, title } = byId.get(id); return { id, url, title }; });
    // The attached tab reports its own address first; the list catches up within a poll.
    const own = tab?.id === front.id ? tab : null;
    const next = JSON.stringify({ type: "page", id: front.id, url: own?.url ?? front.url, title: front.title, loading: own?.loading ?? false, back: own?.back ?? false, forward: own?.forward ?? false, tabs });
    if (page === next) return;
    page = next;
    deliver(next);
  };

  const attach = (target) => {
    // Chromium may report its host in this URL. Never follow a remote endpoint.
    const address = new URL(target.webSocketDebuggerUrl);
    if (address.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(address.hostname) || address.port !== new URL(endpoint).port) throw new Error("Invalid Chromium endpoint.");
    const socket = new WebSocket(address);
    let sequence = 0;
    const pending = new Map();
    const send = (method, params = {}) => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: ++sequence, method, params })); };
    /** Sends a command and resolves with its result, or with null when it fails or the tab goes away. */
    const call = (method, params = {}) => new Promise((resolve) => {
      if (socket.readyState !== 1) return resolve(null);
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); resolve(null); }, 5000);
      pending.set(id, (result) => { clearTimeout(timeout); resolve(result); });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const current = { id: target.id, socket, send, call, url: undefined, loading: false, back: false, forward: false };
    // Whether the tab can go back or forward, for the toolbar's arrows.
    const refreshHistory = async () => {
      const result = await call("Page.getNavigationHistory");
      if (!Array.isArray(result?.entries) || tab !== current) return;
      current.back = result.currentIndex > 0;
      current.forward = result.currentIndex < result.entries.length - 1;
      current.url = result.entries[result.currentIndex]?.url ?? current.url;
      publish();
    };
    socket.addEventListener("open", () => {
      send("Page.enable");
      send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 });
      void refreshHistory();
    });
    socket.addEventListener("message", (event) => {
      if (tab !== current || closed) return;
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== undefined) {
        // A reply: settle the call that sent it, if this stream sent one with that id.
        const settle = typeof message.id === "number" ? pending.get(message.id) : undefined;
        if (typeof settle === "function") { pending.delete(message.id); settle(message.error ? null : message.result); }
        return;
      }
      // A page target's main frame shares the target's id.
      const main = message.params?.frameId === current.id || message.params?.frame?.id === current.id;
      if (message.method === "Page.frameStartedLoading" && main) { current.loading = true; publish(); return; }
      if (message.method === "Page.frameStoppedLoading" && main) { current.loading = false; publish(); return; }
      if ((message.method === "Page.frameNavigated" && main) || (message.method === "Page.navigatedWithinDocument" && main)) { void refreshHistory(); return; }
      if (message.method !== "Page.screencastFrame") return;
      const { data, sessionId, metadata } = message.params;
      if (metadata?.deviceWidth > 0 && metadata?.deviceHeight > 0) viewport = { width: metadata.deviceWidth, height: metadata.deviceHeight };
      unacknowledged.push({ sessionId, send });
      deliver(Buffer.from(data, "base64"));
    });
    // The tab closing is picked up by the next poll; only the viewer's socket ends the stream.
    socket.addEventListener("close", () => {
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      if (tab === current) tab = null;
    });
    socket.addEventListener("error", () => socket.close());
    return current;
  };

  const poll = async () => {
    if (closed) return;
    polling = true;
    pollAgain = false;
    try {
      const response = await fetch(`${endpoint}/json/list`, { redirect: "error", signal: AbortSignal.timeout(5000) });
      // Chromium lists page targets most recently activated first, so the first one is the tab in front.
      const targets = response.ok ? (await response.json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl) : [];
      const front = targets[0];
      if (closed) return;
      if (front && tab?.id !== front.id) {
        tab?.socket.close();
        unacknowledged = [];
        viewport = null;
        tab = attach(front);
      }
      if (front) { latest = { front, targets }; publish(); }
    } catch {
      // A browser restart or a slow list leaves the last frame up; the next poll reattaches.
    } finally {
      polling = false;
    }
    if (!closed) timer = setTimeout(poll, pollAgain ? 0 : pollMs);
  };
  // After a tab command, show the result now instead of at the next poll. One poll runs at a time.
  const pollSoon = () => {
    if (polling) { pollAgain = true; return; }
    clearTimeout(timer);
    timer = setTimeout(poll, 50);
  };

  const browserCommand = async (path, method = "GET") => {
    try {
      const response = await fetch(`${endpoint}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
    } catch {
      // The next poll shows whatever the browser has.
    }
    if (!closed) pollSoon();
  };

  const input = (message) => {
    const at = (x, y) => ({ x: x * viewport.width, y: y * viewport.height });
    if (message.type === "mouse") {
      const { x, y } = at(message.x, message.y);
      tab.send("Input.dispatchMouseEvent", { type: { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" }[message.event], x, y, button: message.button, buttons: message.buttons, clickCount: message.clickCount, modifiers: message.modifiers });
    } else if (message.type === "wheel") {
      const { x, y } = at(message.x, message.y);
      tab.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers: message.modifiers });
    } else if (message.type === "key") {
      // A key that types sends its text with keyDown; editing and navigation keys need rawKeyDown with their key code.
      const type = message.event === "up" ? "keyUp" : message.text ? "keyDown" : "rawKeyDown";
      tab.send("Input.dispatchKeyEvent", { type, key: message.key, code: message.code, windowsVirtualKeyCode: message.keyCode, nativeVirtualKeyCode: message.keyCode, modifiers: message.modifiers, ...(type === "keyDown" ? { text: message.text, unmodifiedText: message.text } : {}) });
    } else if (message.type === "text") {
      tab.send("Input.insertText", { text: message.text });
    }
  };

  const copy = async (target) => {
    const result = await target.call("Runtime.evaluate", { expression: SELECTED_TEXT, returnByValue: true });
    const text = result?.result?.value;
    if (typeof text === "string" && text && !closed) deliver(JSON.stringify({ type: "clipboard", text: text.slice(0, 100_000) }));
  };

  const history = async (target, action) => {
    if (action === "reload") return target.send("Page.reload");
    const result = await target.call("Page.getNavigationHistory");
    const entry = Array.isArray(result?.entries) ? result.entries[result.currentIndex + (action === "back" ? -1 : 1)] : undefined;
    if (entry) target.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  };

  const receive = (data) => {
    const text = String(data);
    if (text === "ack") {
      const frame = unacknowledged.shift();
      frame?.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
      return true;
    }
    let message;
    try { message = JSON.parse(text); } catch { return false; }
    if (message?.type === "tab" && message.action !== "new") {
      const opened = tabOrders.get(endpoint) ?? [];
      if (Object.keys(message).length !== 3 || !["activate", "close"].includes(message.action) || !opened.includes(message.id)) return false;
      // Closing the last tab would quit the browser, so keep it.
      if (message.action === "close" && opened.length <= 1) return true;
      void browserCommand(`/json/${message.action}/${message.id}`);
      return true;
    }
    if (!control || !validControl(message)) return false;
    if (message.type === "tab") { void browserCommand("/json/new?about:blank", "PUT"); return true; }
    // Input before the first frame has nowhere to land; drop it rather than end the session.
    if (!tab || tab.socket.readyState !== 1) return true;
    if (message.type === "navigate") tab.send("Page.navigate", { url: message.url });
    else if (message.type === "history") void history(tab, message.action);
    else if (message.type === "copy") void copy(tab);
    else if (viewport) input(message);
    return true;
  };

  viewer.on("message", (data, binary) => {
    if (binary || !receive(data)) close();
  });
  viewer.on("close", close);
  viewer.on("error", close);
  void poll();
  return close;
}

/** The text selected on the page, including inside a text field, but never from a password field. */
const SELECTED_TEXT = `(() => {
  const field = document.activeElement;
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    if (field.type === "password" || typeof field.selectionStart !== "number") return "";
    return field.value.slice(field.selectionStart, field.selectionEnd);
  }
  return String(getSelection() ?? "");
})()`;

const fraction = (value) => typeof value === "number" && value >= 0 && value <= 1;
const count = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const delta = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000;
const name = (value) => typeof value === "string" && value.length <= 32;
const webAddress = (value) => {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; }
};

/** True for what the person may send while they have control: exactly these shapes, nothing passed through. */
function validControl(message) {
  if (!message || typeof message !== "object") return false;
  const keys = Object.keys(message).sort().join();
  if (message.type === "mouse") {
    return keys === "button,buttons,clickCount,event,modifiers,type,x,y" && ["down", "up", "move"].includes(message.event) && fraction(message.x) && fraction(message.y)
      && ["none", "left", "middle", "right", "back", "forward"].includes(message.button) && count(message.buttons, 31) && count(message.clickCount, 3) && count(message.modifiers, 15);
  }
  if (message.type === "wheel") return keys === "deltaX,deltaY,modifiers,type,x,y" && fraction(message.x) && fraction(message.y) && delta(message.deltaX) && delta(message.deltaY) && count(message.modifiers, 15);
  if (message.type === "key") {
    return keys === "code,event,key,keyCode,modifiers,text,type" && ["down", "up"].includes(message.event) && name(message.key) && name(message.code)
      && count(message.keyCode, 255) && count(message.modifiers, 15) && typeof message.text === "string" && message.text.length <= 4;
  }
  if (message.type === "text") return keys === "text,type" && typeof message.text === "string" && message.text.length > 0 && message.text.length <= 10_000;
  // Only web addresses: never file:, javascript:, data: or the browser's own pages.
  if (message.type === "navigate") return keys === "type,url" && webAddress(message.url);
  if (message.type === "history") return keys === "action,type" && ["back", "forward", "reload"].includes(message.action);
  if (message.type === "tab") return keys === "action,type" && message.action === "new";
  if (message.type === "copy") return keys === "type";
  return false;
}
