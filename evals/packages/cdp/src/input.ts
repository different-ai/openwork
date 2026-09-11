import { callFunctionOnSurface, evaluateOnSurface } from "./surface.ts";
import type { Surface } from "./surface.ts";

export type TargetRole = "button" | "link" | "textbox" | "checkbox" | "switch" | "menuitem" | "tab" | "option" | "separator";
export type TargetMatcher = string | RegExp;

export type Target = string | {
  text?: TargetMatcher;
  role?: TargetRole;
  label?: TargetMatcher;
  placeholder?: string;
  testId?: string;
  nth?: number;
};

export interface Point {
  x: number;
  y: number;
}

export interface Located {
  center: Point;
  rect: { x: number; y: number; width: number; height: number };
  tag: string;
  name: string;
  visible: boolean;
  hitTestOk: boolean;
  editable: boolean;
  value: string;
  text: string;
  covering: { tag: string; text: string; role: string } | null;
}

/** Read-only DOM geometry and focus; deliberately excludes input values and attributes. */
export async function readDom(surface: Surface, selector: string) {
  const snapshot = await callFunctionOnSurface(surface, (selector) => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    elements: Array.from(document.querySelectorAll(selector), (element) => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim() ?? "",
        focused: element === document.activeElement,
        rect: { left, right, top, bottom, width, height },
      };
    }),
  }), [selector]);
  if (!snapshot || !Number.isFinite(snapshot.viewportWidth) || !Number.isFinite(snapshot.documentWidth)
    || !Array.isArray(snapshot.elements) || !snapshot.elements.every((element) => element
      && typeof element.tag === "string" && typeof element.text === "string" && typeof element.focused === "boolean"
      && element.rect && [element.rect.left, element.rect.right, element.rect.top, element.rect.bottom, element.rect.width, element.rect.height].every(Number.isFinite))) {
    throw new Error("DOM inspection returned an invalid snapshot.");
  }
  return snapshot;
}

interface SerializedMatcher {
  kind: "string" | "regexp";
  value: string;
  flags?: string;
}

interface ParsedTarget {
  bare?: SerializedMatcher;
  text?: SerializedMatcher;
  role?: TargetRole;
  label?: SerializedMatcher;
  placeholder?: string;
  testId?: string;
  nth: number;
  composer: boolean;
}

export interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
}

function matcher(value: TargetMatcher): SerializedMatcher {
  return typeof value === "string"
    ? { kind: "string", value }
    : { kind: "regexp", value: value.source, flags: value.flags };
}

export function parseTarget(target: Target): ParsedTarget {
  if (typeof target === "string") {
    return {
      bare: matcher(target),
      nth: 0,
      composer: target.trim().toLowerCase() === "composer",
    };
  }
  return {
    text: target.text === undefined ? undefined : matcher(target.text),
    role: target.role,
    label: target.label === undefined ? undefined : matcher(target.label),
    placeholder: target.placeholder,
    testId: target.testId,
    nth: target.nth ?? 0,
    composer: false,
  };
}

const KEY_CODES: Readonly<Record<string, { code: string; virtualKeyCode: number }>> = {
  Enter: { code: "Enter", virtualKeyCode: 13 },
  Escape: { code: "Escape", virtualKeyCode: 27 },
  Tab: { code: "Tab", virtualKeyCode: 9 },
  Backspace: { code: "Backspace", virtualKeyCode: 8 },
  ArrowDown: { code: "ArrowDown", virtualKeyCode: 40 },
  ArrowUp: { code: "ArrowUp", virtualKeyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", virtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", virtualKeyCode: 39 },
  Delete: { code: "Delete", virtualKeyCode: 46 },
  Home: { code: "Home", virtualKeyCode: 36 },
  End: { code: "End", virtualKeyCode: 35 },
  PageUp: { code: "PageUp", virtualKeyCode: 33 },
  PageDown: { code: "PageDown", virtualKeyCode: 34 },
  Space: { code: "Space", virtualKeyCode: 32 },
};

const MODIFIERS: Readonly<Record<string, number>> = {
  Alt: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
};

