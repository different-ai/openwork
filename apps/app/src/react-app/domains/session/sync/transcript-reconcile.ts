import type { UIMessage } from "ai";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../../../app/types";
import { mergeSnapshotIntoCachedMessages } from "./message-merge";

export type TranscriptReconcileReason = "snapshot" | "revert";

export type ReconcileTranscriptInput = {
  /** Current canonical transcript cache rendered by the session UI. */
  currentMessages: UIMessage[];
  /** Messages reconstructed from the latest server snapshot. */
  snapshotMessages: UIMessage[];
  /** Why this reconciliation is happening. Reserved for explicit truncation rules. */
  reason?: TranscriptReconcileReason;
};

/**
 * Reconcile a server snapshot into the canonical transcript cache.
 *
 * Snapshot reads can lag behind the OpenCode event stream during prompt
 * submission. This helper centralizes the invariant that ordinary snapshots
 * may fill/update the cache, but must not make the visible transcript move
 * backwards. Explicit history operations such as revert can opt into their own
 * truncation path instead of relying on snapshot absence.
 */
export function reconcileTranscriptMessages(input: ReconcileTranscriptInput): UIMessage[] {
  const current = input.currentMessages;
  const snapshot = input.snapshotMessages;

  if (current.length === 0) return snapshot;
  if (snapshot.length === 0) return current;

  return dropDuplicateTurnErrors(mergeSnapshotIntoCachedMessages(snapshot, current), snapshot);
}

/**
 * One failed turn shows one error. The live `session.error` event keys its
 * error to the session id when the turn has no rendered assistant message yet
 * or to a live-only assistant id (OpenCode v2 errored turns arrive without
 * parts), while the snapshot keys the same failure to the errored assistant
 * message. A turn ends at its error, so two synthetic errors between the same
 * pair of user messages describe one failure: keep the snapshot's durable
 * copy and drop the live-only one.
 */
export function dropDuplicateTurnErrors(input: UIMessage[], snapshot: UIMessage[]): UIMessage[] {
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  // The live event falls back to a session-keyed error when the turn had no
  // assistant message yet; it can sort before the turn's user message. Once
  // the snapshot carries an error for the latest turn, that fallback is the
  // same failure.
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

/**
 * Hide messages at and after OpenCode's revert cursor. Revert is an explicit
 * history mutation, so it is the one place the rendered transcript is allowed
 * to move backwards.
 *
 * OpenCode treats `session.revert.messageID` as the FIRST reverted message
 * (every message with `id >= revert.messageID` is reverted), so the cursor
 * message itself must be hidden too.
 */
export function applyRevertCursor(messages: UIMessage[], revertMessageId: string | null | undefined): UIMessage[] {
  if (!revertMessageId || messages.length === 0) return messages;
  const idx = messages.findIndex((message) => message.id === revertMessageId);
  if (idx < 0) return messages;
  return messages.slice(0, idx);
}

function isSyntheticMessageId(id: string) {
  return id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
}

/**
 * Resolve the message id to pass to OpenCode's `session.fork` so the branch
 * INCLUDES the message the user branched at.
 *
 * OpenCode copies messages strictly BEFORE the given id, so branching "at" a
 * message means forking at the next real message after it. Synthetic
 * client-side messages (e.g. `session-error:*`) are skipped because their ids
 * do not exist server-side and would corrupt the fork boundary. Returns null
 * when the branch point is the last message, meaning "fork the full session".
 */
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

/**
 * Render-time guard for the same rule, whatever merge path produced the list:
 * a turn shows one error. Drop a session-keyed fallback error once the latest
 * turn has an error keyed to its assistant message, and keep only the last
 * error between two user messages.
 */
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
