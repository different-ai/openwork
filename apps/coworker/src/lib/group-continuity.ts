import type { GroupTimelineEvent } from "./bridge";
import type { ExecutionActivity } from "./progress-activity";
import { PROGRESS_LIMITS } from "./progress-config.ts";

export type GroupSend = {
  clientMessageId: string;
  text: string;
  at: number;
  context?: string;
  turnId?: string;
  only?: string;
  turnUpdatedAt?: number;
  beforeClientMessageId?: string;
  state: "pending" | "sending" | "accepted" | "uncertain" | "failed" | "cancelled";
  error?: string;
};

const sends = new Map<string, readonly GroupSend[]>();
const listeners = new Set<() => void>();
const storageKey = (groupId: string) => `coworker.group-sends.v1:${groupId}`;

export function groupSends(groupId: string): readonly GroupSend[] {
  const cached = sends.get(groupId);
  if (cached) return cached;
  const restored: GroupSend[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(groupId)) ?? "[]");
    if (Array.isArray(value)) for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.clientMessageId !== "string" || typeof item.text !== "string" || typeof item.at !== "number") continue;
      restored.push({ clientMessageId: item.clientMessageId, text: item.text, at: item.at,
        ...(typeof item.context === "string" ? { context: item.context } : {}),
        ...(typeof item.turnId === "string" ? { turnId: item.turnId } : {}),
        ...(typeof item.only === "string" ? { only: item.only } : {}),
        ...(typeof item.turnUpdatedAt === "number" ? { turnUpdatedAt: item.turnUpdatedAt } : {}),
        ...(typeof item.beforeClientMessageId === "string" ? { beforeClientMessageId: item.beforeClientMessageId } : {}),
        state: item.state === "accepted" || item.state === "failed" || item.state === "cancelled" ? item.state : "uncertain",
        ...(typeof item.error === "string" ? { error: item.error } : {}),
      });
    }
  } catch { /* Memory still preserves receipts when browser storage is unavailable. */ }
  sends.set(groupId, restored);
  return restored;
}

export function changeGroupSends(groupId: string, change: (current: readonly GroupSend[]) => readonly GroupSend[]): void {
  const current = groupSends(groupId);
  const next = change(current);
  if (next.length === current.length && next.every((item, index) => item === current[index])) return;
  sends.set(groupId, next);
  try {
    if (next.length) localStorage.setItem(storageKey(groupId), JSON.stringify(next));
    else localStorage.removeItem(storageKey(groupId));
  } catch { /* Sending must not depend on browser storage. */ }
  for (const listener of listeners) listener();
}

export function subscribeGroupSends(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const submissions = new Map<string, symbol>();

function waitForSends(groupId: string, ready: (items: readonly GroupSend[]) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => { if (ready(groupSends(groupId))) { unsubscribe(); resolve(); } };
    const unsubscribe = subscribeGroupSends(check);
    check();
  });
}

