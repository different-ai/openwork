/**
 * Last real pictures, scoped to host identity, chat, view and (when supplied) the browser task. The tab's session
 * storage survives reload, not closing the tab. Four small images at most; task records expire after a day and live
 * view fallbacks after five minutes. Storage being unavailable/full never breaks the conversation.
 */
const PREFIX = "workbot.frame.v1:";
const MAX_AGE = 5 * 60_000;
const TASK_MAX_AGE = 24 * 60 * 60_000;
const MAX_FRAMES = 4;
type Frame = { image: string; at: number };
type FrameStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function frameKey(organization: string, principal: string, chat: string | null, view: string, task?: string) {
  return JSON.stringify(task === undefined ? [organization, principal, chat, view] : [organization, principal, chat, view, task]);
}

function maxAge(key: string) {
  try {
    const scope: unknown = JSON.parse(key);
    return Array.isArray(scope) && scope.length === 5 && typeof scope[4] === "string" ? TASK_MAX_AGE : MAX_AGE;
  } catch { return MAX_AGE; }
}
const validImage = (image: string) => image.startsWith("data:image/jpeg;base64,") && image.length <= 512_000;

/** Compare parsed scope fields, never string prefixes (chat/task ids may contain punctuation). */
function viewScope(key: string): string | null {
  try {
    const scope: unknown = JSON.parse(key);
    if (!Array.isArray(scope) || (scope.length !== 4 && scope.length !== 5) || typeof scope[0] !== "string" || typeof scope[1] !== "string" || (scope[2] !== null && typeof scope[2] !== "string") || typeof scope[3] !== "string" || (scope.length === 5 && typeof scope[4] !== "string")) return null;
    return JSON.stringify(scope.slice(0, 4));
  } catch { return null; }
}

/** Separate instances model a page reload in tests; production uses the tab's sessionStorage, never localStorage. */
export function createFrameCache(storage: () => FrameStorage | undefined = () => typeof window === "undefined" ? undefined : window.sessionStorage) {
  const frames = new Map<string, Frame>();
  const listeners = new Map<string, Set<() => void>>();
  // A denied stream must not repopulate the cache from another still-mounted viewer's cleanup.
  const deniedViews = new Set<string>();
  function viewFramesDenied(key: string) { const scope = viewScope(key); return scope !== null && deniedViews.has(scope); }
  function allowViewFrames(key: string) { const scope = viewScope(key); if (scope !== null) deniedViews.delete(scope); }
  function forgetViewFrames(key: string) {
    const scope = viewScope(key);
    if (scope === null) return;
    deniedViews.add(scope);
    const keys = new Set([...frames.keys(), ...listeners.keys(), key]);
    try {
      const store = storage();
      if (store) for (let index = 0; index < store.length; index += 1) {
        const name = store.key(index);
        if (name?.startsWith(PREFIX)) keys.add(name.slice(PREFIX.length));
      }
    } catch { /* Memory and mounted viewers are still invalidated if storage is unavailable. */ }
    const matching = [...keys].filter(candidate => viewScope(candidate) === scope);
    // Remove every frame before notifying: subscribers must never read a sibling stale task.
    for (const candidate of matching) {
      frames.delete(candidate);
      try { storage()?.removeItem(PREFIX + candidate); } catch { /* Storage may be disabled. */ }
    }
    for (const candidate of matching) notify(candidate);
  }
  function subscribeFrame(key: string, listener: () => void) {
    const subscribed = listeners.get(key) ?? new Set();
    subscribed.add(listener);
    listeners.set(key, subscribed);
    return () => {
      subscribed.delete(listener);
      if (!subscribed.size) listeners.delete(key);
    };
  }
  function notify(key: string) { for (const listener of listeners.get(key) ?? []) listener(); }
  function forgetFrame(key: string) {
    frames.delete(key);
    try { storage()?.removeItem(PREFIX + key); } catch { /* Storage may be disabled. */ }
    notify(key);
  }
  function readStored(key: string): Frame | undefined {
    try {
      const raw = storage()?.getItem(PREFIX + key);
      if (!raw) return undefined;
      const frame: unknown = JSON.parse(raw);
      if (typeof frame === "object" && frame !== null && "image" in frame && typeof frame.image === "string" && validImage(frame.image) && "at" in frame && typeof frame.at === "number" && Number.isFinite(frame.at)) return { image: frame.image, at: frame.at };
      forgetFrame(key);
    } catch { /* Bad or unavailable storage is an absent frame. */ }
    return undefined;
  }
  function lastFrame(key: string, now = Date.now()): string | null {
    if (viewFramesDenied(key)) return null;
    const frame = frames.get(key) ?? readStored(key);
    if (!frame) return null;
    if (now < frame.at || now - frame.at >= maxAge(key)) { forgetFrame(key); return null; }
    // Reads do not make an old frame new or admit unrelated identities to the in-memory cache.
    return frame.image;
  }
  function keepFrame(key: string, image: string, now = Date.now()) {
    if (viewFramesDenied(key) || !validImage(image) || !Number.isFinite(now)) return;
    const frame = { image, at: now };
    frames.delete(key);
    frames.set(key, frame);
    while (frames.size > MAX_FRAMES) frames.delete(frames.keys().next().value!);
    try {
      const store = storage();
      if (!store) return;
      const kept: Array<{ key: string; at: number }> = [];
      for (let index = store.length - 1; index >= 0; index -= 1) {
        const name = store.key(index);
        if (!name?.startsWith(PREFIX)) continue;
        const scope = name.slice(PREFIX.length);
        const saved = readStored(scope);
        if (!saved || now < saved.at || now - saved.at >= maxAge(scope)) forgetFrame(scope);
        else if (scope !== key) kept.push({ key: scope, at: saved.at });
      }
      // Evict before writing so a full sessionStorage can still accept the newest frame.
      kept.sort((a, b) => b.at - a.at);
      for (const old of kept.slice(MAX_FRAMES - 1)) forgetFrame(old.key);
      store.setItem(PREFIX + key, JSON.stringify(frame));
    } catch { /* Storage full or off: keep the bounded memory fallback. */ }
    finally { notify(key); }
  }
  return { lastFrame, keepFrame, forgetFrame, subscribeFrame, forgetViewFrames, viewFramesDenied, allowViewFrames };
}

export const { lastFrame, keepFrame, forgetFrame, subscribeFrame, forgetViewFrames, viewFramesDenied, allowViewFrames } = createFrameCache();

/** Canvas pixels are from the actual viewer, not a generated placeholder or an arbitrary page URL. */
export function captureFrame(target: HTMLElement, key: string) {
  const canvas = [...target.querySelectorAll("canvas")].reverse().find((entry) => entry.width > 0 && entry.height > 0);
  if (!canvas) return;
  try {
    const small = document.createElement("canvas");
    small.width = Math.min(640, canvas.width);
    small.height = Math.round(canvas.height * small.width / canvas.width);
    const ctx = small.getContext("2d");
    if (!ctx || !canvas.getContext("2d")?.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3]) return;
    ctx.drawImage(canvas, 0, 0, small.width, small.height);
    keepFrame(key, small.toDataURL("image/jpeg", 0.65));
  } catch { /* A tainted or disappearing canvas never breaks the conversation. */ }
}
