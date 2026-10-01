import { CloudBrowserError } from "./contract"
import { isRecord } from "./cdp"

/**
 * Limits and action shapes shared with the desktop browser task host
 * (apps/desktop/electron/browser-task.mjs) and its tool contract
 * (apps/server/src/opencode-plugins/openwork-chrome-devtools.ts).
 */
export const LIMITS = {
  /** An observation's refs are honored this long. */
  observationMs: 15_000,
  /** Upper bound for one observe/act/navigate call. */
  operationMs: 30_000,
  /** How long a navigation waits for the load event before returning. */
  loadWaitMs: 15_000,
  textChars: 16_000,
  elements: 200,
  fillChars: 8_000,
  scrollDelta: 1_200,
  /** Take-over input: characters per text event and events per request. */
  inputText: 2_000,
  inputEvents: 32,
} as const

export const BROWSER_KEYS = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Space"] as const
export type BrowserKeyName = (typeof BROWSER_KEYS)[number]

/** Keys a person can press during take-over: the agent's keys plus editing and paging keys. */
export const TAKEOVER_KEYS = [...BROWSER_KEYS, "Delete", "Home", "End", "PageUp", "PageDown"] as const
export type TakeoverKeyName = (typeof TAKEOVER_KEYS)[number]

export type BrowserAction =
  | { type: "click"; ref?: string; x?: number; y?: number }
  | { type: "fill"; ref: string; text: string }
  | { type: "key"; key: BrowserKeyName }
  | { type: "scroll"; deltaY: number; x?: number; y?: number }

/** Take-over input from the person, in viewport CSS pixels. */
export type HumanInputEvent =
  | { type: "click"; x: number; y: number; clickCount?: number }
  | { type: "wheel"; x: number; y: number; deltaX?: number; deltaY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: TakeoverKeyName }

export type KeyDefinition = { key: string; code: string; keyCode: number; text?: string }

export const KEY_DEFINITIONS: Record<TakeoverKeyName, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((entry) => entry === value)
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function invalid(message: string): CloudBrowserError {
  return new CloudBrowserError("invalid_action", message)
}

/** Checks one agent action before anything reaches the browser. */
export function validateAction(value: unknown): BrowserAction {
  if (!isRecord(value)) throw invalid("Use click, fill, key or scroll.")
  const ref = value.ref
  if (ref !== undefined && (typeof ref !== "string" || !/^e\d{1,4}$/.test(ref))) {
    throw invalid("Use an element ref from the latest observation, such as e12.")
  }
  switch (value.type) {
    case "click": {
      if (typeof ref === "string") return { type: "click", ref }
      if (finite(value.x) && finite(value.y)) return { type: "click", x: value.x, y: value.y }
      throw invalid("Click needs an observed ref, or x and y viewport coordinates from the observation image.")
    }
    case "fill": {
      if (typeof ref !== "string") throw invalid("Fill needs an observed editable ref.")
      if (typeof value.text !== "string" || value.text.length > LIMITS.fillChars) {
        throw invalid(`Fill needs text of at most ${LIMITS.fillChars} characters.`)
      }
      return { type: "fill", ref, text: value.text }
    }
    case "key": {
      if (!isOneOf(BROWSER_KEYS, value.key)) {
        throw invalid("Use Enter, Tab, Escape, an arrow key, Backspace or Space. Shortcuts are unavailable.")
      }
      return { type: "key", key: value.key }
    }
    case "scroll": {
      if (!finite(value.deltaY) || Math.abs(value.deltaY) > LIMITS.scrollDelta) {
        throw invalid(`Scroll distance must be between -${LIMITS.scrollDelta} and ${LIMITS.scrollDelta}.`)
      }
      if (finite(value.x) && finite(value.y)) return { type: "scroll", deltaY: value.deltaY, x: value.x, y: value.y }
      return { type: "scroll", deltaY: value.deltaY }
    }
    default:
      throw invalid("Use click, fill, key or scroll.")
  }
}

const VIEWPORT_LIMIT = 10_000

function coordinate(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= VIEWPORT_LIMIT
}

/** Checks a batch of take-over events from the person's live view. */
export function validateHumanInput(value: unknown): HumanInputEvent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.inputEvents) {
    throw invalid(`Send between 1 and ${LIMITS.inputEvents} input events.`)
  }
  return value.map((event): HumanInputEvent => {
    if (!isRecord(event)) throw invalid("Each input event needs a type.")
    if (event.type === "click" && coordinate(event.x) && coordinate(event.y)) {
      const clickCount = finite(event.clickCount) ? Math.min(3, Math.max(1, Math.round(event.clickCount))) : 1
      return { type: "click", x: event.x, y: event.y, clickCount }
    }
    if (event.type === "wheel" && coordinate(event.x) && coordinate(event.y) && finite(event.deltaY) && Math.abs(event.deltaY) <= LIMITS.scrollDelta) {
      const deltaX = finite(event.deltaX) && Math.abs(event.deltaX) <= LIMITS.scrollDelta ? event.deltaX : 0
      return { type: "wheel", x: event.x, y: event.y, deltaX, deltaY: event.deltaY }
    }
    if (event.type === "text" && typeof event.text === "string" && event.text.length > 0 && event.text.length <= LIMITS.inputText) {
      return { type: "text", text: event.text }
    }
    if (event.type === "key" && isOneOf(TAKEOVER_KEYS, event.key)) return { type: "key", key: event.key }
    throw invalid("Unsupported input event.")
  })
}