/** Serialize admission, not execution. An observed receipt can release a lost IPC acknowledgement. */
export function submitGroupSend(groupId: string, receipt: GroupSend, submit: () => Promise<{ accepted: boolean }>): void {
  const key = `${groupId}:${receipt.clientMessageId}`;
  const current = groupSends(groupId).find((item) => item.clientMessageId === receipt.clientMessageId) ?? receipt;
  if (current.state === "accepted" || current.state === "cancelled") return;
  if (submissions.has(key) && current.state !== "uncertain" && current.state !== "failed") return;
  const generation = Symbol();
  submissions.set(key, generation);
  const ownsAttempt = () => submissions.get(key) === generation;
  const release = () => { if (ownsAttempt() && groupSends(groupId).find((item) => item.clientMessageId === receipt.clientMessageId)?.state !== "uncertain") submissions.delete(key); };
  const update = (state: GroupSend["state"], error?: string) => {
    // Any acknowledgement settles this ID; only the latest attempt can downgrade it.
    if (state !== "accepted" && !ownsAttempt()) return;
    changeGroupSends(groupId, (items) => items.map((item) => item.clientMessageId === receipt.clientMessageId && item.state !== "accepted" && item.state !== "cancelled" && (item.state !== state || item.error !== error) ? { ...item, state, error } : item));
  };
  changeGroupSends(groupId, (items) => items.some((item) => item.clientMessageId === receipt.clientMessageId) ? items : [
    ...items.map((item) => !receipt.turnId && !item.turnId && !item.beforeClientMessageId ? { ...item, beforeClientMessageId: receipt.clientMessageId } : item),
    { ...receipt, state: "pending" },
  ]);
  update("pending");
  const run = async () => {
    // Restored, unconfirmed receipts also hold their place. Navigation cannot bypass them.
    await waitForSends(groupId, (items) => {
      const index = items.findIndex((item) => item.clientMessageId === receipt.clientMessageId);
      return !ownsAttempt() || index < 0 || items[index]?.state === "cancelled" || items[index]?.state === "accepted" || !items.slice(0, index).some((item) => item.state === "pending" || item.state === "sending" || item.state === "uncertain");
    });
    const current = groupSends(groupId).find((item) => item.clientMessageId === receipt.clientMessageId);
    if (!ownsAttempt() || !current || current.state === "accepted" || current.state === "cancelled") return;
    update("sending");
    const confirmed = waitForSends(groupId, (items) => {
      const current = items.find((item) => item.clientMessageId === receipt.clientMessageId);
      return !ownsAttempt() || !current || current.state === "accepted" || current.state === "cancelled" || current.state === "failed" || current.state === "uncertain";
    });
    const request = Promise.resolve().then(submit).then((result) => {
      if (!result.accepted) throw new Error("The group did not accept this message.");
      update("accepted");
    }).catch((cause: unknown) => { update(receipt.state === "uncertain" ? "uncertain" : "failed", cause instanceof Error ? cause.message : String(cause)); }).finally(release);
    const settled = Promise.race([request, confirmed]);
    void waitForGroup(settled).catch((cause: unknown) => update("uncertain", cause instanceof Error ? cause.message : String(cause)));
    await settled;
  };
  void run().finally(release);
}

export type GroupActionAttempt = { state: "running" | "retryable" | "succeeded"; error?: string };

/** An attempt object is its generation token, including after its observation deadline. */
export async function runGroupAction<T>(attempts: Map<string, GroupActionAttempt>, key: string, action: () => Promise<T>, changed: (attempt: GroupActionAttempt) => void, succeeded?: (value: T) => void): Promise<void> {
  if (attempts.get(key)?.state === "running") return;
  const attempt: GroupActionAttempt = { state: "running" };
  attempts.set(key, attempt);
  const update = (state: GroupActionAttempt["state"], error?: string) => {
    if (attempts.get(key) !== attempt) return;
    attempt.state = state;
    attempt.error = error;
    changed(attempt);
  };
  changed(attempt);
  const request = Promise.resolve().then(action).then((value) => {
    if (attempts.get(key) !== attempt) return;
    succeeded?.(value);
    update("succeeded");
  }).catch((cause: unknown) => update("retryable", cause instanceof Error ? cause.message : String(cause)));
  try { await waitForGroup(request); }
  catch (cause) { update("retryable", cause instanceof Error ? cause.message : String(cause)); }
}

/** A deadline ends observation, never the underlying accepted native work. */
export async function waitForGroup<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Confirmation is taking longer than expected. The outcome is not yet confirmed.")), PROGRESS_LIMITS.activityReadTimeoutMs * 2);
    })]);
  } finally { clearTimeout(timer); }
}

export type GroupReplyPart = { messageId: string; id: string; text: string; ended?: boolean };

export function groupReplyParts(activity: ExecutionActivity): GroupReplyPart[] {
  return activity.replies.flatMap((reply) => reply.parentId === activity.messageId ? reply.parts.map((part) => ({ ...part, messageId: reply.id })) : []);
}

