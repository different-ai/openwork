/** Visible reply parts in native ID order. Hidden parts keep only a tombstone. */
export type LivePart = { messageId: string; partId: string; type: string; text: string; ended: boolean };
export type LiveStream = LivePart & { parts: LivePart[] };

export type StreamEvent =
  | { kind: "delta"; threadId: string; messageId: string; partId: string; delta: string }
  | { kind: "part"; threadId: string; messageId: string; partId: string; type: string; text: string; ended: boolean; synthetic?: boolean; ignored?: boolean };

export const ANSWER_STREAMING_MIN_CHARS = 12;

export function answerStreaming(stream: LiveStream | null | undefined): boolean {
  return Boolean(stream && !stream.ended && stream.type === "text" && stream.text.trim().length >= ANSWER_STREAMING_MIN_CHARS);
}

/** The caller verifies assistant/turn ownership. Deltas cannot establish visibility. */
export function applyStreamEvent(current: LiveStream | null, event: StreamEvent, threadId: string): LiveStream | null {
  if (event.threadId !== threadId) return current;
  const parts = current?.parts ?? [];
  const index = parts.findIndex((part) => part.messageId === event.messageId && part.partId === event.partId);
  const before = parts[index];
  let next: LivePart;
  if (event.kind === "delta") {
    if (!before || before.type !== "text" || before.ended || !event.delta || (current && (event.messageId < current.messageId || (event.messageId === current.messageId && event.partId < current.partId)))) return current;
    next = { ...before, text: before.text + event.delta };
  } else {
    const hidden = event.synthetic || event.ignored || event.type !== "text";
    if (before?.type === "hidden") return current;
    if (!hidden && before?.ended) return current;
    const text = hidden ? "" : !event.ended && before?.text.startsWith(event.text) ? before.text : event.text;
    next = { messageId: event.messageId, partId: event.partId, type: hidden ? "hidden" : "text", text, ended: hidden || event.ended };
    if (before && before.text === next.text && before.type === next.type && before.ended === next.ended) return current;
  }
  const ordered = [...parts];
  if (index < 0) {
    ordered.push(next);
    ordered.sort((a, b) => a.messageId.localeCompare(b.messageId) || a.partId.localeCompare(b.partId));
  } else ordered[index] = next;
  const latest = ordered.findLast((part) => part.type === "text") ?? next;
  return { ...latest, parts: ordered };
}

/** Reconcile prefixes only within one identity, never against a whole transcript's length. */
export function replyText(stream: LiveStream | null, reply: { id: string; text: string; parts: readonly LivePart[] } | null): string {
  const parts = new Map<string, LivePart>();
  for (const part of stream?.parts ?? []) {
    if (!reply || part.messageId === reply.id) parts.set(`${part.messageId}:${part.partId}`, part);
  }
  for (const part of reply?.parts ?? []) {
    const key = `${part.messageId}:${part.partId}`;
    const before = parts.get(key);
    if (before?.type === "hidden" || (part.type !== "hidden" && before && !part.ended && (before.ended || before.text.startsWith(part.text)))) continue;
    parts.set(key, part);
  }
  if (!parts.size) return reply?.text ?? "";
  return [...parts.values()].sort((a, b) => a.messageId.localeCompare(b.messageId) || a.partId.localeCompare(b.partId)).filter((part) => part.type === "text").map((part) => part.text).join("").trim();
}
