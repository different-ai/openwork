import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../../../../app/lib/openwork-server";
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
}) {
  if (input.transcriptState && input.transcriptState.length > 0) {
    return input.transcriptState;
  }
  if (input.snapshot && input.snapshot.messages.length > 0) {
    return snapshotToUIMessages(input.snapshot);
  }
  return input.transcriptState ?? [];
}
