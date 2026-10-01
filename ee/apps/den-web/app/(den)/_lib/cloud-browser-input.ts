/**
 * Take-over input for the cloud browser live view: what a click, wheel turn or
 * key press on the displayed frame sends to POST /v1/cloud-browser/input.
 * Mirrors that route's schema (CloudBrowserInputRequest).
 */
export const TAKEOVER_KEYS = [
  "Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Backspace", "Space", "Delete", "Home", "End", "PageUp", "PageDown",
] as const;
export type TakeoverKey = (typeof TAKEOVER_KEYS)[number];

export type TakeoverEvent =
  | { type: "click"; x: number; y: number; clickCount?: number }
  | { type: "wheel"; x: number; y: number; deltaY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: TakeoverKey };

export const MAX_EVENTS_PER_REQUEST = 32;
export const MAX_TEXT_PER_EVENT = 2000;
export const MAX_WHEEL_DELTA = 1200;

type Rect = { left: number; top: number; width: number; height: number };

/** A pointer position on the displayed frame, in the remote page's viewport CSS pixels. */
export function framePoint(input: { clientX: number; clientY: number; rect: Rect; natural: { width: number; height: number } }): { x: number; y: number } | null {
  const { clientX, clientY, rect, natural } = input;
  if (rect.width <= 0 || rect.height <= 0 || natural.width <= 0 || natural.height <= 0) return null;
  const x = ((clientX - rect.left) / rect.width) * natural.width;
  const y = ((clientY - rect.top) / rect.height) * natural.height;
  if (x < 0 || y < 0 || x >= natural.width || y >= natural.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function isTakeoverKey(value: string): value is TakeoverKey {
  return TAKEOVER_KEYS.some((key) => key === value);
}

/** What a key press does during take-over; shortcuts (with Cmd or Ctrl) stay with this page. */
export function keyIntent(event: { key: string; metaKey: boolean; ctrlKey: boolean }): TakeoverEvent | null {
  if (event.metaKey || event.ctrlKey) return null;
  if (event.key === " ") return { type: "key", key: "Space" };
  if (isTakeoverKey(event.key)) return { type: "key", key: event.key };
  if ([...event.key].length === 1) return { type: "text", text: event.key };
  return null;
}

export function clampWheel(deltaY: number): number {
  return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, Math.round(deltaY)));
}

/** Pasted text as text events within the per-event limit. */
export function textEvents(text: string): TakeoverEvent[] {
  const events: TakeoverEvent[] = [];
  const characters = [...text];
  for (let start = 0; start < characters.length; start += MAX_TEXT_PER_EVENT) {
    events.push({ type: "text", text: characters.slice(start, start + MAX_TEXT_PER_EVENT).join("") });
  }
  return events;
}

/**
 * Takes the next request's worth of events off the queue, in order, merging
 * consecutive typed characters so fast typing becomes one event.
 */
export function takeBatch(queue: TakeoverEvent[]): TakeoverEvent[] {
  const batch: TakeoverEvent[] = [];
  while (queue.length > 0 && batch.length < MAX_EVENTS_PER_REQUEST) {
    const next = queue[0];
    if (!next) break;
    const last = batch[batch.length - 1];
    if (next.type === "text" && last?.type === "text" && [...last.text].length + [...next.text].length <= MAX_TEXT_PER_EVENT) {
      batch[batch.length - 1] = { type: "text", text: last.text + next.text };
    } else {
      batch.push(next);
    }
    queue.shift();
  }
  return batch;
}

/** The host a person recognizes ("app.example.com"), or null. */
export function siteHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

/** The address bar text: host and path, without the scheme. */
export function addressLabel(url: string | null): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "";
  }
}
