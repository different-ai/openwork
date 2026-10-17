// The browser host owns task identity, observations and dispatch.
// No model-specific API, arbitrary script execution, cookies or raw CDP surface.
import { createHash, randomUUID } from "node:crypto";

const WORLD = 1001;
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
function observePage(id, query = null) {
  const key = "__openworkBrowserObservation";
  const nodes = new Map();
  const elements = [];
  const describe = (element) => {
    const text = (value, limit = 200) => (value || "").trim().slice(0, limit);
    const referenced = (attribute) => (element.getAttribute(attribute) || "").split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || "").join(" ").trim();
    const labelText = (label) => {
      const copy = label.cloneNode(true);
      if (copy instanceof HTMLElement) for (const control of copy.querySelectorAll("input,textarea,select,button")) control.remove();
      return copy.textContent || "";
    };
    const input = element instanceof HTMLInputElement;
    const textarea = element instanceof HTMLTextAreaElement;
    const select = element instanceof HTMLSelectElement;
    const sensitive = element.matches('input[type="password"],input[autocomplete="one-time-code"]');
    const role = element.getAttribute("role");
    /** @type {{ tag: string, role: string | null, name: string, disabled: boolean, sensitive: boolean, required: boolean, readOnly: boolean,
     * type?: string, value?: string, valueTruncated?: boolean, checked?: boolean | "mixed", expanded?: boolean, selected?: boolean,
     * multiple?: boolean, options?: { value: string, label: string, selected: boolean, disabled: boolean }[], optionsTruncated?: boolean,
     * selectedValues?: string[], valid?: boolean, validationMessage?: string, description?: string }} */
    const state = {
      tag: element.tagName.toLowerCase(), role: role || (input ? ["checkbox", "radio"].includes(element.type) ? element.type : ["button", "submit", "reset"].includes(element.type) ? "button" : element.type === "search" ? "searchbox" : "textbox" :
        { BUTTON: "button", A: "link", TEXTAREA: "textbox", SELECT: "combobox", H1: "heading", H2: "heading", H3: "heading", H4: "heading", TR: "row", TABLE: "table" }[element.tagName]) ||
        (element.scrollHeight > element.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(element).overflowY) ? "region" : "text"),
      name: text(referenced("aria-labelledby") || element.getAttribute("aria-label") ||
        (input || textarea || select ? [...(element.labels || [])].map(labelText).join(" ") : "") ||
        (input && ["submit", "button", "reset"].includes(element.type) ? element.value : "") ||
        (!input && !textarea && !select ? element.innerText : "") || element.getAttribute("placeholder") || element.getAttribute("name")),
      disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || !!element.closest("[inert]"),
      sensitive,
      required: element.required === true || element.getAttribute("aria-required") === "true",
      readOnly: element.readOnly === true || element.getAttribute("aria-readonly") === "true",
    };
    if (input) state.type = element.type;
    if (!sensitive && (input || textarea || select || element.isContentEditable || ["textbox", "combobox"].includes(role))) {
      const value = input || textarea || select ? element.value : element.isContentEditable ? element.innerText : element.getAttribute("aria-valuetext") || element.textContent || "";
      state.value = value.slice(0, 8000); state.valueTruncated = value.length > 8000;
    }
    if (input && ["checkbox", "radio"].includes(element.type)) state.checked = element.indeterminate ? "mixed" : element.checked;
    else if (element.hasAttribute("aria-checked")) state.checked = element.getAttribute("aria-checked") === "mixed" ? "mixed" : element.getAttribute("aria-checked") === "true";
    if (element.hasAttribute("aria-expanded")) state.expanded = element.getAttribute("aria-expanded") === "true";
    if (element.hasAttribute("aria-selected")) state.selected = element.getAttribute("aria-selected") === "true";
    if (select) {
      state.multiple = element.multiple;
      state.options = [...element.options].slice(0, 200).map(option => ({ value: option.value, label: text(option.label),
        selected: option.selected, disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) }));
      state.optionsTruncated = element.options.length > 200;
      state.selectedValues = [...element.selectedOptions].map(option => option.value).slice(0, 200);
    }
    if (element.validity || element.hasAttribute("aria-invalid")) {
      state.valid = (element.validity?.valid ?? true) && !["true", "grammar", "spelling"].includes(element.getAttribute("aria-invalid"));
      state.validationMessage = sensitive ? "" : text(element.validationMessage || referenced("aria-errormessage"), 1000);
    }
    const description = referenced("aria-describedby");
    if (description && !sensitive) state.description = text(description, 1000);
    return state;
  };
  const candidates = document.querySelectorAll('a[href],button,input,textarea,select,[role],h1,h2,h3,h4,p,label,tr,table,main,aside,section,div,[contenteditable]:not([contenteditable="false"])');
  const scrollRegions = [];
  let scanned = 0, truncated = false;
  const snapshots = new Map();
  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;
    // An associated label already supplies the control's accessible name.
    // Returning it again makes ordinary name-based form targets ambiguous.
    if (element instanceof HTMLLabelElement && element.control) continue;
    if (++scanned > 6000 || elements.length >= 500) { truncated = true; break; }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility !== "visible" || style.display === "none") continue;
    const scrollable = element.scrollHeight > element.clientHeight + 4 && /auto|scroll/.test(style.overflowY);
    if (element.tagName === "DIV" && !element.hasAttribute("role") && !element.isContentEditable && !scrollable) continue;
    if (scrollable) scrollRegions.push([element.getAttribute("aria-label") || element.id, element.scrollTop, element.scrollHeight, element.clientHeight]);
    const ref = `e${elements.length + 1}`;
    const control = describe(element);
    if (query) {
      const match = (actual, expected) => !expected || (query.exact === false ? actual.toLowerCase().includes(expected.toLowerCase()) : actual.toLowerCase() === expected.toLowerCase());
      if (!match(control.role, query.role) || !match(control.name, query.name) || !match(control.name, query.text)) continue;
    }
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = element.parentElement; parent && right > left && bottom > top; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent), clip = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      if (/auto|scroll|hidden|clip/.test(parentStyle.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
    }
    nodes.set(ref, element);
    snapshots.set(element, JSON.stringify(control));
    elements.push({ ref, ...control, visible: right > left && bottom > top, needsReveal: left > rect.left || top > rect.top || right < rect.right || bottom < rect.bottom, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }
  const observation = { id, nodes, bounds: new Map(elements.map(({ ref, bounds }) => [ref, bounds])), activeElement: document.activeElement,
    used: false, createdAt: performance.now(), describe, snapshots, width: innerWidth, height: innerHeight, x: scrollX, y: scrollY };
  globalThis[key] = observation;
  return { truncated, scrollRegions, title: document.title.slice(0, 300), text: (document.body?.innerText || "").slice(0, 16000), elements,
    viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, hasPasswordField: [...document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')].some((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }),
    webmcp: "modelContext" in document ? "available" : "check_site_tools",
    limitations: ["DOM references cover the top document and open controls; use a fresh image for frames or canvas."] };
}
function prepareAction(id, action) {
  const state = globalThis.__openworkBrowserObservation;
  if (!state || state.id !== id || state.used || performance.now() - state.createdAt > 60_000 || state.width !== innerWidth || state.height !== innerHeight || state.x !== scrollX || state.y !== scrollY) throw new Error("stale_observation");
  const element = action.ref ? state.nodes.get(action.ref) : null;
  if (action.ref && (!element || !element.isConnected)) throw new Error("stale_element");
  if (element?.matches('input[type="password"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  if (element && state.describe(element).disabled) throw new Error("element_disabled");
  // Revalidate the chosen control rather than invalidating every control when
  // an unrelated spinner, clock or live region changes elsewhere on the page.
  const target = element || (action.type === "key" ? document.activeElement : null);
  if (target && state.snapshots.get(target) !== JSON.stringify(state.describe(target))) throw new Error("stale_observation");
  if (action.type === "key" && state.activeElement !== document.activeElement) throw new Error("stale_observation");
  if (action.type === "key" && document.activeElement?.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  // Only a directly focused, observed control can receive keys. Frames and
  // generic containers can conceal a different focused descendant.
  if (action.type === "key" && !document.activeElement?.matches('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="listbox"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"]')) throw new Error("unverifiable_focus");
  let x = action.x, y = action.y;
  if (element) {
    const rect = element.getBoundingClientRect();
    const bounds = state.bounds.get(action.ref);
    const style = getComputedStyle(element);
    if (!bounds || style.visibility !== "visible" || style.display === "none" || !["x", "y", "width", "height"].every((key) => rect[key] === bounds[key])) throw new Error("stale_observation");
    x = rect.x + rect.width / 2; y = rect.y + rect.height / 2;
    if (action.type !== "reveal" && (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) throw new Error("element_outside_viewport");
    const hit = document.elementFromPoint(x, y);
    if (action.type !== "reveal" && (!hit || (hit !== element && !element.contains(hit)))) throw new Error("element_obscured");
  }
  if (action.type === "reveal" && !element) throw new Error("stale_element");
  if (action.type === "fill") {
    const editable = element instanceof HTMLTextAreaElement || element?.isContentEditable || (element instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "number", "date", "time", "datetime-local", "month", "week"].includes(element.type));
    if (!editable || state.describe(element).readOnly) throw new Error("not_editable");
  }
  if (action.type === "select") {
    if (!(element instanceof HTMLSelectElement) || (!element.multiple && action.values.length > 1)) throw new Error("not_selectable");
    for (const value of action.values) {
      const option = [...element.options].find(option => option.value === value);
      if (!option || option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) throw new Error("option_unavailable");
    }
  }
  if (action.type === "set_checked") {
    const native = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type);
    if ((!native && !["checkbox", "radio", "switch"].includes(element?.getAttribute("role"))) || state.describe(element).readOnly) throw new Error("not_checkable");
    if ((element.type === "radio" || element.getAttribute("role") === "radio") && !action.checked) throw new Error("not_checkable");
  }
  if ((action.type === "click" || action.type === "scroll") && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) throw new Error("outside_viewport");
  if (!element && action.type === "click") {
    const hit = document.elementFromPoint(x, y);
    if (hit?.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  }
  // Consume before input; a result read failure must never replay this action.
  state.used = true;
  return { x, y, unchanged: action.type === "set_checked" && state.describe(element).checked === action.checked };
}
function applyFormAction(id, action) {
  const state = globalThis.__openworkBrowserObservation;
  const element = state?.id === id ? state.nodes.get(action.ref) : null;
  if (!element?.isConnected) throw new Error("stale_element");
  if (state.snapshots.get(element) !== JSON.stringify(state.describe(element))) throw new Error("stale_observation");
  element.focus();
  if (document.activeElement !== element || !element.isConnected) throw new Error("stale_element");
  if (action.type === "select") {
    for (const option of element.options) option.selected = action.values.includes(option.value);
    if (!action.values.length) element.selectedIndex = -1;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { inserted: true };
  }
  if (action.type === "fill") {
    if (element instanceof HTMLInputElement && ["date", "time", "datetime-local", "month", "week"].includes(element.type)) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, action.text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { inserted: true };
    }
    if (element.isContentEditable) document.getSelection()?.selectAllChildren(element);
    else element.select();
    if (document.activeElement !== element || !element.isConnected) throw new Error("stale_element");
  }
  return { inserted: false };
}
async function verifyFormAction(id, action) {
  const state = globalThis.__openworkBrowserObservation;
  const element = state?.id === id ? state.nodes.get(action.ref) : null;
  const deadline = performance.now() + 1500;
  let matchingSince = null, control;
  do {
    if (!element?.isConnected) throw new Error("stale_element");
    control = state.describe(element);
    const matches = action.type === "set_checked" ? control.checked === action.checked
      : action.type === "select" ? control.selectedValues.length === new Set(action.values).size && action.values.every(value => control.selectedValues.includes(value))
      : !control.valueTruncated && control.value === (element instanceof HTMLTextAreaElement ? action.text.replace(/\r\n?/g, "\n") : action.text);
    matchingSince = matches ? matchingSince ?? performance.now() : null;
    if (matchingSince !== null && performance.now() - matchingSince >= 150) return { verified: true, control };
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  return { verified: false, control };
}
async function captureObservation(webContents, viewport) {
  if (typeof webContents.captureObservation === "function") return webContents.captureObservation(viewport);
  const capture = await webContents.capturePage();
  return capture.resize({ width: viewport.width, height: viewport.height }).toPNG({ scaleFactor: 1 });
}
function imageDigest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function isolated(webContents, fn, ...args) {
  // Electron strips exceptions crossing an isolated world to a generic error.
  // Carry our validation result as data so a refused control keeps its reason.
  const result = await webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(async () => {
    try { return { ok: true, value: await (${fn.toString()})(...${JSON.stringify(args)}) }; }
    catch (error) { return { ok: false, message: typeof error?.message === "string" ? error.message : "Browser page operation failed" }; }
  })()` }]);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

export function createBrowserTaskHost({ getTab, tabsFor, ownerOf, activeFor, isVisible, openTab, navigate,
  allowed, enabled, changed, siteTools, runSiteTool, beforeInput = async (_tab) => {} }) {
  const states = new Map();
  const controls = new Map();
  const pausedSessions = new Set();
  const opening = new Map();
  const navigations = new Map();
  function controlFor(sessionId) {
    if (!controls.has(sessionId)) controls.set(sessionId, { controller: new AbortController() });
    return controls.get(sessionId);
  }
  function stopControl(sessionId, control = controls.get(sessionId), reason = new BrowserTaskError("canceled", "Browser control stopped. Retry the browser operation.")) {
    if (!control || controls.get(sessionId) !== control) return;
    controls.delete(sessionId);
    control.controller.abort(reason);
    for (const tab of tabsFor(sessionId)) {
      const state = states.get(tab.tabId);
      if (state) state.observation = null;
    }
  }
  function checkControl(sessionId, control) {
    control.controller.signal.throwIfAborted();
    if (controls.get(sessionId) !== control) fail("canceled", "Browser control stopped. Retry the browser operation.");
  }
  function trackNavigation(sessionId, tab, signal = undefined) {
    const previous = navigations.get(tab.tabId);
    const control = controlFor(sessionId);
    const sameTab = previous?.tab === tab && previous.sessionId === sessionId && previous.control === control;
    // Popup lifetimes follow deliberate cancellation/closure, not the routine
    // replacement of an operation scope when its parent is observed again.
    const lifetime = sameTab && !previous.lifetime.signal.aborted ? previous.lifetime : new AbortController();
    if (signal?.aborted) lifetime.abort(signal.reason);
    else signal?.addEventListener("abort", () => lifetime.abort(signal.reason), { once: true, signal: lifetime.signal });
    const controller = new AbortController();
    const scope = { tab, sessionId, controller, lifetime, control, manual: false,
      signal: AbortSignal.any([lifetime.signal, controller.signal, control.controller.signal]) };
    previous?.controller.abort();
    navigations.set(tab.tabId, scope);
    return scope;
  }
  function checkNavigation(scope) {
    scope.signal.throwIfAborted();
    const { tab, sessionId } = scope;
    checkControl(sessionId, scope.control);
    if (getTab(tab.tabId) !== tab || tab.view.webContents.isDestroyed()) fail("tab_closed", "The browser tab closed while navigation was pending.");
    if (ownerOf(tab.tabId) !== sessionId || navigations.get(tab.tabId) !== scope) fail("wrong_conversation", "The browser navigation owner changed.");
    if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control. Resume before continuing.");
    if (!enabled()) fail("browser_disabled", "Browser control was disabled while navigation was pending.");
  }
  async function authorizeNavigation(scope, value) {
    const url = browserTaskUrl(value);
    checkNavigation(scope);
    if (!await allowed(url.href)) fail("website_blocked", "Your organization does not allow this website.");
    checkNavigation(scope);
    // The request hook rechecks the full managed policy (including uploads).
    // Give it a synchronous final ownership/cancellation check.
    return () => checkNavigation(scope);
  }
  function navigationGuard(tabId) {
    const scope = navigations.get(tabId);
    // Pausing alone must not turn a late task redirect into manual browsing.
    // Only explicit app-toolbar navigation enables manual mode.
    // Page input (including trusted events) can come from queued automation.
    if (!scope || (scope.manual && pausedSessions.has(scope.sessionId) && ownerOf(tabId) === scope.sessionId)) return null;
    return (url) => authorizeNavigation(scope, url);
  }
  function manualNavigation(tabId) {
    const scope = navigations.get(tabId);
    if (scope && pausedSessions.has(scope.sessionId) && ownerOf(tabId) === scope.sessionId) scope.manual = true;
  }
  function inheritNavigation(parentId, tab) {
    const scope = navigations.get(parentId);
    if (scope && navigationGuard(parentId)) trackNavigation(scope.sessionId, tab, scope.lifetime.signal);
  }
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
  function pause(tabId, reason = "Paused by you") {
    const owner = ownerOf(tabId);
    if (owner) {
      pausedSessions.add(owner);
      const reason = new BrowserTaskError("paused", "The user has taken over this browser conversation.");
      stopControl(owner, controls.get(owner), reason);
      opening.get(owner)?.abort(reason);
    }
    for (const item of tabsFor(owner)) {
      const navigation = navigations.get(item.tabId);
      if (navigation) { navigation.manual = false; navigation.lifetime.abort(); }
      if (!item.view.webContents.isDestroyed()) item.view.webContents.stop();
      const sibling = states.get(item.tabId); sibling?.controller?.abort(); if (sibling) sibling.observation = null; publish(item.tabId, "paused", reason);
    }
    const state = stateFor(tabId); state.observation = null;
    state.controller?.abort(new BrowserTaskError("paused", "Browser control paused. The user must resume it in the browser panel."));
    publish(tabId, "paused", reason);
  }
  function resume(tabId) {
    const owner = ownerOf(tabId);
    if (tabsFor(owner).some((item) => stateFor(item.tabId).controller)) return;
    pausedSessions.delete(owner);
    for (const item of tabsFor(owner)) {
      if (navigations.has(item.tabId)) trackNavigation(owner, item);
      stateFor(item.tabId).observation = null; publish(item.tabId, "idle");
    }
  }
  function invalidate(tabId, { closed = false, reason = undefined } = {}) {
    if (closed) {
      const owner = ownerOf(tabId);
      if (owner && !tabsFor(owner).some((tab) => tab.tabId !== tabId && !tab.view.webContents.isDestroyed())) {
        stopControl(owner, controls.get(owner), reason);
        pausedSessions.delete(owner);
      }
      navigations.get(tabId)?.lifetime.abort(); navigations.delete(tabId);
    }
    const state = states.get(tabId); if (!state) return;
    state.observation = null;
    if (closed) { state.controller?.abort(); states.delete(tabId); }
  }
  async function observe(tab, includeImage, signal, query = null) {
    const state = stateFor(tab.tabId);
    state.observation = null;
    const revision = tab.webMcpRevision;
    const url = tab.view.webContents.getURL();
    const id = randomUUID();
    const page = await isolated(tab.view.webContents, observePage, id, query);
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
    state.observation = { id, revision, url, viewport: page.viewport, elements: page.elements, digest };
    return { ok: true, tabId: tab.tabId, observationId: id, url: safeUrl(url), trust: TRUST, ...page, ...(image ? { image } : {}) };
  }
  /**
   * @param {{ sessionId?: string, operation?: string, args?: { tabId?: string, url?: string, provider?: string, includeImage?: boolean, query?: {role?: string, name?: string, text?: string, exact?: boolean}, observationId?: string, toolId?: string, input?: unknown, action?: { type?: string, ref?: string, text?: string, checked?: boolean, values?: string[], key?: string, x?: number, y?: number, deltaY?: number } } }} request
   * @param {{ signal?: AbortSignal }} options
   */
  async function request({ sessionId, operation, args = {} } = {}, { signal } = {}) {
    let tab, state, dispatched = false, abort, controller, openingController;
    try {
      if (typeof sessionId !== "string" || !sessionId.trim()) fail("missing_session", "Browser control requires a requesting conversation.");
      if (!enabled()) fail("browser_disabled", "Enable OpenWork Browser in Library, or ask your organization to allow browser control.");
      if (operation === "tabs") return { ok: true, provider: "builtin", externalBrowsers: "unsupported", tabs: tabsFor(sessionId).map((item) => ({ tabId: item.tabId, url: safeUrl(item.view.webContents.getURL()), title: item.view.webContents.getTitle().slice(0, 300), visible: isVisible(item.tabId), ...stateFor(item.tabId), observation: undefined, controller: undefined })) };
      if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control. Resume in the browser panel before continuing.");
      const control = controlFor(sessionId);
      controller = new AbortController();
      const requestSignal = AbortSignal.any([controller.signal, control.controller.signal]);
      abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      requestSignal.throwIfAborted();
      const canceled = new Promise((_, reject) => requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true }));
      void canceled.catch(() => {});
      for (const item of tabsFor(sessionId)) {
        if (!navigations.has(item.tabId)) trackNavigation(sessionId, item);
      }
      if (operation === "open") {
        if (args.provider && !["builtin", "auto"].includes(args.provider)) fail("unsupported_browser", "External browser control is not connected. Use the built-in browser or open the requested external browser yourself.");
        const url = browserTaskUrl(args.url);
        if (opening.has(sessionId)) fail("busy", "A tab is already opening for this conversation. List tabs after it finishes.");
        openingController = controller;
        opening.set(sessionId, openingController);
        if (!await Promise.race([allowed(url.href), canceled])) fail("website_blocked", "Your organization does not allow this website.");
        if (!enabled()) fail("browser_disabled", "Browser control was disabled while opening the page.");
        requestSignal.throwIfAborted();
        checkControl(sessionId, control);
        const matches = tabsFor(sessionId).filter((item) => item.view.webContents.getURL() === url.href);
        tab = args.tabId ? await Promise.race([resolve(sessionId, args.tabId), canceled]) : matches[0];
        requestSignal.throwIfAborted();
        checkControl(sessionId, control);
        if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control. Resume in the browser panel before continuing.");
        if (!tab) {
          tab = await Promise.race([
            openTab(url.href, sessionId, requestSignal, async (created) => {
              const validate = await authorizeNavigation(trackNavigation(sessionId, created, requestSignal), url.href);
              validate();
              dispatched = true;
            }),
            canceled,
          ]);
          requestSignal.throwIfAborted();
        }
        else if (tab.view.webContents.getURL() !== url.href) fail("different_page", "Use navigate to change the selected tab's page.");
        else {
          if (stateFor(tab.tabId).controller) fail("busy", "A browser operation is already running in this tab.");
          const validate = await Promise.race([authorizeNavigation(trackNavigation(sessionId, tab, requestSignal), url.href), canceled]);
          validate();
        }
        publish(tab.tabId, "idle");
        return { ok: true, provider: "builtin", tabId: tab.tabId, url: safeUrl(tab.view.webContents.getURL()), visible: isVisible(tab.tabId), next: "observe" };
      }
      tab = await Promise.race([resolve(sessionId, args.tabId, ["navigate", "pause", "handoff"].includes(operation)), canceled]);
      requestSignal.throwIfAborted();
      checkControl(sessionId, control);
      state = stateFor(tab.tabId);
      if (operation === "pause" || operation === "handoff") { pause(tab.tabId, operation === "handoff" ? "Sign in or continue in the browser, then resume" : "Paused"); return { ok: true, status: "paused", tabId: tab.tabId, next: "user_resume" }; }
      if (pausedSessions.has(sessionId) || state.status === "paused") fail("paused", "The user has browser control. Resume in the browser panel before continuing.");
      if (state.controller) fail("busy", "A browser operation is already running in this tab. Wait for its result; do not queue another action.");
      state.controller = controller;
      const navigationScope = trackNavigation(sessionId, tab, requestSignal);
      const run = async () => {
        requestSignal.throwIfAborted();
        if (operation !== "navigate") {
          const url = tab.view.webContents.getURL();
          const validate = await authorizeNavigation(navigationScope, url);
          validate();
          if (url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed while checking access. Observe again.");
        }
        requestSignal.throwIfAborted();
        publish(tab.tabId, "running", operation);
        if (operation === "observe") return observe(tab, args.includeImage === true, requestSignal, args.query);
        if (operation === "site_tools") return siteTools({ tabId: tab.tabId, sessionId });
        if (operation === "site_tool") {
          state.observation = null;
          dispatched = true;
          const result = await runSiteTool({ ...args, tabId: tab.tabId, sessionId }, { signal: requestSignal });
          dispatched = result.dispatched === true || result.mayHaveChangedState === true;
          return result;
        }
        if (operation === "navigate") {
          const url = browserTaskUrl(args.url);
          const validate = await authorizeNavigation(navigationScope, url.href);
          validate();
          state.observation = null; dispatched = true;
          const stop = () => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop(); };
          requestSignal.addEventListener("abort", stop, { once: true });
          try { await navigate(tab, url.href); requestSignal.throwIfAborted(); }
          finally { requestSignal.removeEventListener("abort", stop); }
          return { ok: true, tabId: tab.tabId, dispatched: true, outcome: "navigation_finished", url: safeUrl(tab.view.webContents.getURL()), next: "observe" };
        }
        if (operation !== "act") fail("unknown_operation", "Use a supported browser operation.");
        const observed = state.observation;
        if (!observed || observed.id !== args.observationId || observed.revision !== tab.webMcpRevision || observed.url !== tab.view.webContents.getURL()) fail("stale_observation", "Observe the current page before acting.");
        const action = structuredClone(args.action);
        if (!action || !["click", "fill", "select", "set_checked", "key", "scroll", "reveal"].includes(action.type)) fail("invalid_action", "Use click, fill, select, set_checked, key or scroll.");
        if (action.type === "click" && !action.ref && !observed.digest) fail("image_required", "Observe with includeImage before clicking image coordinates.");
        if (action.type === "fill" && (typeof action.text !== "string" || action.text.length > 8000 || !action.ref)) fail("invalid_action", "Fill needs an observed editable reference and text of at most 8000 characters.");
        if (action.type === "select" && (!action.ref || !Array.isArray(action.values) || action.values.length > 200 || !action.values.every(value => typeof value === "string" && value.length <= 8000))) fail("invalid_action", "Select needs an observed select reference and an array of option values.");
        if (action.type === "set_checked" && (!action.ref || typeof action.checked !== "boolean")) fail("invalid_action", "Set_checked needs an observed checkbox, radio or switch reference and checked true or false.");
        const keys = { Enter: "Enter", Tab: "Tab", Escape: "Escape", ArrowDown: "Down", ArrowUp: "Up", ArrowLeft: "Left", ArrowRight: "Right", Backspace: "Backspace", Space: "Space" };
        if (action.type === "key" && !Object.hasOwn(keys, action.key)) fail("invalid_key", "Use Enter, Tab, Escape, arrows, Backspace or Space. System shortcuts are unavailable.");
        if (action.type === "scroll" && (!Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 1200)) fail("invalid_scroll", "Scroll distance must be between -1200 and 1200.");
        if (!await allowed(observed.url) || state.observation !== observed || observed.revision !== tab.webMcpRevision || observed.url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed or access was blocked while preparing the action. Observe again.");
        requestSignal.throwIfAborted();
        if (action.type === "click" && !action.ref && imageDigest(await captureObservation(tab.view.webContents, observed.viewport)) !== observed.digest) fail("stale_observation", "The image changed. Observe again before choosing coordinates.");
        if (action.type === "fill" || action.type === "select" || action.type === "reveal") {
          // DOM-backed form edits must release the same native input lease as
          // keyboard and pointer events on the shared cloud desktop.
          await beforeInput(tab);
          requestSignal.throwIfAborted();
        }
        checkNavigation(navigationScope);
        let point;
        try { point = await isolated(tab.view.webContents, prepareAction, observed.id, action); }
        catch (error) {
          const code = ["stale_observation", "stale_element", "sign_in_required", "unverifiable_focus", "element_disabled", "element_outside_viewport", "element_obscured", "not_editable", "not_selectable", "option_unavailable", "not_checkable", "outside_viewport"].find((item) => String(error?.message).includes(item));
          if (code === "unverifiable_focus") fail(code, "Keyboard input requires a directly focused observed page control. Click the control and observe again.");
          if (code) fail(code, code === "sign_in_required" ? "Take over and sign in directly in the browser, then resume." : "The observed control is no longer ready. Observe again before choosing an action.");
          throw error;
        }
        checkNavigation(navigationScope);
        if (state.observation !== observed || observed.revision !== tab.webMcpRevision || observed.url !== tab.view.webContents.getURL()) fail("stale_observation", "The page or observation changed while preparing the action. Observe again.");
        state.observation = null; requestSignal.throwIfAborted();
        publish(tab.tabId, "running", action.type);
        const contents = tab.view.webContents;
        dispatched = !point.unchanged;
        if (action.type === "reveal") await isolated(contents, (id, ref) => {
          const state = globalThis.__openworkBrowserObservation;
          const element = state?.id === id ? state.nodes.get(ref) : null;
          if (!element?.isConnected) throw new Error("stale_element");
          element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        }, observed.id, action.ref);
        if (action.type === "fill" || action.type === "select") {
          const prepared = await isolated(contents, applyFormAction, observed.id, action);
          if (action.type === "fill" && !prepared.inserted) {
            if (action.text) await contents.insertText(action.text);
            else {
              await contents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
              requestSignal.throwIfAborted();
              await contents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
            }
          }
        }
        if (action.type === "click" || action.type === "scroll" || (action.type === "set_checked" && !point.unchanged)) {
          // sendInputEvent targets the main widget, not an OOPIF's widget.
          // Chromium's input router hit-tests these observed CSS pixels.
          const cdp = contents.debugger;
          const attached = !cdp.isAttached();
          if (attached) cdp.attach("1.3");
          try {
            if (action.type === "scroll") {
              await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: action.deltaY });
            } else {
              await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
              requestSignal.throwIfAborted();
              await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
            }
          } finally {
            if (attached && cdp.isAttached()) cdp.detach();
          }
        }
        if (action.type === "key") { await contents.sendInputEvent({ type: "keyDown", keyCode: keys[action.key] }); requestSignal.throwIfAborted(); await contents.sendInputEvent({ type: "keyUp", keyCode: keys[action.key] }); }
        if (["fill", "select", "set_checked"].includes(action.type)) {
          const result = await isolated(contents, verifyFormAction, observed.id, action);
          requestSignal.throwIfAborted();
          return { ok: result.verified, dispatched, mayHaveChangedState: dispatched, outcome: result.verified ? "verified" : "value_mismatch", retrySafe: false,
            ...(result.verified ? {} : { code: "value_mismatch", error: "The control did not retain the requested value. Observe its current state before deciding how to continue." }),
            tabId: tab.tabId, control: result.control, next: "observe" };
        }
        return { ok: true, dispatched: true, outcome: "not_yet_verified", retrySafe: false, tabId: tab.tabId, next: "observe", message: "Observe the page and verify the requested outcome before reporting success." };
      };
      const result = await Promise.race([run(), canceled]);
      requestSignal.throwIfAborted();
      if (state.status !== "paused") publish(tab.tabId, result.ok ? "idle" : "needs_attention", result.ok ? null : result.code);
      return result;
    } catch (error) {
      if (state && state.controller === controller) state.observation = null;
      if (tab && state?.status !== "paused" && (!state?.controller || state.controller === controller)) publish(tab.tabId, "needs_attention", error?.code || "Check browser");
      return { ok: false, code: error instanceof BrowserTaskError ? error.code : "browser_operation_failed", error: error instanceof BrowserTaskError ? error.message : "Browser operation could not finish. Observe the page or take over to continue.", dispatched, mayHaveChangedState: dispatched, retrySafe: false, next: dispatched ? "observe_before_retry" : "review", trust: TRUST };
    } finally {
      if (openingController && opening.get(sessionId) === openingController) opening.delete(sessionId);
      if (signal && abort) signal.removeEventListener("abort", abort);
      if (state && state.controller === controller) state.controller = null;
    }
  }
  return { request, pause, resume, invalidate, stateFor, navigationGuard, inheritNavigation, manualNavigation };
}
