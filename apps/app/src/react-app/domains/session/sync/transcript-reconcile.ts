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

  return mergeSnapshotIntoCachedMessages(snapshot, current);
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
export function resolveForkBoundaryId(messages: UIMessage[], messageId: string): string | null {
  const idx = messages.findIndex((message) => message.id === messageId);
  if (idx < 0) return null;
  for (let index = idx + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate && !isSyntheticMessageId(candidate.id)) return candidate.id;
  }
  return null;
}