export function mapKey(input: string): KeyDescriptor {
  const parts = input.split("+");
  const key = parts.pop()?.trim() ?? "";
  if (!key) throw new Error(`Invalid key ${JSON.stringify(input)}.`);
  let modifiers = 0;
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (modifier === undefined) throw new Error(`Unsupported modifier ${JSON.stringify(part)} in ${JSON.stringify(input)}.`);
    modifiers |= modifier;
  }
  const known = KEY_CODES[key];
  if (known) return { key: key === "Space" ? " " : key, code: known.code, windowsVirtualKeyCode: known.virtualKeyCode, modifiers };
  if (key.length !== 1) throw new Error(`Unsupported key ${JSON.stringify(key)}.`);
  const upper = key.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : key;
  return { key, code, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : null;
}

export class TargetNotFoundError extends Error {}

export async function locate(surface: Surface, target: Target): Promise<Located> {
  const parsed = JSON.stringify(parseTarget(target));
  const value = await callFunctionOnSurface(surface, (serialized) => {
    const target: ParsedTarget = JSON.parse(serialized);
    const matcher = (spec: SerializedMatcher | undefined, candidate: unknown) => {
      if (!spec) return true;
      const actual = String(candidate ?? "").trim();
      if (spec.kind === "regexp") return new RegExp(spec.value, spec.flags ?? "").test(actual);
      return actual === spec.value.trim();
    };
    const startsMatcher = (spec: SerializedMatcher | undefined, candidate: unknown) => {
      if (!spec || spec.kind !== "string") return false;
      return String(candidate ?? "").trim().toLowerCase().startsWith(spec.value.trim().toLowerCase());
    };
    const implicitRole = (element: Element) => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "select") return element instanceof HTMLSelectElement && (element.multiple || element.size > 1) ? "listbox" : "combobox";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "textarea" || (element instanceof HTMLElement && element.isContentEditable)) return "textbox";
      if (tag === "input") {
        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (!["button", "submit", "reset", "hidden", "radio"].includes(type)) return "textbox";
      }
      return "";
    };
    const associatedLabel = (element: Element) => {
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) && element.labels?.length) return [...element.labels].map((label) => label.innerText ?? label.textContent ?? "").join(" ").trim();
      const parent = element.closest("label");
      return (parent?.innerText ?? parent?.textContent ?? "").trim();
    };
    const accessibleName = (element: Element) => {
      const labelledBy = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.innerText ?? document.getElementById(id)?.textContent ?? "").join(" ").trim();
      return (element.getAttribute("aria-label") ?? "").trim()
        || labelledBy
        || associatedLabel(element)
        || (element.getAttribute("placeholder") ?? "").trim()
        || ((element instanceof HTMLElement ? element.innerText : null) ?? element.textContent ?? "").trim();
    };
    const text = (element: Element) => ((element instanceof HTMLElement ? element.innerText : null) ?? element.textContent ?? "").trim();
    const rendered = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      let current: Element | null = element;
      while (current instanceof Element) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        current = current.parentElement;
      }
      return true;
    };
    const selector = target.composer
      ? '[contenteditable="true"][data-lexical-editor="true"]'
      : target.text && !target.role && !target.label && !target.placeholder && !target.testId
        ? 'body *'
        : 'button, a[href], input, textarea, select, [role="combobox"], [role="listbox"], [contenteditable="true"], [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="tab"], [role="option"], [role="separator"], [data-testid]';
    const candidates = [...document.querySelectorAll<HTMLElement>(selector)].filter((element: Element) => {
      if (target.role && implicitRole(element) !== target.role) return false;
      if (target.placeholder !== undefined && (element.getAttribute("placeholder") ?? element.getAttribute("aria-placeholder")) !== target.placeholder) return false;
      if (target.testId !== undefined && element.getAttribute("data-testid") !== target.testId) return false;
      if (!matcher(target.label, accessibleName(element))) return false;
      return true;
    });
    let matches = candidates;
    if (target.text) {
      const exact = candidates.filter((element: Element) => matcher(target.text, text(element)))
        .filter((element: Element) => ![...element.children].some((child) => matcher(target.text, text(child))));
      if (exact.length > 0) matches = exact;
      else {
        const starts = candidates.filter((element: Element) => rendered(element) && startsMatcher(target.text, text(element)))
          .filter((element: Element) => ![...element.children].some((child) => startsMatcher(target.text, text(child))));
        matches = starts.length === 1 ? starts : [];
      }
    }
    if (target.bare && !target.composer) {
      const exact = candidates.filter((element: Element) => matcher(target.bare, accessibleName(element)));
      if (exact.length > 0) matches = exact;
      else {
        const starts = candidates.filter((element: Element) => rendered(element) && startsMatcher(target.bare, text(element)))
          .filter((element: Element) => ![...element.children].some((child) => startsMatcher(target.bare, text(child))));
        matches = starts.length === 1 ? starts : [];
      }
    }
    const element = matches[target.nth];
    if (!element) {
      const visibleCandidates = [...document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="link"]')]
        .filter(rendered)
        .slice(0, 8)
        .map((candidate) => {
          const role = implicitRole(candidate) || candidate.tagName.toLowerCase();
          return role + " " + JSON.stringify(accessibleName(candidate));
        });
      return { notFound: true, candidates: visibleCandidates };
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    let current: Element | null = element;
    let styleVisible = true;
    while (current instanceof Element) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) styleVisible = false;
      current = current.parentElement;
    }
    const inViewport = center.x >= 0 && center.y >= 0 && center.x <= innerWidth && center.y <= innerHeight;
    const hit = inViewport ? document.elementFromPoint(center.x, center.y) : null;
    const hitTestOk = Boolean(hit && (hit === element || element.contains(hit)));
    return {
      center,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      tag: element.tagName.toLowerCase(),
      name: accessibleName(element),
      visible: styleVisible && rect.width > 0 && rect.height > 0 && inViewport,
      hitTestOk,
      editable: element instanceof HTMLSelectElement ? !element.matches(":disabled") : (element instanceof HTMLElement && element.isContentEditable) || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && !element.readOnly,
      value: (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) ? element.value : (element instanceof HTMLElement && element.isContentEditable) ? element.innerText : "",
      text: ((element instanceof HTMLElement && element.isContentEditable) ? element.innerText : element.innerText ?? element.textContent ?? "").trim(),
      covering: hit && !hitTestOk ? {
        tag: hit.tagName.toLowerCase(),
        text: ((hit instanceof HTMLElement ? hit.innerText : null) ?? hit.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        role: implicitRole(hit),
      } : null,
    };
  }, [parsed]);
  if (isRecord(value) && value.notFound === true) {
    const candidates = Array.isArray(value.candidates)
      ? value.candidates.filter((candidate): candidate is string => typeof candidate === "string").slice(0, 8)
      : [];
    const candidateDetail = candidates.length > 0 ? ` Visible button/link candidates: ${candidates.join(", ")}.` : "";
    throw new TargetNotFoundError(`Could not locate ${JSON.stringify(typeof target === "string" ? target : parseTarget(target))}.${candidateDetail}`);
  }
  if (!isRecord(value) || !isRecord(value.center) || !isRecord(value.rect)) {
    throw new Error(`Could not locate ${JSON.stringify(typeof target === "string" ? target : parseTarget(target))}.`);
  }
  const x = numberField(value.center, "x");
  const y = numberField(value.center, "y");
  const rectX = numberField(value.rect, "x");
  const rectY = numberField(value.rect, "y");
  const width = numberField(value.rect, "width");
  const height = numberField(value.rect, "height");
  const covering = value.covering === null
    ? null
    : isRecord(value.covering)
      && typeof value.covering.tag === "string"
      && typeof value.covering.text === "string"
      && typeof value.covering.role === "string"
      ? { tag: value.covering.tag, text: value.covering.text, role: value.covering.role }
      : undefined;
  if (x === null || y === null || rectX === null || rectY === null || width === null || height === null
    || typeof value.tag !== "string" || typeof value.name !== "string"
    || typeof value.visible !== "boolean" || typeof value.hitTestOk !== "boolean"
    || typeof value.editable !== "boolean" || typeof value.value !== "string" || typeof value.text !== "string"
    || covering === undefined) {
    throw new Error("CDP returned invalid located-element geometry.");
  }
  return {
    center: { x, y },
    rect: { x: rectX, y: rectY, width, height },
    tag: value.tag,
    name: value.name,
    visible: value.visible,
    hitTestOk: value.hitTestOk,
    editable: value.editable,
    value: value.value,
    text: value.text,
    covering,
  };
}

