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

export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: OpenworkSessionSnapshot | null | undefined;
  includeLiveOnlyMessages?: boolean;
}) {
  const liveMessages = input.transcriptState ?? [];
  const snapshotMessages = input.snapshot && input.snapshot.messages.length > 0
    ? snapshotToUIMessages(input.snapshot)
    : [];

  if (liveMessages.length > 0 && snapshotMessages.length === 0) return liveMessages;
  if (liveMessages.length === 0 && snapshotMessages.length > 0) return snapshotMessages;
  if (liveMessages.length > 0 && snapshotMessages.length > 0) {
    if (messageListContainsAll(liveMessages, snapshotMessages)) return liveMessages;
    return mergeSnapshotAndLiveMessages(snapshotMessages, liveMessages, {
      appendLiveOnlyMessages: input.includeLiveOnlyMessages,
    });
  }
  if (input.snapshot && input.snapshot.messages.length > 0) {
    return snapshotMessages;
  }
  return input.transcriptState ?? [];
}
