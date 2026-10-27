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

// After click, key or scroll: wait for navigation, network idle and a DOM that
// stops changing structure (text-only tickers and clocks do not count).
const SETTLE_MS = 3000;
const QUIET_MS = 250;
const NAMED_KEYS = { Enter: "Enter", Tab: "Tab", Escape: "Escape", ArrowDown: "Down", ArrowUp: "Up", ArrowLeft: "Left", ArrowRight: "Right",
  Backspace: "Backspace", Delete: "Delete", Space: "Space", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
const KEY_MODIFIERS = { control: "control", command: "meta", shift: "shift", option: "alt" };
// Clipboard, window, app-switch, screenshot and developer-tool chords stay
// unavailable. "primary" is control or command.
const BLOCKED_CHORDS = [
  ["primary", "c"], ["primary", "x"], ["primary", "v"], ["control", "k"], ["control", "y"],
  ["primary", "q"], ["primary", "w"], ["primary", "h"], ["primary", "m"], ["primary", "n"], ["primary", "t"],
  ["primary", "Tab"], ["primary", "Space"], ["primary", "Escape"], ["option", "Tab"], ["option", "Space"], ["option", "Escape"],
  ["primary", "shift", "3"], ["primary", "shift", "4"], ["primary", "shift", "5"], ["primary", "shift", "6"],
  ["primary", "shift", "i"], ["primary", "shift", "j"], ["primary", "option", "i"], ["primary", "option", "j"],
  ["command", "control", "f"], ["command", "option", "d"], ["command", "control", "q"], ["command", "shift", "q"],
].map((parts) => ({ key: parts.at(-1), modifiers: parts.slice(0, -1) }));
// Chromium on macOS runs these through the app menu, not page key events.
const EDIT_COMMANDS = { a: "selectAll", z: "undo", "shift+z": "redo" };
const ACTION_TYPES = ["click", "fill", "select", "set_checked", "key", "scroll", "reveal"];
const PREPARE_CODES = ["stale_observation", "stale_element", "sign_in_required", "unverifiable_focus", "element_disabled", "element_outside_viewport",
  "element_obscured", "not_editable", "not_selectable", "option_unavailable", "not_checkable", "outside_viewport"];

/** @param {{ key?: unknown, modifiers?: unknown }} action */
function resolveKey(action) {
  /** @type {string[]} */
  const modifiers = action.modifiers === undefined ? [] : Array.isArray(action.modifiers) ? action.modifiers : fail("invalid_key", "Modifiers must be a list.");
  if (modifiers.length > 3 || new Set(modifiers).size !== modifiers.length || !modifiers.every((name) => Object.hasOwn(KEY_MODIFIERS, name))) {
    fail("invalid_key", "Modifiers are control, command, shift or option, each at most once.");
  }
  const raw = typeof action.key === "string" ? action.key : "";
  const named = Object.hasOwn(NAMED_KEYS, raw) ? raw : null;
  const character = /^[a-zA-Z0-9]$/.test(raw) ? raw.toLowerCase() : null;
  if (!named && !character) fail("invalid_key", "Use Enter, Tab, Escape, arrows, Backspace, Delete, Space, Home, End, PageUp, PageDown, or a letter or digit with control or command.");
  if (character && !modifiers.some((name) => name === "control" || name === "command")) fail("invalid_key", "Letters and digits need control or command. Use fill for text.");
  const base = named ?? character;
  const held = new Set(modifiers);
  const holds = (name) => name === "primary" ? held.has("control") || held.has("command") : held.has(name);
  if (BLOCKED_CHORDS.some((chord) => chord.key === base && chord.modifiers.every(holds))) {
    fail("blocked_shortcut", "Clipboard and browser or system escape shortcuts are unavailable. Use fill, select or observed page controls.");
  }
  const primary = held.has("control") || held.has("command");
  const extra = modifiers.filter((name) => name !== "control" && name !== "command").sort().join("+");
  const edit = primary && character && !(held.has("control") && held.has("command")) ? EDIT_COMMANDS[extra ? `${extra}+${character}` : character] : undefined;
  return { keyCode: named ? NAMED_KEYS[named] : character.toUpperCase(), modifiers: modifiers.map((name) => KEY_MODIFIERS[name]),
    chord: [...modifiers].sort().concat(base).join("+"), ...(edit ? { edit } : {}) };
}

// Runs in Electron's isolated world. It has DOM access but no page globals,
// Node, IPC, browser profile or network tools. References never enter page DOM.
// Refs live in this world for the document's lifetime: the same element keeps
// the same ref across observations, so one observation can drive many actions.
function observePage(id, options = {}) {
  const { mode = "full", query = null } = options;
  const interactive = mode === "interactive";
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 500) : interactive ? 200 : 500;
  const includeText = options.includeText ?? !interactive;
  const registry = globalThis.__openworkBrowserRefs ??= { byElement: new WeakMap(), byRef: new Map(), identities: new WeakMap(), next: 0,
    observations: new Map(), latest: null, last: null, describe: null, identify: null };
  const elements = [];
  registry.snapshots ??= new WeakMap();
  registry.optionRefs ??= new WeakMap();
  registry.shownOptions ??= new WeakMap();
  registry.nextOption ??= 0;
  const optionRef = option => {
    let entry = registry.optionRefs.get(option);
    if (!entry || entry.value !== option.value) {
      entry = { value: option.value, ref: `o${++registry.nextOption}` };
      registry.optionRefs.set(option, entry);
    }
    return entry.ref;
  };
  // Values the page or person filled (autofill, a typed address) stay in the page: the model sees
  // only whether a field is filled, unless the agent entered that exact value itself. In-page
  // staleness and verification checks read the real value (reveal).
  const entered = globalThis.__openworkAgentEntered ??= new WeakMap();
  const isSensitive = element => element.matches('input[type="password"]') ||
    (element.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).some(token => token === "one-time-code" || token.startsWith("cc-"));
  const isTextValue = element => element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement && !["button", "submit", "reset", "checkbox", "radio", "hidden", "file", "range", "color"].includes(element.type) ||
    element.isContentEditable || ["textbox", "combobox"].includes(element.getAttribute("role"));
  const candidates = document.querySelectorAll('a[href],button,input,textarea,select,[role],h1,h2,h3,h4,p,label,tr,table,main,aside,section,div,[contenteditable]:not([contenteditable="false"])');
  const withheld = new Set();
  const identities = new Set();
  for (const element of candidates) {
    if (!(element instanceof HTMLElement)) continue;
    const input = element instanceof HTMLInputElement, textarea = element instanceof HTMLTextAreaElement, select = element instanceof HTMLSelectElement;
    const role = element.getAttribute("role");
    if (!input && !textarea && !select && !element.isContentEditable && !["textbox", "combobox"].includes(role)) continue;
    const value = input || textarea || select ? element.value : element.isContentEditable ? element.innerText : element.getAttribute("aria-valuetext") || element.textContent || "";
    const sensitive = isSensitive(element);
    if (value?.trim() && (sensitive || isTextValue(element) && entered.get(element) !== value)) withheld.add(value);
    // A public option label can itself be its backing value ("Plan 1" / "1").
    // Preserve that visible label; other backing identities remain private.
    if (select) for (const option of element.options) if (option.value?.trim() && !option.label.includes(option.value)) identities.add(option.value);
  }
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const privateValues = [...withheld].sort((a, b) => b.length - a.length).map(escape);
  for (const value of [...identities].sort((a, b) => b.length - a.length)) {
    // Short backing IDs are common fragments of unrelated public labels:
    // "en" must not erase "French". They are private as complete tokens.
    privateValues.push(value.length < 5 ? `(?<![\\p{L}\\p{N}_])${escape(value)}(?![\\p{L}\\p{N}_])` : escape(value));
  }
  const privatePattern = privateValues.length ? new RegExp(privateValues.join("|"), "gu") : null;
  const text = (value, limit = 200) => {
    // Labels, referenced nodes, body text and titles can all echo a field's
    // withheld content. Redact before truncation, throughout the observation.
    const safe = privatePattern ? (value || "").replace(privatePattern, "[withheld]") : value || "";
    return safe.trim().slice(0, limit);
  };
  // browser_extract reads page text, which includes editable content and can echo field values.
  if (mode === "extract") return { title: text(document.title, 300), text: text(document.body?.innerText, 500_000) };
  const describe = (element, reveal = false) => {
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
    // One-time codes and payment-card fields (cc-number, cc-csc, cc-exp...) never leave the page.
    const sensitive = isSensitive(element);
    const role = element.getAttribute("role");
    // Non-text backing values stay private, but still bind the internal
    // staleness check to the identity the page exposed when observed.
    const field = select || isTextValue(element) || reveal && input;
    const value = field ? input || textarea || select ? element.value : element.isContentEditable ? element.innerText : element.getAttribute("aria-valuetext") || element.textContent || "" : "";
    const name = referenced("aria-labelledby") || element.getAttribute("aria-label") ||
      (input || textarea || select ? [...(element.labels || [])].map(labelText).join(" ") : "") ||
      (input && ["submit", "button", "reset"].includes(element.type) ? element.value : "") ||
      (!input && !textarea && !select ? element.innerText : "") || element.getAttribute("placeholder") || element.getAttribute("name") || "";
    /** @type {{ tag: string, role: string | null, name: string, disabled: boolean, sensitive: boolean, required: boolean, readOnly: boolean,
     * type?: string, value?: string, valueTruncated?: boolean, filled?: boolean, valueWithheld?: boolean, checked?: boolean | "mixed", expanded?: boolean, selected?: boolean,
     * multiple?: boolean, options?: { value: string, label: string, selected?: boolean, disabled: boolean }[], optionsTruncated?: boolean,
     * selectedValues?: string[], valid?: boolean, validationMessage?: string, description?: string }} */
    const state = {
      tag: element.tagName.toLowerCase(), role: role || (input ? ["checkbox", "radio"].includes(element.type) ? element.type : ["button", "submit", "reset"].includes(element.type) ? "button" : element.type === "search" ? "searchbox" : "textbox" :
        { BUTTON: "button", A: "link", TEXTAREA: "textbox", SELECT: "combobox", H1: "heading", H2: "heading", H3: "heading", H4: "heading", TR: "row", TABLE: "table" }[element.tagName]) ||
        (element.scrollHeight > element.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(element).overflowY) ? "region" : "text"),
      name: text(name),
      disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true" || !!element.closest("[inert]"),
      sensitive,
      required: element.required === true || element.getAttribute("aria-required") === "true",
      readOnly: element.readOnly === true || element.getAttribute("aria-readonly") === "true",
    };
    if (input) state.type = element.type;
    if (!sensitive && field) {
      if (reveal || (!select && entered.get(element) === value)) { state.value = value.slice(0, 8000); state.valueTruncated = value.length > 8000; }
      else { state.filled = value.length > 0; state.valueWithheld = true; }
    }
    if (input && ["checkbox", "radio"].includes(element.type)) state.checked = element.indeterminate ? "mixed" : element.checked;
    else if (element.hasAttribute("aria-checked")) state.checked = element.getAttribute("aria-checked") === "mixed" ? "mixed" : element.getAttribute("aria-checked") === "true";
    if (element.hasAttribute("aria-expanded")) state.expanded = element.getAttribute("aria-expanded") === "true";
    if (element.hasAttribute("aria-selected")) state.selected = element.getAttribute("aria-selected") === "true";
    if (select && !sensitive) {
      const chosen = [...element.selectedOptions].map(option => option.value);
      const shown = reveal || entered.get(element) === JSON.stringify(chosen);
      state.multiple = element.multiple;
      state.options = [...element.options].slice(0, 200).map(option => ({ value: optionRef(option), label: text(option.label),
        ...(shown ? { selected: option.selected } : {}), disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled) }));
      state.optionsTruncated = element.options.length > 200;
      if (shown) { state.selectedValues = [...element.selectedOptions].slice(0, 200).map(optionRef); delete state.value; delete state.valueTruncated; delete state.filled; delete state.valueWithheld; }
      else { delete state.value; delete state.valueTruncated; state.filled = chosen.length > 0; state.valueWithheld = true; }
    }
    if (element.validity || element.hasAttribute("aria-invalid")) {
      state.valid = (element.validity?.valid ?? true) && !["true", "grammar", "spelling"].includes(element.getAttribute("aria-invalid"));
      // A page can echo a field's value into its error or description text.
      state.validationMessage = sensitive || state.valueWithheld || select ? "" : text(element.validationMessage || referenced("aria-errormessage"), 1000);
    }
    const description = referenced("aria-describedby");
    if (description && !sensitive && !state.valueWithheld && !select) state.description = text(description, 1000);
    return state;
  };
  // A control keeps its ref while it stays the same kind of control with the
  // same accessible name. Values, checked state and validity may change.
  // Editable text controls derive their name from content, so use only labels.
  const identify = (element, control) => JSON.stringify([control.tag, control.role, control.type ?? null, control.sensitive,
    element.isContentEditable || ["textbox", "combobox", "searchbox"].includes(control.role) && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
      ? [element.getAttribute("aria-label"), element.getAttribute("aria-labelledby")] : control.name]);
  const compact = (ref, control, visible) => {
    /** @type {Record<string, unknown>} */
    const item = { ref, role: control.role, name: control.name.slice(0, 120) };
    if (control.type && !["text", "submit", "button"].includes(control.type)) item.type = control.type;
    if (control.value !== undefined && control.value !== "" && !control.options) item.value = control.value.length > 300 ? `${control.value.slice(0, 300)}…` : control.value;
    if (control.valueWithheld) { item.filled = control.filled === true; item.valueWithheld = true; }
    if (control.checked !== undefined) item.checked = control.checked;
    if (control.selected) item.selected = true;
    if (control.expanded !== undefined) item.expanded = control.expanded;
    if (control.disabled) item.disabled = true;
    if (control.readOnly) item.readOnly = true;
    if (control.required) item.required = true;
    if (control.sensitive) item.sensitive = true;
    if (control.valid === false) item.invalid = control.validationMessage || true;
    if (control.options) {
      item.options = control.options.slice(0, 50).map((option) => ({ value: option.value, label: option.label, ...(option.selected ? { selected: true } : {}), ...(option.disabled ? { disabled: true } : {}) }));
      if (control.multiple) item.multiple = true;
      if (control.optionsTruncated || control.options.length > 50) item.optionsTruncated = true;
    }
    if (control.description) item.description = control.description.slice(0, 200);
    if (!visible) item.offscreen = true;
    return item;
  };
  const targets = document.querySelectorAll(interactive
    ? 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="slider"],[role="spinbutton"],[role="listbox"],[role="treeitem"]'
    : 'a[href],button,input,textarea,select,[role],h1,h2,h3,h4,p,label,tr,table,main,aside,section,div,[contenteditable]:not([contenteditable="false"])');
  const scrollRegions = [];
  const items = [];
  let scanned = 0, truncated = false;
  for (const element of targets) {
    if (!(element instanceof HTMLElement)) continue;
    // An associated label already supplies the control's accessible name.
    // Returning it again makes ordinary name-based form targets ambiguous.
    if (element instanceof HTMLLabelElement && element.control) continue;
    if (++scanned > 6000 || items.length >= limit) { truncated = true; break; }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility !== "visible" || style.display === "none") continue;
    const scrollable = element.scrollHeight > element.clientHeight + 4 && /auto|scroll/.test(style.overflowY);
    if (!interactive && element.tagName === "DIV" && !element.hasAttribute("role") && !element.isContentEditable && !scrollable) continue;
    if (scrollable) scrollRegions.push([text(element.getAttribute("aria-label") || element.id), element.scrollTop, element.scrollHeight, element.clientHeight]);
    const control = describe(element);
    if (query) {
      const match = (actual, expected) => !expected || (query.exact === false ? actual.toLowerCase().includes(expected.toLowerCase()) : actual.toLowerCase() === expected.toLowerCase());
      if (!match(control.role, query.role) || !match(control.name, query.name) || !match(control.name, query.text)) continue;
    }
    let ref = registry.byElement.get(element);
    if (!ref) { ref = `e${++registry.next}`; registry.byElement.set(element, ref); }
    // A control moved out of and back into the document keeps its ref.
    if (registry.byRef.get(ref)?.deref() !== element) registry.byRef.set(ref, new WeakRef(element));
    registry.identities.set(element, identify(element, control));
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    for (let parent = element.parentElement; parent && right > left && bottom > top; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent), clip = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      if (/auto|scroll|hidden|clip/.test(parentStyle.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
    }
    const visible = right > left && bottom > top;
    const item = compact(ref, control, visible);
    items.push(item);
    // Only options the model was shown can be chosen; a truncated list hides the rest.
    if (Array.isArray(item.options)) registry.shownOptions.set(element, new Set((interactive ? item.options : control.options).map((option) => option.value)));
    // The real value the agent last observed: actions are refused if the page or person changed it since.
    registry.snapshots.set(element, JSON.stringify(describe(element, true)));
    if (!interactive) elements.push({ ref, ...control, visible, needsReveal: left > rect.left || top > rect.top || right < rect.right || bottom < rect.bottom, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }
  for (const [ref, weak] of registry.byRef) if (!weak.deref()?.isConnected) registry.byRef.delete(ref);
  registry.describe = describe;
  registry.optionRef = optionRef;
  registry.identify = identify;
  registry.observations.set(id, { createdAt: performance.now(), width: innerWidth, height: innerHeight, x: scrollX, y: scrollY });
  registry.latest = id;
  for (const old of registry.observations.keys()) { if (registry.observations.size <= 20) break; registry.observations.delete(old); }
  // Observing the same document again reports what changed since the last
  // unfiltered observation in this mode, so the model need not reread it.
  let diff;
  if (!query) {
    const current = new Map(items.map((item) => [item.ref, JSON.stringify(item)]));
    const previous = registry.last?.mode === mode ? registry.last.items : null;
    if (previous) {
      const added = [...current.keys()].filter((ref) => !previous.has(ref));
      const changed = [...current.keys()].filter((ref) => previous.has(ref) && previous.get(ref) !== current.get(ref));
      diff = { added, removed: [...previous.keys()].filter((ref) => !current.has(ref)), changed, unchanged: current.size - added.length - changed.length };
    }
    registry.last = { mode, items: current };
  }
  const focused = registry.byElement.get(document.activeElement);
  const signIn = [...candidates].some((element) => {
    if (!(element instanceof HTMLElement) || !isSensitive(element)) return false;
    const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
  });
  const page = { viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, hasPasswordField: signIn };
  if (!interactive) {
    return { truncated, scrollRegions, title: text(document.title, 300), ...(includeText ? { text: text(document.body?.innerText, 16000) } : {}), elements,
      ...page, ...(diff ? { diff } : {}), ...(focused ? { focused } : {}),
      webmcp: "modelContext" in document ? "available" : "check_site_tools",
      limitations: ["DOM references cover the top document and open controls; use a fresh image for frames or canvas."] };
  }
  const shown = diff ? items.filter((item) => diff.added.includes(item.ref) || diff.changed.includes(item.ref)) : items;
  const status = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output')]
    .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0)
    .map((element) => text(element instanceof HTMLElement ? element.innerText : "", 300)).filter(Boolean).slice(0, 5);
  return { mode, title: text(document.title, 300), elements: shown, ...(diff ? { diff } : {}), ...(focused ? { focused } : {}),
    ...(status.length ? { status } : {}), ...(truncated ? { truncated } : {}), ...(includeText ? { text: text(document.body?.innerText, 16000) } : {}),
    ...page, ...("modelContext" in document ? { webmcp: "available" } : {}) };
}
// Records when the document last changed structure. Text-only changes (live
// counters, clocks) are ignored; elements appearing, disappearing, showing,
// hiding or turning busy are not.
function readSettle(arm) {
  let state = globalThis.__openworkBrowserSettle;
  if (!state) {
    state = globalThis.__openworkBrowserSettle = { at: performance.now() };
    new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE))) state.at = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "disabled", "aria-busy", "aria-hidden", "open"] });
  }
  if (arm) state.at = performance.now();
  return { quietMs: performance.now() - state.at, readyState: document.readyState, busy: !!document.querySelector('[aria-busy="true"]') };
}
function prepareAction(id, action) {
  const registry = globalThis.__openworkBrowserRefs;
  const observation = registry?.observations.get(id);
  if (!observation) throw new Error("stale_observation");
  // Image coordinates are only meaningful for the latest, unchanged view.
  if (action.type === "click" && !action.ref && (registry.latest !== id || performance.now() - observation.createdAt > 60_000
    || observation.width !== innerWidth || observation.height !== innerHeight || observation.x !== scrollX || observation.y !== scrollY)) throw new Error("stale_observation");
  const element = action.ref ? registry.byRef.get(action.ref)?.deref() : null;
  if (action.ref && (!element || !element.isConnected)) throw new Error("stale_element");
  const control = element ? registry.describe(element) : null;
  // The control must still be what the model saw: same kind and name.
  if (element && registry.identities.get(element) !== registry.identify(element, control)) throw new Error("stale_element");
  if (element?.matches('input[type="password"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  if (control?.disabled) throw new Error("element_disabled");
  if (action.type === "key") {
    if (element && document.activeElement !== element) element.focus();
    if (element && document.activeElement !== element) throw new Error("unverifiable_focus");
    if (document.activeElement?.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
    // Only a directly focused, observed control can receive keys. Frames and
    // generic containers can conceal a different focused descendant.
    if (!document.activeElement?.matches('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="listbox"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"]')
      || !registry.byElement.has(document.activeElement)) throw new Error("unverifiable_focus");
  }
  // Bind the action to what the agent observed: a value changed by the page or
  // person since then needs a fresh observation.
  const target = element || (action.type === "key" ? document.activeElement : null);
  if (target && registry.snapshots.get(target) !== JSON.stringify(registry.describe(target, true))) throw new Error("stale_observation");
  let x = action.x, y = action.y;
  if (element) {
    const style = getComputedStyle(element);
    let rect = element.getBoundingClientRect();
    if (style.visibility !== "visible" || style.display === "none" || !rect.width || !rect.height) throw new Error("stale_element");
    // Bring an observed control into view instead of asking for a scroll and
    // another observation; the hit test below still guards what is clicked.
    if (action.type === "reveal" || rect.x + rect.width / 2 < 0 || rect.y + rect.height / 2 < 0 || rect.x + rect.width / 2 >= innerWidth || rect.y + rect.height / 2 >= innerHeight) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      rect = element.getBoundingClientRect();
    }
    x = rect.x + rect.width / 2; y = rect.y + rect.height / 2;
    if (action.type !== "reveal" && (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) throw new Error("element_outside_viewport");
    const hit = document.elementFromPoint(x, y);
    if (action.type !== "reveal" && (!hit || (hit !== element && !element.contains(hit)))) throw new Error("element_obscured");
  }
  if (action.type === "reveal" && !element) throw new Error("stale_element");
  if (action.type === "fill") {
    const editable = element instanceof HTMLTextAreaElement || element?.isContentEditable || (element instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "number", "date", "time", "datetime-local", "month", "week"].includes(element.type));
    if (!editable || control.readOnly) throw new Error("not_editable");
  }
  if (action.type === "select") {
    if (!(element instanceof HTMLSelectElement) || (!element.multiple && action.values.length > 1)) throw new Error("not_selectable");
    for (const value of action.values) {
      // Option refs are opaque, belong to this control and must have been shown.
      if (!registry.shownOptions.get(element)?.has(value)) throw new Error("option_unavailable");
      const option = [...element.options].find(option => registry.optionRefs.get(option)?.ref === value && registry.optionRefs.get(option)?.value === option.value);
      if (!option || option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) throw new Error("option_unavailable");
    }
  }
  if (action.type === "set_checked") {
    const native = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type);
    if ((!native && !["checkbox", "radio", "switch"].includes(element?.getAttribute("role"))) || control.readOnly) throw new Error("not_checkable");
    if ((element.type === "radio" || element.getAttribute("role") === "radio") && !action.checked) throw new Error("not_checkable");
  }
  if ((action.type === "click" || action.type === "scroll") && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) throw new Error("outside_viewport");
  if (!element && action.type === "click") {
    const hit = document.elementFromPoint(x, y);
    if (hit?.matches('input[type="password"],input[type="file"],input[autocomplete="one-time-code"]')) throw new Error("sign_in_required");
  }
  return { x, y, unchanged: action.type === "set_checked" && control.checked === action.checked };
}
function applyFormAction(action) {
  const registry = globalThis.__openworkBrowserRefs;
  const element = registry?.byRef.get(action.ref)?.deref();
  if (!element?.isConnected) throw new Error("stale_element");
  if (registry.identities.get(element) !== registry.identify(element, registry.describe(element))) throw new Error("stale_element");
  if (registry.snapshots.get(element) !== JSON.stringify(registry.describe(element, true))) throw new Error("stale_observation");
  // The agent may read back exactly what it entered.
  if (action.type === "fill" || action.type === "select") globalThis.__openworkAgentEntered?.set(element, action.type === "select"
    ? JSON.stringify([...element.options].filter(option => action.values.includes(registry.optionRefs.get(option)?.ref)).map(option => option.value))
    : element instanceof HTMLTextAreaElement ? action.text.replace(/\r\n?/g, "\n") : action.text);
  element.focus();
  if (document.activeElement !== element || !element.isConnected) throw new Error("stale_element");
  if (action.type === "select") {
    for (const option of element.options) option.selected = action.values.includes(registry.optionRefs.get(option)?.ref);
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
async function verifyFormAction(action) {
  const registry = globalThis.__openworkBrowserRefs;
  const element = registry?.byRef.get(action.ref)?.deref();
  const deadline = performance.now() + 1500;
  let matchingSince = null, control;
  do {
    if (!element?.isConnected) throw new Error("stale_element");
    control = registry.describe(element, true);
    const matches = action.type === "set_checked" ? control.checked === action.checked
      : action.type === "select" ? control.selectedValues.length === new Set(action.values).size && action.values.every(value => control.selectedValues.includes(value))
      : !control.valueTruncated && control.value === (element instanceof HTMLTextAreaElement ? action.text.replace(/\r\n?/g, "\n") : action.text);
    matchingSince = matches ? matchingSince ?? performance.now() : null;
    if (matchingSince !== null && performance.now() - matchingSince >= 150) {
      // The agent's own verified entry is what it now knows; later actions in a batch bind to it.
      registry.snapshots.set(element, JSON.stringify(control));
      return { verified: true, control: registry.describe(element) };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  // A rejected or transformed entry can restore a value filled by the page or
  // person. Only the exact requested value remains eligible for readback.
  if (!element.isConnected) throw new Error("stale_element");
  return { verified: false, control: registry.describe(element) };
}
async function captureObservation(webContents, viewport, hostCapture = undefined) {
  if (typeof webContents.captureObservation === "function") return webContents.captureObservation(viewport);
  const captured = await hostCapture?.(viewport);
  if (captured) return captured;
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STOP_WORDS = new Set("a an and are as at be by can did do does for from has have how i in is it its me my of on or should that the their there this to was what when where which who why will with you your".split(" "));
// Word forms such as block, blocker and blocking: a shared stem of five
// letters, or four when one word is the other's prefix.
const related = (a, b) => {
  let shared = 0;
  while (shared < a.length && a[shared] === b[shared]) shared++;
  return shared >= 5 || shared >= 4 && (a.length === shared || b.length === shared);
};
const terms = (value) => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => (term.length > 1 || /\d/.test(term)) && !STOP_WORDS.has(term));
/**
 * Lines of page text that best match the question, in page order, within a
 * character budget. A label line ("Total:") brings the line that follows (its value).
 * @param {string} text @param {string} question @param {number} maxChars
 */
function relevantPassages(text, question, maxChars) {
  const lines = text.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const wanted = [...new Set(terms(question))];
  if (!wanted.length || !lines.length) return [];
  const lineTerms = lines.map((line) => new Set(terms(line)));
  const weight = new Map(wanted.map((term) => [term, Math.log(1 + lines.length / (1 + lineTerms.filter((set) => set.has(term)).length))]));
  const scored = lines.map((_, index) => {
    let score = 0;
    for (const term of wanted) {
      if (lineTerms[index].has(term)) score += weight.get(term) ?? 0;
      else if (term.length >= 4 && [...lineTerms[index]].some((word) => related(term, word))) score += (weight.get(term) ?? 0) / 2;
    }
    return { index, score };
  }).filter((line) => line.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = new Set();
  let used = 0;
  for (const { index } of scored) {
    if (used >= maxChars) break;
    const label = /:$/.test(lines[index]) || lines[index].length <= 25;
    for (const at of label && index + 1 < lines.length ? [index, index + 1] : [index]) {
      if (chosen.has(at)) continue;
      chosen.add(at); used += Math.min(lines[at].length, 600) + 1;
    }
  }
  const passages = [];
  let previous = -2;
  for (const index of [...chosen].sort((a, b) => a - b)) {
    const line = lines[index].length > 600 ? `${lines[index].slice(0, 600)}…` : lines[index];
    if (index === previous + 1 && passages.length) passages[passages.length - 1] += `\n${line}`;
    else passages.push(line);
    previous = index;
  }
  let total = 0;
  return passages.filter((passage) => (total += passage.length) <= maxChars || total === passage.length);
}

/**
 * `prepare` runs before each operation on a tab and may settle its viewport.
 * A host that draws the page scaled reports that scale in `inputScale`, since
 * CDP input is in view pixels, and may `capture` the page at full resolution.
 */
export function createBrowserTaskHost({ getTab, tabsFor, ownerOf, activeFor, isVisible, openTab, navigate,
  allowed, enabled, changed, siteTools, runSiteTool, beforeInput = async (_tab) => {}, inFlight = (_tab, _since) => 0,
  prepare = async (_tab) => {}, inputScale = (_tab) => 1, capture = (_tab, _viewport) => null }) {
  const states = new Map();
  // request_id -> first receipt, per conversation: a retried act never replays input.
  const receipts = new Map();
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
    for (const tab of tabsFor(sessionId)) forget(states.get(tab.tabId));
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
    if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control until they resume it or send their next message.");
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
    if (!states.has(tabId)) states.set(tabId, { status: "idle", operation: null, observations: new Map(), latest: null, controller: null });
    return states.get(tabId);
  }
  // Observations last for one document; navigation and takeover end them.
  function forget(state) {
    if (!state) return;
    state.observations.clear();
    state.latest = null;
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
      const sibling = states.get(item.tabId); sibling?.controller?.abort(); forget(sibling); publish(item.tabId, "paused", reason);
    }
    const state = stateFor(tabId); forget(state);
    state.controller?.abort(new BrowserTaskError("paused", "Browser control paused. It comes back when the user resumes it or sends their next message."));
    publish(tabId, "paused", reason);
  }
  function resume(tabId) {
    const owner = ownerOf(tabId);
    if (tabsFor(owner).some((item) => stateFor(item.tabId).controller)) return;
    pausedSessions.delete(owner);
    for (const item of tabsFor(owner)) {
      if (navigations.has(item.tabId)) trackNavigation(owner, item);
      forget(stateFor(item.tabId)); publish(item.tabId, "idle");
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
    forget(state);
    if (closed) { state.controller?.abort(); states.delete(tabId); }
  }
  /**
   * @param {{ mode?: string, limit?: number, includeText?: boolean }} [options]
   */
  async function observe(tab, includeImage, signal, query = null, options = {}) {
    const state = stateFor(tab.tabId);
    const revision = tab.webMcpRevision;
    const url = tab.view.webContents.getURL();
    const id = randomUUID();
    const mode = options.mode === "interactive" ? "interactive" : "full";
    const limit = Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 500 ? options.limit : undefined;
    const page = await isolated(tab.view.webContents, observePage, id, { mode, query: query ?? null, ...(limit ? { limit } : {}),
      ...(typeof options.includeText === "boolean" ? { includeText: options.includeText } : {}) });
    let image, digest;
    if (includeImage) {
      if (page.hasPasswordField) fail("sign_in_required", "This page contains protected sign-in or payment fields. Take over and complete them directly in the browser, then resume.");
      const png = await captureObservation(tab.view.webContents, page.viewport, (viewport) => capture(tab, viewport));
      digest = imageDigest(png);
      image = { mimeType: "image/png", data: png.toString("base64"), width: page.viewport.width, height: page.viewport.height };
    }
    if (!await allowed(url)) fail("website_blocked", "Your organization does not allow this website.");
    if (revision !== tab.webMcpRevision || url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed during observation. Observe again.");
    signal.throwIfAborted();
    // Every observation of this document stays usable while its refs resolve.
    const record = { id, revision, url, viewport: page.viewport, digest, sent: new Set() };
    if (state.latest && (state.latest.revision !== revision || state.latest.url !== url)) state.observations.clear();
    state.observations.set(id, record); state.latest = record;
    for (const old of state.observations.keys()) { if (state.observations.size <= 20) break; state.observations.delete(old); }
    if (mode === "interactive") {
      const { hasPasswordField, viewport: _viewport, scroll: _scroll, ...compact } = page;
      return { ok: true, tabId: tab.tabId, observationId: id, url: safeUrl(url), trust: TRUST, ...compact, ...(hasPasswordField ? { signIn: "take_over" } : {}), ...(image ? { image } : {}) };
    }
    return { ok: true, tabId: tab.tabId, observationId: id, url: safeUrl(url), trust: TRUST, ...page, ...(image ? { image } : {}) };
  }
  /** Bounded wait after input: navigation, in-flight requests and DOM structure. */
  async function settle(tab, observed, since, signal) {
    const contents = tab.view.webContents;
    const deadline = Date.now() + SETTLE_MS;
    let navigated = false;
    for (;;) {
      signal.throwIfAborted();
      if (contents.isDestroyed()) fail("tab_closed", "The browser tab closed after the action.");
      navigated ||= tab.webMcpRevision !== observed.revision || contents.getURL() !== observed.url;
      const loading = typeof contents.isLoading === "function" && contents.isLoading();
      const requests = inFlight(tab, since);
      // A document between navigations may not answer; treat that as loading.
      const page = loading ? null : await Promise.race([isolated(contents, readSettle, false).catch(() => null), delay(500).then(() => null)]);
      if (page && requests === 0 && page.readyState !== "loading" && !page.busy && page.quietMs >= QUIET_MS) return { outcome: navigated ? "navigated" : "settled", navigated };
      if (Date.now() >= deadline) return { outcome: "still_loading", navigated };
      await delay(50);
    }
  }
  async function extract(tab, args, signal) {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question || question.length > 1000) fail("invalid_question", "Ask one question of at most 1000 characters.");
    const maxChars = Number.isInteger(args.maxChars) ? Math.min(8000, Math.max(200, args.maxChars)) : 2000;
    const revision = tab.webMcpRevision;
    const url = tab.view.webContents.getURL();
    // Withheld field values are redacted exactly as observations redact them.
    const page = await isolated(tab.view.webContents, observePage, null, { mode: "extract" });
    if (!await allowed(url)) fail("website_blocked", "Your organization does not allow this website.");
    if (revision !== tab.webMcpRevision || url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed while reading it. Try again.");
    signal.throwIfAborted();
    const passages = relevantPassages(page.text, question, maxChars);
    return { ok: true, tabId: tab.tabId, url: safeUrl(url), title: page.title, trust: TRUST, question, passages, pageChars: page.text.length,
      ...(passages.length ? {} : { next: "No passage matched. Try other words, or browser_observe with includeText." }) };
  }
  /**
   * @typedef {{ type?: string, ref?: string, text?: string, checked?: boolean, values?: string[], key?: string, modifiers?: string[], x?: number, y?: number, deltaY?: number }} BrowserAction
   * @param {{ sessionId?: string, operation?: string, args?: { tabId?: string, url?: string, provider?: string, includeImage?: boolean, mode?: string, limit?: number, includeText?: boolean,
   *   query?: {role?: string, name?: string, text?: string, exact?: boolean}, observationId?: string, toolId?: string, input?: unknown, question?: string, maxChars?: number,
   *   action?: BrowserAction, actions?: BrowserAction[], request_id?: string } }} request
   * @param {{ signal?: AbortSignal }} options
   */
  async function request({ sessionId, operation, args = {} } = {}, { signal } = {}) {
    let tab, state, dispatched = false, abort, controller, openingController;
    /** @type {{ id: string, input: string, receipt: Record<string, unknown> } | null} */
    let entry = null;
    try {
      if (typeof sessionId !== "string" || !sessionId.trim()) fail("missing_session", "Browser control requires a requesting conversation.");
      if (!enabled()) fail("browser_disabled", "Enable OpenWork Browser in Library, or ask your organization to allow browser control.");
      if (operation === "tabs") return { ok: true, provider: "builtin", externalBrowsers: "unsupported", tabs: tabsFor(sessionId).map((item) => ({ tabId: item.tabId, url: safeUrl(item.view.webContents.getURL()), title: item.view.webContents.getTitle().slice(0, 300), visible: isVisible(item.tabId), status: stateFor(item.tabId).status, operation: stateFor(item.tabId).operation })) };
      if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control until they resume it or send their next message. End your turn and wait.");
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
        if (pausedSessions.has(sessionId)) fail("paused", "The user has browser control until they resume it or send their next message. End your turn and wait.");
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
      if (pausedSessions.has(sessionId) || state.status === "paused") fail("paused", "The user has browser control until they resume it or send their next message. End your turn and wait.");
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
        await prepare(tab);
        requestSignal.throwIfAborted();
        publish(tab.tabId, "running", operation);
        if (operation === "observe") return observe(tab, args.includeImage === true, requestSignal, args.query, { mode: args.mode, limit: args.limit, includeText: args.includeText });
        if (operation === "site_tools") return siteTools({ tabId: tab.tabId, sessionId });
        if (operation === "site_tool") {
          forget(state);
          dispatched = true;
          const result = await runSiteTool({ ...args, tabId: tab.tabId, sessionId }, { signal: requestSignal });
          dispatched = result.dispatched === true || result.mayHaveChangedState === true;
          return result;
        }
        if (operation === "navigate") {
          const url = browserTaskUrl(args.url);
          const validate = await authorizeNavigation(navigationScope, url.href);
          validate();
          forget(state); dispatched = true;
          const stop = () => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.stop(); };
          requestSignal.addEventListener("abort", stop, { once: true });
          try { await navigate(tab, url.href); requestSignal.throwIfAborted(); }
          finally { requestSignal.removeEventListener("abort", stop); }
          return { ok: true, tabId: tab.tabId, dispatched: true, outcome: "navigation_finished", url: safeUrl(tab.view.webContents.getURL()), next: "observe" };
        }
        if (operation === "extract") return extract(tab, args, requestSignal);
        if (operation !== "act") fail("unknown_operation", "Use a supported browser operation.");
        // One action keeps the original receipt; actions (1-8) run in order
        // against one observation and return one receipt with the new state.
        const batch = args.actions !== undefined;
        if (batch === (args.action !== undefined)) fail("invalid_action", "Provide exactly one of action or actions.");
        const actions = structuredClone(batch ? args.actions : [args.action]);
        if (!Array.isArray(actions) || actions.length < 1 || actions.length > 8) fail("invalid_action", "Provide one to eight actions.");
        // At most once: a repeated request_id returns its first receipt.
        if (args.request_id !== undefined) {
          if (typeof args.request_id !== "string" || !args.request_id || args.request_id.length > 256) fail("invalid_action", "request_id must be a short string.");
          const input = JSON.stringify([tab.tabId, args.observationId, actions]);
          const previous = receipts.get(sessionId)?.get(args.request_id);
          if (previous) {
            if (previous.input !== input) fail("request_conflict", "This request_id already belongs to different input. Nothing was dispatched.");
            return previous.receipt;
          }
          entry = { id: args.request_id, input, receipt: { ok: false, code: "dispatch_uncertain", error: "This request was interrupted after it may have sent input. Observe before continuing; it is never replayed.",
            dispatched: true, mayHaveChangedState: true, retrySafe: false, next: "observe", request_id: args.request_id } };
        }
        const observed = state.observations.get(args.observationId);
        if (!observed || observed.revision !== tab.webMcpRevision || observed.url !== tab.view.webContents.getURL()) fail("stale_observation", "Observe the current page before acting.");
        const keys = new Map();
        for (const [index, action] of actions.entries()) {
          if (!action || typeof action !== "object" || !ACTION_TYPES.includes(action.type)) fail("invalid_action", "Use click, fill, select, set_checked, key or scroll.");
          if (action.ref !== undefined && (typeof action.ref !== "string" || !action.ref || action.ref.length > 64)) fail("invalid_action", "Use a ref from an observation of this page.");
          if (action.type === "click" && !action.ref) {
            if (index > 0) fail("invalid_action", "An image-coordinate click can only be the first action. Use refs for later steps.");
            if (!observed.digest || state.latest !== observed) fail("image_required", "Observe with includeImage before clicking image coordinates.");
          }
          if (action.type === "fill" && (typeof action.text !== "string" || action.text.length > 8000 || !action.ref)) fail("invalid_action", "Fill needs an observed editable reference and text of at most 8000 characters.");
          if (action.type === "select" && (!action.ref || !Array.isArray(action.values) || action.values.length > 200 || !action.values.every(value => typeof value === "string" && value.length <= 8000))) fail("invalid_action", "Select needs an observed select reference and an array of option values.");
          if (action.type === "set_checked" && (!action.ref || typeof action.checked !== "boolean")) fail("invalid_action", "Set_checked needs an observed checkbox, radio or switch reference and checked true or false.");
          if (action.type === "reveal" && !action.ref) fail("invalid_action", "Reveal needs an observed reference.");
          if (action.type === "key") keys.set(index, resolveKey(action));
          if (action.type === "scroll" && (!Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 1200)) fail("invalid_scroll", "Scroll distance must be between -1200 and 1200.");
        }
        // A click or key already sent from this observation is not sent again
        // from it: the page may have acted on the first one.
        const signature = (action, index) => ["click", "key"].includes(action.type)
          ? JSON.stringify([action.type, action.ref ?? null, action.x ?? null, action.y ?? null, keys.get(index)?.chord ?? null]) : null;
        if (actions.some((action, index) => observed.sent.has(signature(action, index)))) {
          fail("repeat_requires_observe", "That click or key was already sent from this observation. Observe to confirm the page before repeating it; nothing was dispatched.");
        }
        if (!await allowed(observed.url) || state.observations.get(observed.id) !== observed || observed.revision !== tab.webMcpRevision || observed.url !== tab.view.webContents.getURL()) fail("page_changed", "The page changed or access was blocked while preparing the action. Observe again.");
        requestSignal.throwIfAborted();
        if (actions[0].type === "click" && !actions[0].ref && imageDigest(await captureObservation(tab.view.webContents, observed.viewport, (viewport) => capture(tab, viewport))) !== observed.digest) fail("stale_observation", "The image changed. Observe again before choosing coordinates.");
        if (actions.some((action) => ["fill", "select", "reveal"].includes(action.type))) {
          // DOM-backed form edits must release the same native input lease as
          // keyboard and pointer events on the shared cloud desktop.
          await beforeInput(tab);
          requestSignal.throwIfAborted();
        }
        if (entry) {
          const stored = receipts.get(sessionId) ?? new Map();
          receipts.set(sessionId, stored);
          stored.set(entry.id, entry);
          for (const old of stored.keys()) { if (stored.size <= 64) break; stored.delete(old); }
        }
        const contents = tab.view.webContents;
        const steps = [];
        let failure = null, page = null, interrupted = null;
        for (const [index, action] of actions.entries()) {
          checkNavigation(navigationScope);
          if (state.observations.get(observed.id) !== observed || observed.revision !== tab.webMcpRevision || observed.url !== contents.getURL()) {
            if (!steps.length) fail("stale_observation", "The page or observation changed while preparing the action. Observe again.");
            interrupted = "page_changed";
            break;
          }
          let point;
          try { point = await isolated(contents, prepareAction, observed.id, action); }
          catch (error) {
            const code = PREPARE_CODES.find((item) => String(error?.message).includes(item));
            if (!code) throw error;
            const message = code === "unverifiable_focus" ? "Keyboard input requires a directly focused observed page control. Pass the control's ref or click it first."
              : code === "sign_in_required" ? "Take over and sign in directly in the browser, then resume."
              : "The observed control is no longer ready. Observe again before choosing an action.";
            if (!batch) fail(code, message);
            failure = { index, type: action.type, ...(action.ref ? { ref: action.ref } : {}), code, error: message };
            break;
          }
          checkNavigation(navigationScope);
          requestSignal.throwIfAborted();
          publish(tab.tabId, "running", action.type);
          if (!point.unchanged) dispatched = true;
          const sent = signature(action, index);
          if (sent) observed.sent.add(sent);
          const since = Date.now();
          if (["click", "key", "scroll"].includes(action.type)) await isolated(contents, readSettle, true).catch(() => null);
          if (action.type === "fill" || action.type === "select") {
            const prepared = await isolated(contents, applyFormAction, action);
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
            // Chromium's input router hit-tests these observed CSS pixels,
            // converted to view pixels when the page is drawn scaled.
            const cdp = contents.debugger;
            const attached = !cdp.isAttached();
            if (attached) cdp.attach("1.3");
            try {
              const scale = inputScale(tab);
              const x = point.x * scale, y = point.y * scale;
              if (action.type === "scroll") {
                await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: action.deltaY * scale });
              } else {
                await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
                requestSignal.throwIfAborted();
                await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
              }
            } finally {
              if (attached && cdp.isAttached()) cdp.detach();
            }
          }
          if (action.type === "key") {
            const key = keys.get(index);
            if (key.edit && typeof contents[key.edit] === "function") contents[key.edit]();
            else {
              await contents.sendInputEvent({ type: "keyDown", keyCode: key.keyCode, modifiers: key.modifiers });
              requestSignal.throwIfAborted();
              await contents.sendInputEvent({ type: "keyUp", keyCode: key.keyCode, modifiers: key.modifiers });
            }
          }
          if (["fill", "select", "set_checked"].includes(action.type)) {
            const result = await isolated(contents, verifyFormAction, action);
            requestSignal.throwIfAborted();
            if (!batch) {
              return { ok: result.verified, dispatched, mayHaveChangedState: dispatched, outcome: result.verified ? "verified" : "value_mismatch", retrySafe: false,
                ...(result.verified ? {} : { code: "value_mismatch", error: "The control did not retain the requested value. Observe its current state before deciding how to continue." }),
                tabId: tab.tabId, control: result.control, next: "observe" };
            }
            if (!result.verified) {
              failure = { index, type: action.type, ref: action.ref, code: "value_mismatch", error: "The control did not retain the requested value.", control: result.control };
              break;
            }
            steps.push({ i: index, type: action.type, ref: action.ref, outcome: point.unchanged ? "unchanged" : "verified" });
            continue;
          }
          if (action.type === "reveal") {
            if (!batch) return { ok: true, dispatched: true, outcome: "revealed", retrySafe: false, tabId: tab.tabId, next: "observe" };
            steps.push({ i: index, type: action.type, ref: action.ref, outcome: "revealed" });
            continue;
          }
          page = await settle(tab, observed, since, requestSignal);
          if (!batch) return { ok: true, dispatched: true, outcome: page.outcome, ...(page.navigated ? { navigated: true } : {}), retrySafe: false, tabId: tab.tabId, next: "observe" };
          steps.push({ i: index, type: action.type, ...(action.ref ? { ref: action.ref } : {}), outcome: page.outcome });
          if (page.navigated) { interrupted = "navigated"; break; }
        }
        // The receipt carries the resulting page so the model need not observe again.
        let observation;
        try {
          const { ok: _ok, tabId: _tabId, trust: _trust, ...post } = await observe(tab, false, requestSignal, null, { mode: "interactive" });
          observation = post;
        } catch (error) {
          if (requestSignal.aborted) throw error;
          observation = { ok: false, code: error instanceof BrowserTaskError ? error.code : "observation_unavailable", error: "The resulting page could not be read. Observe before continuing." };
        }
        const completed = steps.length, failed = failure ? 1 : 0, skipped = actions.length - completed - failed;
        const receipt = { ok: !failure, tabId: tab.tabId, trust: TRUST, completed, failed, skipped,
          ...(failure ? { code: failure.code, error: failure.error, failedStep: failure } : {}),
          ...(skipped && interrupted ? { skippedBecause: interrupted } : {}),
          steps, ...(page ? { page: page.outcome } : {}), dispatched, mayHaveChangedState: dispatched, retrySafe: false,
          ...(entry ? { request_id: entry.id } : {}), observation,
          next: failure ? "Read observation, then fix or replan the failed step; completed steps are not repeated." : skipped ? "The page changed; plan the skipped steps from observation." : "Verify the result in observation; act on it directly." };
        if (entry) entry.receipt = receipt;
        return receipt;
      };
      const result = await Promise.race([run(), canceled]);
      requestSignal.throwIfAborted();
      if (state.status !== "paused") publish(tab.tabId, result.ok ? "idle" : "needs_attention", result.ok ? null : result.code);
      return result;
    } catch (error) {
      // Refs stay usable after a refused action; after input, the page may differ.
      if (state && state.controller === controller && (dispatched || !(error instanceof BrowserTaskError))) forget(state);
      if (entry && !dispatched && receipts.get(sessionId)?.get(entry.id) === entry) receipts.get(sessionId)?.delete(entry.id);
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
