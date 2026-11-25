import { uiBridgeRequest } from "./openwork-ui-bridge.js";

export type ScrubRules = { readonly skip: ReadonlySet<string>; readonly free: ReadonlySet<string> };
export type RedactReply = { held: boolean; texts?: string[] };
export type RedactRequest = (texts: string[] | null) => Promise<RedactReply | null>;
type Slot = { text: string; put(next: string): boolean };

export const OUTGOING: ScrubRules = {
  skip: new Set(["type", "role", "id", "name", "namespace", "tool", "callID", "messageID", "sessionID", "parentID", "status", "mime", "mediaType",
    "providerID", "modelID", "agent", "mode", "variant", "encrypted", "signature", "providerMetadata", "metadata", "cache", "time", "tokens", "cost"]),
  free: new Set(["input", "args", "structured"]),
};
export const STORED: ScrubRules = {
  skip: new Set(["type", "mime", "mediaType"]),
  free: new Set(["output", "metadata", "structured"]),
};

const BATCH_CHARS = 8_000_000;
const BATCH_TEXTS = 4_000;
const REQUEST_MS = 20_000;
const SHORTEST = 4;
const TEXT_MEDIA = /^(?:text\/|application\/(?:json|xml|x-ndjson|javascript|x-www-form-urlencoded)\b)/i;
const BINARY_URL = /^data:(?!text\/|application\/(?:json|xml)\b|[;,])/i;
export const UNCHECKED = "OpenWork could not check this for private values, so nothing was sent. Try again in a moment.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plain(value: Record<string, unknown>): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scannable(text: string): boolean {
  return text.length >= SHORTEST && !BINARY_URL.test(text);
}

function collect(node: unknown, rules: ScrubRules, slots: Slot[], seen: Set<object>, free: boolean): void {
  if (Array.isArray(node)) {
    if (seen.has(node)) return;
    seen.add(node);
    node.forEach((item: unknown, index) => {
      if (typeof item !== "string") collect(item, rules, slots, seen, free);
      else if (scannable(item)) slots.push({ text: item, put: next => Reflect.set(node, index, next) });
    });
    return;
  }
  if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer || node instanceof Date || !record(node) || seen.has(node)) return;
  seen.add(node);
  const binary = !free && [node.mediaType, node.mime].some(kind => typeof kind === "string" && !TEXT_MEDIA.test(kind));
  for (const key of Object.keys(node)) {
    if (!free && rules.skip.has(key)) continue;
    const item = node[key];
    if (typeof item !== "string") collect(item, rules, slots, seen, free || rules.free.has(key) || (key === "value" && node.type !== "content"));
    else if (scannable(item) && !(binary && key === "data")) slots.push({ text: item, put: next => Reflect.set(node, key, next) });
    if (free && key.length >= SHORTEST && plain(node)) {
      slots.push({ text: key, put: next => {
        const kept = node[key];
        return Reflect.deleteProperty(node, key) && Reflect.set(node, next, kept);
      } });
    }
  }
}

export function plainCopy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item: unknown) => plainCopy(item));
  if (!record(node) || !plain(node)) return node;
  return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, plainCopy(item)]));
}

export function redactReply(value: unknown): RedactReply | null {
  if (!record(value) || value.ok !== true || typeof value.held !== "boolean") return null;
  const texts = value.texts;
  if (texts === undefined) return { held: value.held };
  return Array.isArray(texts) && texts.every((text): text is string => typeof text === "string") ? { held: value.held, texts } : null;
}

const bridgeRequest: RedactRequest = async texts =>
  redactReply(await uiBridgeRequest("/private/redact", { method: "POST", body: texts ? { texts } : { probe: true }, timeoutMs: REQUEST_MS }));

export function redactThrough(relay: { url: string; token: string }): RedactRequest {
  return async texts => {
    const response = await fetch(relay.url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(REQUEST_MS + 5_000),
      headers: { Authorization: `Bearer ${relay.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(texts ? { texts } : { probe: true }),
    });
    return response.ok ? redactReply(await response.json()) : null;
  };
}

export function createPrivateValueScrubber(request: RedactRequest = bridgeRequest) {
  let heldBefore = false;
  const unchecked = (): number => {
    if (heldBefore) throw new Error(UNCHECKED);
    return 0;
  };
  return async function scrub(roots: readonly unknown[], rules: ScrubRules): Promise<number> {
    const slots: Slot[] = [];
    const seen = new Set<object>();
    for (const root of roots) collect(root, rules, slots, seen, false);
    if (!slots.length) return 0;
    const probe = await request(null).catch(() => null);
    if (!probe) return unchecked();
    if (!probe.held) return 0;
    heldBefore = true;
    const unique = [...new Set(slots.map(slot => slot.text))];
    const clean = new Map<string, string>();
    const batches: string[][] = [];
    let batch: string[] = [];
    let chars = 0;
    for (const text of unique) {
      const size = JSON.stringify(text).length + 1;
      if (batch.length && (batch.length >= BATCH_TEXTS || chars + size > BATCH_CHARS)) {
        batches.push(batch);
        batch = [];
        chars = 0;
      }
      batch.push(text);
      chars += size;
    }
    if (batch.length) batches.push(batch);
    for (const sent of batches) {
      const answer = await request(sent).catch(() => null);
      const texts = answer?.held ? answer.texts : undefined;
      if (!texts || texts.length !== sent.length) throw new Error(UNCHECKED);
      sent.forEach((text, index) => clean.set(text, texts[index] ?? text));
    }
    let changed = 0;
    for (const slot of slots) {
      const next = clean.get(slot.text);
      if (next === undefined || next === slot.text) continue;
      let written = false;
      try { written = slot.put(next); } catch { written = false; }
      if (!written) throw new Error(UNCHECKED);
      changed += 1;
    }
    return changed;
  };
}

export const scrubPrivateValues = createPrivateValueScrubber();
