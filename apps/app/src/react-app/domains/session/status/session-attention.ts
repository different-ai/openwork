import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import { t } from "../../../../i18n";
import type { SessionActivityStatus, SessionWaitingKind } from "./session-activity-store";

type AttentionSession = {
  id: string;
  parentID?: string | null;
  title?: string | null;
};

/** The descendant whose unanswered request blocks an ancestor. */
export type SessionAttentionSource = {
  sessionId: string;
  title: string;
  kind: SessionWaitingKind;
};

export type SessionAttention = {
  status: SessionActivityStatus;
  /** Set only when `status` is "waiting" because of a delegated child, not the session's own request. */
  blockedBy: SessionAttentionSource | null;
};

/**
 * The status a person (or an agent asking `session.list_sessions`) should see
 * for each session. A delegated child's pending permission or question lives
 * on the child's activity record, so the parent's own status stays "thinking"
 * while nothing can move until someone answers. This rolls that request up
 * every parentID hop so the sidebar, notifications, and agent-visible status
 * agree with the transcript's inline "Needs permission" treatment.
 *
 * Precedence: error > waiting (own or descendant) > compacting > thinking /
 * responding > idle. `ownStatus` already orders everything but the descendant
 * case. Cyclic or dangling parent data stops at the first repeated hop.
 */
export function selectSessionAttention(
  sessions: readonly AttentionSession[],
  ownStatus: (sessionId: string) => SessionActivityStatus | undefined,
  waitingKind: (sessionId: string) => SessionWaitingKind | undefined,
): Map<string, SessionAttention> {
  const parentOf = new Map<string, string>();
  for (const session of sessions) {
    const id = session.id.trim();
    const parentID = session.parentID?.trim();
    if (id && parentID && parentID !== id) parentOf.set(id, parentID);
  }

  const blockedBy = new Map<string, SessionAttentionSource>();
  for (const session of sessions) {
    const id = session.id.trim();
    const kind = id ? waitingKind(id) : undefined;
    if (!kind) continue;
    const source: SessionAttentionSource = { sessionId: id, title: getDisplaySessionTitle(session.title ?? ""), kind };
    const visited = new Set([id]);
    for (let parent = parentOf.get(id); parent && !visited.has(parent); parent = parentOf.get(parent)) {
      visited.add(parent);
      if (!blockedBy.has(parent)) blockedBy.set(parent, source);
    }
  }

  const attention = new Map<string, SessionAttention>();
  for (const session of sessions) {
    const id = session.id.trim();
    if (!id) continue;
    const own = ownStatus(id) ?? "idle";
    if (own === "error" || own === "waiting") {
      attention.set(id, { status: own, blockedBy: null });
      continue;
    }
    const source = blockedBy.get(id);
    attention.set(id, source ? { status: "waiting", blockedBy: source } : { status: own, blockedBy: null });
  }
  return attention;
}

/** Tooltip / accessible name for the orange "needs you" dot when a child is the reason. */
export function sessionAttentionLabel(source: SessionAttentionSource): string {
  const prefix = source.kind === "permission"
    ? t("session.subagent_permission_needed")
    : t("session.subagent_question_pending");
  return `${prefix}: ${source.title}`;
}
