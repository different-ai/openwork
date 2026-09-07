// The browser host owns task identity, consent, observations and dispatch.
// No model-specific API, arbitrary script execution, cookies or raw CDP surface.
import { createHash, randomUUID } from "node:crypto";

const WORLD = 1001;
const MAX_OPERATION_MS = 30_000;
const OBSERVATION_MS = 15_000;
const TRUST = "untrusted-site-content";

export class BrowserTaskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new BrowserTaskError(code, message); };
export function browserTaskUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("invalid_url", "Use a complete HTTP or HTTPS website address."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    fail("invalid_url", "Use HTTP or HTTPS without credentials in the address.");
  }
  return url;
}
function safeUrl(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return ""; }
}

// Runs in Electron's isolated world. It has DOM access but no page globals,
// Node, IPC, browser profile or network tools. References never enter page DOM.
function observePage(id) {
  const key = "__openworkBrowserObservation";
  globalThis[key]?.observer?.disconnect();
  const nodes = new Map();
  const elements = [];
  const candidates = document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]');
  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;
    if (elements.length >= 200) break;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") continue;
    const ref = `e${elements.length + 1}`;
    const password = element.matches('input[type="password"],input[autocomplete="one-time-code"]');
    const label = element.getAttribute("aria-label") || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.labels?.[0]?.innerText : "") || element.innerText || element.getAttribute("placeholder") || element.getAttribute("name") || "";
    nodes.set(ref, element);
    elements.push({ ref, tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), name: label.trim().slice(0, 200), disabled: element.hasAttribute("disabled"), sensitive: password, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }
  const observation = { id, nodes, changed: false, observer: null, width: innerWidth, height: innerHeight, x: scrollX, y: scrollY };
  observation.observer = new MutationObserver(() => { observation.changed = true; });
  observation.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  globalThis[key] = observation;
  return { title: document.title.slice(0, 300), text: (document.body?.innerText || "").slice(0, 16000), elements,
    viewport: { width: innerWidth, height: innerHeight }, hasPasswordField: [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')].some((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }),
    webmcp: "modelContext" in document ? "available" : "check_site_tools",
    limitations: ["DOM references cover the top document and open controls; use a fresh image for frames or canvas."] };
}
function prepareAction(id, action) {
  const state = globalThis.__openworkBrowserObservation;
  if (!state || state.id !== id || state.changed || state.width !== innerWidth || state.height !== innerHeight || state.x !== scrollX || state.y !== scrollY) throw new Error("stale_observation");
  const element = action.ref ? state.nodes.get(action.ref) : null;
  if (action.ref && (!element || !element.isConnected)) throw new Error("stale_element");
  if (element?.matches('input[type="password"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  if (element?.disabled || element?.getAttribute("aria-disabled") === "true") throw new Error("element_disabled");
  if (action.type === "key" && document.activeElement?.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  let x = action.x, y = action.y;
  if (element) {
    const rect = element.getBoundingClientRect();
    x = rect.x + rect.width / 2; y = rect.y + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error("element_outside_viewport");
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) throw new Error("element_obscured");
  }
  if (action.type === "fill") {
    const editable = element instanceof HTMLTextAreaElement || element?.isContentEditable || (element instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "number"].includes(element.type));
    if (!editable || element.readOnly) throw new Error("not_editable");
  }
  if ((action.type === "click" || action.type === "scroll") && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) throw new Error("outside_viewport");
  if (!element && action.type === "click") {
    const hit = document.elementFromPoint(x, y);
    if (hit?.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  }
  // Consume before input; a result read failure must never replay this action.
  state.changed = true;
  state.observer.disconnect();
  if (action.type === "fill") {
    element.focus();
    if (document.activeElement !== element) throw new Error("stale_element");
    if (element.isContentEditable) document.getSelection()?.selectAllChildren(element);
    else element.select();
    if (document.activeElement !== element || !element.isConnected) throw new Error("stale_element");
  }
  return { x, y };
}
async function captureObservation(webContents, viewport) {
  const capture = await webContents.capturePage();
  return capture.resize({ width: viewport.width, height: viewport.height }).toPNG({ scaleFactor: 1 });
}
function imageDigest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function isolated(webContents, fn, ...args) {
  return webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${fn.toString()})(...${JSON.stringify(args)})` }]);
}

export function createBrowserTaskHost({ getTab, tabsFor, ownerOf, activeFor, isVisible, openTab, navigate,
  allowed, enabled, confirm, changed, siteTools, runSiteTool }) {
  const states = new Map();
  const grants = new Map();
  const pausedSessions = new Set();
  const opening = new Map();
  function stateFor(tabId) {
    if (!states.has(tabId)) states.set(tabId, { status: "idle", operation: null, observation: null, controller: null });
    return states.get(tabId);
  }
  function publish(tabId, status, operation = null) {
    const state = stateFor(tabId); state.status = status; state.operation = operation;
    changed(tabId, { status, operation });
  }
  async function resolve(sessionId, tabId, allowBlocked = false) {
    if (typeof sessionId !== "string" || !sessionId.trim()) fail("missing_session", "Browser control requires a requesting conversation.");
    const id = tabId || activeFor(sessionId);
    const tab = id && getTab(id);
    if (!tab || tab.view.webContents.isDestroyed()) fail("tab_closed", "This conversation has no live browser tab. List tabs or open a website.");
    if (ownerOf(id) !== sessionId) fail("wrong_conversation", "That tab belongs to another conversation. Select one of this conversation's tabs.");
    const url = tab.view.webContents.getURL();
    if (!allowBlocked && !await allowed(url)) fail("website_blocked", "Your organization does not allow this website.");
    if (tab.view.webContents.isDestroyed() || url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed while checking policy. Observe again.");
    return tab;
  }
  async function access(sessionId, tab, signal) {
    const url = browserTaskUrl(tab.view.webContents.getURL());
    const key = `${sessionId}:${url.origin}`;
    if (grants.has(key)) return;
    if (!isVisible(tab.tabId)) fail("needs_attention", "Select this tab in its conversation's browser panel to review website access, then retry.");
    publish(tab.tabId, "needs_attention", "Website access");
    const accepted = await confirm({ tabId: tab.tabId, title: "Allow website access?", message: `Allow this conversation to read ${url.origin}?`, detail: "It can read pages and site tool descriptions using the built-in browser's signed-in account. Website content is untrusted. Actions that change the page require separate approval.", signal });
    signal.throwIfAborted();
    if (!accepted) fail("user_denied", "Website access was not allowed.");
    if (!await allowed(url.href) || tab.view.webContents.getURL() !== url.href) fail("page_changed", "The page changed or access was blocked while approval was pending. Observe the current page.");
    signal.throwIfAborted();
    grants.set(key, true);
  }
  function pause(tabId, reason = "Paused by you") {
    const owner = ownerOf(tabId);
    if (owner) { pausedSessions.add(owner); opening.get(owner)?.abort(new BrowserTaskError("paused", "The user has taken over this browser conversation.")); }
    for (const item of tabsFor(owner)) { const sibling = states.get(item.tabId); sibling?.controller?.abort(); if (sibling) sibling.observation = null; publish(item.tabId, "paused", reason); }
    const state = stateFor(tabId); state.observation = null;
    state.controller?.abort(new BrowserTaskError("paused", "Browser control paused. The user must resume it in the browser panel."));
    publish(tabId, "paused", reason);
  }
  function resume(tabId) {
    const owner = ownerOf(tabId);
    if (tabsFor(owner).some((item) => stateFor(item.tabId).controller)) return;
    pausedSessions.delete(owner);
    for (const item of tabsFor(owner)) { stateFor(item.tabId).observation = null; publish(item.tabId, "idle"); }
  }
  function invalidate(tabId, { closed = false } = {}) {
    const state = states.get(tabId); if (!state) return;
    state.observation = null;
    if (closed) { state.controller?.abort(); states.delete(tabId); }
  }
  async function observe(tab, includeImage, signal) {
    const state = stateFor(tab.tabId);
    state.observation = null;
    const revision = tab.webMcpRevision;
    const url = tab.view.webContents.getURL();
    const id = randomUUID();
    const page = await isolated(tab.view.webContents, observePage, id);
    let image, digest;
    if (includeImage) {
      if (page.hasPasswordField) fail("sign_in_required", "This page needs sign-in. Take over and sign in directly in the browser, then resume.");
      const png = await captureObservation(tab.view.webContents, page.viewport);
      digest = imageDigest(png);
      image = { mimeType: "image/png", data: png.toString("base64"), width: page.viewport.width, height: page.viewport.height };
    }
    if (!await allowed(url)) fail("website_blocked", "Your organization does not allow this website.");
    if (revision !== tab.webMcpRevision || url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed during observation. Observe again.");
    signal.throwIfAborted();
    state.observation = { id, at: Date.now(), revision, url, viewport: page.viewport, elements: page.elements, digest };
    return { ok: true, tabId: tab.tabId, observationId: id, url: safeUrl(url), trust: TRUST, ...page, ...(image ? { image } : {}) };
  }
  /**
   * @param {{ sessionId?: string, operation?: string, args?: { tabId?: string, url?: string, provider?: string, includeImage?: boolean, observationId?: string, toolId?: string, input?: unknown, action?: { type?: string, ref?: string, text?: string, key?: string, x?: number, y?: number, deltaY?: number } } }} request
   * @param {{ signal?: AbortSignal }} options
   */
  async function request({ sessionId, operation, args = {} } = {}, { signal } = {}) {
    let tab, state, dispatched = false, timer, abort, openingController;
    try {
      if (typeof sessionId !== "string" || !sessionId.trim()) fail("missing_session", "Browser control requires a requesting conversation.");
      if (!enabled()) fail("browser_disabled", "Enable OpenWork Browser in Library, or ask your organization to allow browser control.");
      if (operation === "tabs") return { ok: true, provider: "builtin", externalBrowsers: "unsupported", tabs: tabsFor(sessionId).map((item) => ({ tabId: item.tabId, url: safeUrl(item.view.webContents.getURL()), title: item.view.webContents.getTitle().slice(0, 300), visible: isVisible(item.tabId), ...stateFor(item.tabId), observation: undefined, controller: undefined })) };
      if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control. Resume in the browser panel before continuing.");
      if (operation === "open") {
        if (args.provider && !["builtin", "auto"].includes(args.provider)) fail("unsupported_browser", "External browser control is not connected. Use the built-in browser or open the requested external browser yourself.");
        const url = browserTaskUrl(args.url);
        if (opening.has(sessionId)) fail("busy", "A tab is already opening for this conversation. List tabs after it finishes.");
        openingController = new AbortController();
        opening.set(sessionId, openingController);
        abort = () => openingController.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        openingController.signal.throwIfAborted();
        const canceled = new Promise((_, reject) => openingController.signal.addEventListener("abort", () => reject(openingController.signal.reason), { once: true }));
        timer = setTimeout(() => openingController.abort(new BrowserTaskError("timeout", "Opening the page timed out. List tabs and inspect the existing page before retrying.")), MAX_OPERATION_MS);
        if (!await Promise.race([allowed(url.href), canceled])) fail("website_blocked", "Your organization does not allow this website.");
        if (!enabled()) fail("browser_disabled", "Browser control was disabled while opening the page.");
        openingController.signal.throwIfAborted();
        const matches = tabsFor(sessionId).filter((item) => item.view.webContents.getURL() === url.href);
        tab = args.tabId ? await Promise.race([resolve(sessionId, args.tabId), canceled]) : matches[0];
        openingController.signal.throwIfAborted();
        if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control. Resume in the browser panel before continuing.");
        if (!tab) {
          dispatched = true;
          tab = await Promise.race([
            openTab(url.href, sessionId, openingController.signal),
            canceled,
          ]);
          openingController.signal.throwIfAborted();
        }
        else if (tab.view.webContents.getURL() !== url.href) fail("different_page", "Use navigate to change the selected tab's page.");
        return { ok: true, provider: "builtin", tabId: tab.tabId, url: safeUrl(tab.view.webContents.getURL()), visible: isVisible(tab.tabId), next: "observe" };
      }
      tab = await resolve(sessionId, args.tabId, ["navigate", "pause", "handoff"].includes(operation));
      state = stateFor(tab.tabId);
      if (operation === "pause" || operation === "handoff") { pause(tab.tabId, operation === "handoff" ? "Sign in or continue in the browser, then resume" : "Paused"); return { ok: true, status: "paused", tabId: tab.tabId, next: "user_resume" }; }
      if (pausedSessions.has(sessionId) || state.status === "paused") fail("paused", "The user has browser control. Resume in the browser panel before continuing.");
      if (state.controller) fail("busy", "A browser operation is already running in this tab. Wait for its result; do not queue another action.");
      const controller = new AbortController(); state.controller = controller;
      abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => controller.abort(new BrowserTaskError("timeout", "Browser operation timed out. Observe the page before deciding what remains.")), MAX_OPERATION_MS);
      const run = async () => {
        controller.signal.throwIfAborted();
        if (operation !== "navigate") await access(sessionId, tab, controller.signal);
        controller.signal.throwIfAborted();
        publish(tab.tabId, "running", operation);
        if (operation === "observe") return observe(tab, args.includeImage === true, controller.signal);
        if (operation === "site_tools") return siteTools({ tabId: tab.tabId, sessionId });
        if (operation === "site_tool") {
          if (!isVisible(tab.tabId)) fail("needs_attention", "Select this tab in its conversation's browser panel to review its website action, then retry.");
          state.observation = null;
          dispatched = true;
          const result = await runSiteTool({ ...args, tabId: tab.tabId, sessionId }, { signal: controller.signal });
          dispatched = result.dispatched === true || result.mayHaveChangedState === true;
          return result;
        }
        if (operation === "navigate") {
          const url = browserTaskUrl(args.url);
          if (!await allowed(url.href)) fail("website_blocked", "Your organization does not allow this website.");
          controller.signal.throwIfAborted();
          state.observation = null; dispatched = true;
          const stop = () => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop(); };
          controller.signal.addEventListener("abort", stop, { once: true });
          try { await navigate(tab, url.href); controller.signal.throwIfAborted(); }
          finally { controller.signal.removeEventListener("abort", stop); }
          return { ok: true, tabId: tab.tabId, dispatched: true, outcome: "navigation_finished", url: safeUrl(tab.view.webContents.getURL()), next: "observe" };
        }
        if (operation !== "act") fail("unknown_operation", "Use a supported browser operation.");
        const observed = state.observation;
        if (!observed || observed.id !== args.observationId || Date.now() - observed.at > OBSERVATION_MS || observed.revision !== tab.webMcpRevision || observed.url !== tab.view.webContents.getURL()) fail("stale_observation", "Observe the current page before acting.");
        const action = args.action;
        if (!action || !["click", "fill", "key", "scroll"].includes(action.type)) fail("invalid_action", "Use click, fill, key or scroll.");
        if (action.type === "click" && !action.ref && !observed.digest) fail("image_required", "Observe with includeImage before clicking image coordinates.");
        if (action.type === "fill" && (typeof action.text !== "string" || action.text.length > 8000 || !action.ref)) fail("invalid_action", "Fill needs an observed editable reference and text of at most 8000 characters.");
        const keys = { Enter: "Enter", Tab: "Tab", Escape: "Escape", ArrowDown: "Down", ArrowUp: "Up", ArrowLeft: "Left", ArrowRight: "Right", Backspace: "Backspace", Space: "Space" };
        if (action.type === "key" && !Object.hasOwn(keys, action.key)) fail("invalid_key", "Use Enter, Tab, Escape, arrows, Backspace or Space. System shortcuts are unavailable.");
        if (action.type === "scroll" && (!Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 1200)) fail("invalid_scroll", "Scroll distance must be between -1200 and 1200.");
        if (!isVisible(tab.tabId)) fail("needs_attention", "Select this tab in its conversation's browser panel, then retry from a fresh observation.");
        publish(tab.tabId, "needs_attention", `Approve ${action.type}`);
        const accepted = await confirm({ tabId: tab.tabId, title: "Allow browser action?", message: `Allow ${action.type} on ${new URL(observed.url).origin}?`, detail: `Target: ${observed.elements.find((item) => item.ref === action.ref)?.name || (action.key ? `key ${action.key}` : `position ${action.x}, ${action.y}`)}.${action.type === "fill" ? ` Text to enter: ${action.text}` : ""} This can submit information or change website data. Review your requested task before allowing it.`, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!accepted) fail("user_denied", "The browser action was not allowed.");
        if (!await allowed(observed.url) || observed.revision !== tab.webMcpRevision || observed.url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed or access was blocked while approval was pending. Observe again.");
        controller.signal.throwIfAborted();
        if (Date.now() - observed.at > OBSERVATION_MS) fail("stale_observation", "The observation expired while approval was pending. Observe again.");
        if (action.type === "click" && !action.ref && imageDigest(await captureObservation(tab.view.webContents, observed.viewport)) !== observed.digest) fail("stale_observation", "The image changed. Observe again before choosing coordinates.");
        let point;
        try { point = await isolated(tab.view.webContents, prepareAction, observed.id, action); }
        catch (error) {
          const code = ["stale_observation", "stale_element", "sign_in_required", "element_disabled", "element_outside_viewport", "element_obscured", "not_editable", "outside_viewport"].find((item) => String(error?.message).includes(item));
          if (code) fail(code, code === "sign_in_required" ? "Take over and sign in directly in the browser, then resume." : "The observed control is no longer ready. Observe again before choosing an action.");
          throw error;
        }
        state.observation = null; controller.signal.throwIfAborted();
        if (!isVisible(tab.tabId)) fail("needs_attention", "The tab is no longer visible. Select it and observe again before acting.");
        publish(tab.tabId, "running", action.type);
        const contents = tab.view.webContents;
        dispatched = true;
        if (action.type === "fill") await contents.insertText(action.text);
        if (action.type === "click") {
          // sendInputEvent targets the main widget, not an OOPIF's widget.
          // Chromium's input router hit-tests these already-approved CSS pixels.
          const cdp = contents.debugger;
          const attached = !cdp.isAttached();
          if (attached) cdp.attach("1.3");
          try {
            await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
            await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
          } finally {
            if (attached && cdp.isAttached()) cdp.detach();
          }
        }
        if (action.type === "key") { contents.sendInputEvent({ type: "keyDown", keyCode: keys[action.key] }); contents.sendInputEvent({ type: "keyUp", keyCode: keys[action.key] }); }
        if (action.type === "scroll") contents.sendInputEvent({ type: "mouseWheel", x: Math.round(point.x), y: Math.round(point.y), deltaY: action.deltaY, canScroll: true });
        return { ok: true, dispatched: true, outcome: "not_yet_verified", retrySafe: false, tabId: tab.tabId, next: "observe", message: "Observe the page and verify the requested outcome before reporting success." };
      };
      const result = await Promise.race([run(), new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }))]);
      controller.signal.throwIfAborted();
      if (state.status !== "paused") publish(tab.tabId, result.ok ? "idle" : "needs_attention", result.ok ? null : result.code);
      return result;
    } catch (error) {
      if (state) state.observation = null;
      if (tab && state?.status !== "paused") publish(tab.tabId, "needs_attention", error?.code || "Check browser");
      return { ok: false, code: error instanceof BrowserTaskError ? error.code : "browser_operation_failed", error: error instanceof BrowserTaskError ? error.message : "Browser operation could not finish. Observe the page or take over to continue.", dispatched, mayHaveChangedState: dispatched, retrySafe: false, next: dispatched ? "observe_before_retry" : "review", trust: TRUST };
    } finally {
      if (openingController && opening.get(sessionId) === openingController) opening.delete(sessionId);
      if (timer) clearTimeout(timer);
      if (signal && abort) signal.removeEventListener("abort", abort);
      if (state && abort) state.controller = null;
    }
  }
  return { request, pause, resume, invalidate, stateFor };
}
