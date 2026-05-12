import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../../../../app/lib/openwork-server";
import { mergeSnapshotAndLiveMessages, messageListContainsAll } from "../sync/message-merge";
import { snapshotToUIMessages } from "../sync/usechat-adapter";

export function resolveRenderedSessionSnapshot(input: {
  sessionId: string;
  currentSnapshot: OpenworkSessionSnapshot | null | undefined;
  cachedRendered: { sessionId: string; snapshot: OpenworkSessionSnapshot } | null | undefined;
}) {
  if (input.currentSnapshot?.session.id === input.sessionId) {
    return input.currentSnapshot;
  }
  if (
    input.cachedRendered?.sessionId === input.sessionId &&
    input.cachedRendered.snapshot.session.id === input.sessionId
  ) {
    return input.cachedRendered.snapshot;
  }
  return null;
}

/**
 * Truncate a message list at the revert cursor. OpenCode's session.revert
 * sets a messageID on the session but the snapshot still returns all messages.
 * The UI must hide messages after the revert point.
 */
function applyRevertCursor(messages: UIMessage[], revertMessageId: string | null | undefined): UIMessage[] {
  if (!revertMessageId || messages.length === 0) return messages;
  const idx = messages.findIndex((m) => m.id === revertMessageId);
  if (idx < 0) return messages;
  // Keep messages up to and including the revert point
  return messages.slice(0, idx + 1);
}

export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: OpenworkSessionSnapshot | null | undefined;
}) {
  const revertMessageId = (input.snapshot?.session as any)?.revert?.messageID ?? null;

  const liveMessages = input.transcriptState ?? [];
  const snapshotMessages = input.snapshot && input.snapshot.messages.length > 0
    ? snapshotToUIMessages(input.snapshot)
    : [];

  let result: UIMessage[];

  if (liveMessages.length > 0 && snapshotMessages.length === 0) result = liveMessages;
  else if (liveMessages.length === 0 && snapshotMessages.length > 0) result = snapshotMessages;
  else if (liveMessages.length > 0 && snapshotMessages.length > 0) {
    if (messageListContainsAll(liveMessages, snapshotMessages)) result = liveMessages;
    else result = mergeSnapshotAndLiveMessages(snapshotMessages, liveMessages, {
      appendLiveOnlyMessages: true,
    });
  } else if (input.snapshot && input.snapshot.messages.length > 0) {
    result = snapshotMessages;
  } else {
    result = input.transcriptState ?? [];
  }

  return applyRevertCursor(result, revertMessageId);
}
