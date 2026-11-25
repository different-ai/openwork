import type { UIMessage } from "ai";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../../../app/types";
import { mergeSnapshotIntoCachedMessages } from "./message-merge";

export type TranscriptReconcileReason = "snapshot" | "revert";

export type ReconcileTranscriptInput = {
  currentMessages: UIMessage[];
  snapshotMessages: UIMessage[];
  reason?: TranscriptReconcileReason;
};

export function reconcileTranscriptMessages(input: ReconcileTranscriptInput): UIMessage[] {
  const current = input.currentMessages;
  const snapshot = input.snapshotMessages;

  if (current.length === 0) return snapshot;
  if (snapshot.length === 0) return current;

  return dropDuplicateTurnErrors(mergeSnapshotIntoCachedMessages(snapshot, current), snapshot);
}

export function dropDuplicateTurnErrors(input: UIMessage[], snapshot: UIMessage[]): UIMessage[] {
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  const lastUser = snapshot.map((message) => message.role).lastIndexOf("user");
  const snapshotHasTurnError = snapshot.slice(lastUser + 1).some((message) => isSyntheticMessageId(message.id));
  const messages = snapshotHasTurnError
    ? input.filter((message) => !(message.id.startsWith(`${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}ses_`) && !snapshotIds.has(message.id)))
    : input;
  const result: UIMessage[] = [];
  let turnErrorIndex = -1;
  for (const message of messages) {
    if (message.role === "user") turnErrorIndex = -1;
    if (isSyntheticMessageId(message.id)) {
      const kept = turnErrorIndex >= 0 ? result[turnErrorIndex] : undefined;
      if (kept) {
        const keptDurable = snapshotIds.has(kept.id);
        const currentDurable = snapshotIds.has(message.id);
        if (keptDurable && !currentDurable) continue;
        if (currentDurable && !keptDurable) {
          result.splice(turnErrorIndex, 1);
          turnErrorIndex = result.length;
          result.push(message);
          continue;
        }
      }
      turnErrorIndex = result.length;
    }
    result.push(message);
  }
  return result.length === input.length ? input : result;
}

export function applyRevertCursor(messages: UIMessage[], revertMessageId: string | null | undefined): UIMessage[] {
  if (!revertMessageId || messages.length === 0) return messages;
  const idx = messages.findIndex((message) => message.id === revertMessageId);
  if (idx < 0) return messages;
  return messages.slice(0, idx);
}

function isSyntheticMessageId(id: string) {
  return id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
}

export function resolveForkBoundaryId(messages: readonly Pick<UIMessage, "id">[], messageId: string): string | null {
  const nativeId = isSyntheticMessageId(messageId)
    ? messageId.slice(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX.length)
    : messageId.endsWith(":steps") ? messageId.slice(0, -":steps".length) : messageId;
  const exact = messages.findIndex((message) => message.id === messageId);
  const idx = exact < 0 ? messages.findIndex((message) => message.id === nativeId) : exact;
  if (idx < 0) throw new Error("The branch message is no longer in this conversation.");
  for (let index = idx + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate && !isSyntheticMessageId(candidate.id)) return candidate.id;
  }
  return null;
}

export function dedupeRenderedTurnErrors(messages: UIMessage[]): UIMessage[] {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  const latestHasKeyedError = messages.slice(lastUser + 1)
    .some((message) => isSyntheticMessageId(message.id) && !message.id.startsWith(`${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}ses_`));
  const result: UIMessage[] = [];
  let turnError = -1;
  for (const message of messages) {
    if (message.role === "user") turnError = -1;
    if (isSyntheticMessageId(message.id)) {
      if (latestHasKeyedError && message.id.startsWith(`${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}ses_`)) continue;
      if (turnError >= 0) {
        result[turnError] = message;
        continue;
      }
      turnError = result.length;
    }
    result.push(message);
  }
  return result.length === messages.length ? messages : result;
}

const recoveredReplies = new WeakMap<UIMessage, { continuation: UIMessage; joined: UIMessage[] }>();

function joinContinuation(interrupted: UIMessage, continuation: UIMessage): UIMessage[] | null {
  const cached = recoveredReplies.get(interrupted);
  if (cached?.continuation === continuation) return cached.joined;
  const tail = interrupted.parts.at(-1);
  if (tail?.type !== "text") return null;
  const headIndex = continuation.parts.findIndex((part) => part.type !== "step-start" && part.type !== "reasoning");
  const head = continuation.parts[headIndex];
  if (head?.type !== "text") return null;
  const earlier = interrupted.parts.slice(0, -1);
  const joined: UIMessage[] = [
    ...(earlier.some((part) => part.type !== "step-start") ? [{ ...interrupted, parts: earlier }] : []),
    { ...continuation, parts: continuation.parts.with(headIndex, { ...head, text: tail.text + head.text }) },
  ];
  recoveredReplies.set(interrupted, { continuation, joined });
  return joined;
}

export function joinRecoveredReplies(messages: UIMessage[]): UIMessage[] {
  const result: UIMessage[] = [];
  let changed = false;
  for (const message of messages) {
    const error = result.at(-1);
    const interrupted = result.at(-2);
    const joined = error && interrupted?.role === "assistant" && message.role === "assistant"
      && !isSyntheticMessageId(message.id) && error.id === `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${interrupted.id}`
      ? joinContinuation(interrupted, message)
      : null;
    if (!joined) {
      result.push(message);
      continue;
    }
    changed = true;
    result.splice(-2, 2, ...joined);
  }
  return changed ? result : messages;
}