export async function clickAt(
  surface: Surface,
  point: Point,
  options: { button?: "left" | "right" | "middle"; clickCount?: number } = {},
): Promise<void> {
  const button = options.button ?? "left";
  const clickCount = options.clickCount ?? 1;
  await surface.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  await surface.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount });
  await surface.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount });
}

export async function typeText(surface: Surface, text: string): Promise<void> {
  await surface.client.send("Input.insertText", { text });
}

// Synthesized CDP key events do not go through the OS keymap, so editing
// shortcuts only act on the focused field when the matching editing command is
// named explicitly.
const EDITING_COMMANDS: Record<string, string[]> = {
  "Meta+A": ["selectAll"],
  "Control+A": ["selectAll"],
  "Meta+ArrowDown": ["moveToEndOfDocument"],
  "Control+End": ["moveToEndOfDocument"],
};

export async function pressKey(surface: Surface, key: string): Promise<void> {
  const descriptor = mapKey(key);
  // Let Chrome derive native codes: Windows VK values are different macOS keys.
  const params = {
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
    modifiers: descriptor.modifiers,
  };
  const commands = EDITING_COMMANDS[key];
  await surface.client.send("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(commands ? { commands } : {}) });
  await surface.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

export async function hoverAt(surface: Surface, point: Point): Promise<void> {
  await surface.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
}

export async function reload(surface: Surface, options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  await surface.client.send("Page.reload");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluateOnSurface(surface, () => (document.readyState === 'complete'), { timeoutMs: Math.min(2_000, Math.max(1, deadline - Date.now())) }) === true) return;
    } catch {
      // Reload briefly destroys the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Page did not finish reloading within ${timeoutMs}ms.`);
}

export async function waitForLocated(
  surface: Surface,
  target: Target,
  options: { timeoutMs?: number; mustHitTest?: boolean } = {},
): Promise<Located> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let previous: Located | null = null;
  while (Date.now() < deadline) {
    try {
      // locate() centers the element on every attempt, so smooth scrolling and
      // transient overlays are re-evaluated instead of preserving stale geometry.
      const found = await locate(surface, target);
      const stable = previous && Math.abs(found.rect.x - previous.rect.x) < 0.5
        && Math.abs(found.rect.y - previous.rect.y) < 0.5
        && Math.abs(found.rect.width - previous.rect.width) < 0.5
        && Math.abs(found.rect.height - previous.rect.height) < 0.5;
      if (found.visible && (!options.mustHitTest || (found.hitTestOk && stable))) return found;
      // Hit testing alone can select a neighboring option as an animated menu moves.
      previous = found;
      const covering = found.covering
        ? ` Covered by ${found.covering.tag}${found.covering.role ? ` role=${JSON.stringify(found.covering.role)}` : ""}${found.covering.text ? ` text=${JSON.stringify(found.covering.text)}` : ""}.`
        : "";
      lastError = new Error(`Located element was visible=${found.visible}, hitTestOk=${found.hitTestOk}.${covering}`);
    } catch (error) {
      lastError = error;
      previous = null;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`Timed out after ${timeoutMs}ms locating target.${detail}`);
}

/** Require every inspection in the interval to observe a missing or hidden target. */
export async function assertAbsent(surface: Surface, target: Target, timeoutMs = 3000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Absence observation requires a positive duration");
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const found = await locate(surface, target);
      if (found.visible) throw new Error(`Target remained visible: ${JSON.stringify(target)}`);
    } catch (error) {
      if (!(error instanceof TargetNotFoundError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
}