/** Native IDs are sortable. An unfinished snapshot cannot roll back a streamed prefix. */
export function mergeGroupReplyParts(previous: readonly GroupReplyPart[], incoming: readonly GroupReplyPart[]): GroupReplyPart[] {
  const parts = new Map(previous.map((part) => [`${part.messageId}:${part.id}`, part]));
  for (const part of incoming) {
    const key = `${part.messageId}:${part.id}`;
    const before = parts.get(key);
    if (before?.ended && !part.ended) continue;
    if (!part.ended && before && before.text.startsWith(part.text)) continue;
    parts.set(key, part);
  }
  let remaining = PROGRESS_LIMITS.maxReplyChars;
  return [...parts.values()].sort((a, b) => a.messageId.localeCompare(b.messageId) || a.id.localeCompare(b.id)).slice(0, PROGRESS_LIMITS.maxReplyParts).map((part) => {
    const text = part.text.slice(0, remaining);
    remaining -= text.length;
    return { ...part, text };
  });
}

export function groupMessageKey(event: GroupTimelineEvent): string {
  return event.kind === "user" && event.clientMessageId ? `user:${event.clientMessageId}` : event.executionId ? `execution:${event.executionId}` : event.id;
}

export function groupConversationRows(events: readonly GroupTimelineEvent[], executions: readonly ExecutionActivity[], sends: readonly GroupSend[]) {
  const provisional = sends.filter((item) => !item.turnId && !events.some((event) => event.kind === "user" && event.clientMessageId === item.clientMessageId)).map((item): { event: GroupTimelineEvent; delivery: GroupSend } => ({ event: { id: `user:${item.clientMessageId}`, kind: "user", text: item.text, at: item.at, clientMessageId: item.clientMessageId }, delivery: item }));
  const rows: Array<{ event: GroupTimelineEvent; delivery?: GroupSend } | { execution: ExecutionActivity }> = [...events.map((event) => ({ event })), ...executions.map((execution) => ({ execution })), ...provisional];
  // Move only provisional rows. Native event and speaker order remain authoritative.
  for (const row of [...provisional].reverse()) {
    const before = row.delivery.beforeClientMessageId ?? events.find((event) => event.kind === "user" && event.at > row.delivery.at)?.clientMessageId;
    const anchor = rows.find((item) => "event" in item && item.event.kind === "user" && item.event.clientMessageId === before);
    if (!before || !anchor || anchor === row) continue;
    rows.splice(rows.indexOf(row), 1);
    rows.splice(rows.indexOf(anchor), 0, row);
  }
  return rows;
}

/** Keep paired publication receipts and executions, never join different native requests. */
export function reconcileGroupActivity(previous: { timeline: GroupTimelineEvent[]; executions: ExecutionActivity[] }, incoming: { timeline: GroupTimelineEvent[]; executions: ExecutionActivity[] }, speakerOrder: readonly string[] = []) {
  const timeline = [...previous.timeline];
  for (const event of incoming.timeline) {
    const index = timeline.findIndex((item) => groupMessageKey(item) === groupMessageKey(event));
    if (index < 0) timeline.push(event);
    else timeline[index] = event;
  }
  const executions = incoming.executions.filter((entry) => !timeline.some((event) => event.executionId === entry.executionId || event.id === entry.timelineEventId)).map((entry) => {
    const before = previous.executions.find((item) => item.executionId === entry.executionId && item.messageId === entry.messageId && item.threadId === entry.threadId && item.slug === entry.slug);
    if (!before) return entry;
    const parts = mergeGroupReplyParts(groupReplyParts(before), groupReplyParts(entry));
    const replies: ExecutionActivity["replies"] = [];
    for (const part of parts) {
      let reply = replies.find((item) => item.id === part.messageId);
      if (!reply) { reply = { id: part.messageId, parentId: entry.messageId, parts: [] }; replies.push(reply); }
      reply.parts.push({ id: part.id, text: part.text, ended: part.ended });
    }
    return { ...entry, replies };
  });
  // Completion state and provider return order must not reshuffle parallel speakers.
  const order = (slug: string) => { const index = speakerOrder.indexOf(slug); return index < 0 ? speakerOrder.length : index; };
  executions.sort((a, b) => order(a.slug) - order(b.slug) || (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.messageId.localeCompare(b.messageId));
  return { timeline, executions };
}
