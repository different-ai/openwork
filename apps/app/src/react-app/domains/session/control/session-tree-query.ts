import type { SessionLinkKind } from "@openwork/types/session-link";

import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { buildSessionTree, canLinkSessionTo } from "../sidebar/session-tree";
import type { SessionListItem } from "../sidebar/utils";

export type SessionTreeQueryResult = {
  ok: true;
  workspaceId: string;
  sessionId: string;
  /** The session this one was started from, when it is still listed. */
  parent: { sessionId: string; title: string; kind: SessionLinkKind } | null;
  /** Sessions started from this one, each followed by the ones started from it. */
  sessions: Array<{ sessionId: string; title: string; kind: SessionLinkKind; depth: number; status: string }>;
  /** A session started from this one now is listed under it; one its agent starts also reports back to it. */
  canStartLinked: boolean;
};

/**
 * What `session.tree` answers for one session. `engineV2` is whether the
 * workspace's chats run on the engine that keeps the link.
 */
export function sessionTreeQuery(input: {
  workspaceId: string;
  sessionId: string;
  sessions: readonly SessionListItem[];
  engineV2: boolean;
  statusFor: (sessionId: string) => string;
}): SessionTreeQueryResult | { ok: false; error: string } {
  const session = input.sessions.find((entry) => entry.id === input.sessionId);
  if (!session) return { ok: false, error: `Session not found in this workspace: ${input.sessionId}` };
  const tree = buildSessionTree(input.sessions);
  const parentLink = tree.parentOf(session.id);
  const parent = parentLink ? input.sessions.find((entry) => entry.id === parentLink.sessionId) : undefined;
  const firstDepth = tree.descendantsOf(session.id)[0]?.depth ?? 1;
  return {
    ok: true,
    workspaceId: input.workspaceId,
    sessionId: session.id,
    parent: parentLink && parent
      ? { sessionId: parent.id, title: getDisplaySessionTitle(parent.title), kind: parentLink.kind }
      : null,
    sessions: tree.descendantsOf(session.id).map((child) => ({
      sessionId: child.session.id,
      title: getDisplaySessionTitle(child.session.title),
      kind: child.kind,
      // Counted from the asked session, whatever its own place in the tree.
      depth: child.depth - firstDepth + 1,
      status: input.statusFor(child.session.id),
    })),
    canStartLinked: input.engineV2 && canLinkSessionTo(input.sessions, session.id),
  };
}
