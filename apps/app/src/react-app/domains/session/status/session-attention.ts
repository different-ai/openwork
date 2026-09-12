import type { OpenworkSessionActivityInventory } from "@openwork/types/openwork-affordance";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import { t } from "../../../../i18n";
import type { SessionActivityStatus, SessionWaitingKind } from "./session-activity-store";

type AttentionSession = {
  id: string;
  parentID?: string | null;
  title?: string | null;
  time?: { archived?: number | null };
};

export type SessionAttentionSource = {
  sessionId: string;
  title: string;
  kind: SessionWaitingKind;
  relationship: "child" | "descendant";
};

export type SessionAttention = OpenworkSessionActivityInventory & {
  status: SessionActivityStatus;
  blockedBy: SessionAttentionSource | null;
};

export function selectSessionAttention(
  sessions: readonly AttentionSession[],
  ownStatus: (sessionId: string) => SessionActivityStatus | undefined,
  waitingKind: (sessionId: string) => SessionWaitingKind | undefined,
  childIds: (sessionId: string) => readonly string[] = () => [],
): Map<string, SessionAttention> {
  const inventory = new Map(sessions.map((session) => [session.id.trim(), session]));
  const children = new Map<string, Set<string>>();
  const link = (parent: string, child: string) => {
    if (!parent || !child || parent === child) return;
    const ids = children.get(parent) ?? new Set<string>();
    ids.add(child);
    children.set(parent, ids);
  };
  for (const [id, session] of inventory) {
    link(session.parentID?.trim() ?? "", id);
    for (const child of childIds(id)) link(id, child.trim());
  }

  const attention = new Map<string, SessionAttention>();
  for (const [id, session] of inventory) {
    if (!id) continue;
    const descendantActivity = { busy: 0, waiting: 0, unknown: 0 };
    let blockedBy: SessionAttentionSource | null = null;
    const visited = new Set([id]);
    const queue = session.time?.archived ? [] : [...children.get(id) ?? []];
    for (let index = 0; index < queue.length; index += 1) {
      const childId = queue[index];
      if (visited.has(childId)) continue;
      visited.add(childId);
      const child = inventory.get(childId);
      if (child?.time?.archived) continue;
      const status = ownStatus(childId);
      const kind = waitingKind(childId);
      if (!child || status === undefined && !kind) descendantActivity.unknown += 1;
      else if (status !== "error" && (kind || status === "waiting")) {
        descendantActivity.waiting += 1;
        if (!blockedBy && kind) blockedBy = {
          sessionId: childId,
          title: getDisplaySessionTitle(child.title ?? ""),
          kind,
          relationship: children.get(id)?.has(childId) ? "child" : "descendant",
        };
      } else if (status !== "idle" && status !== "error") descendantActivity.busy += 1;
      queue.push(...children.get(childId) ?? []);
    }
    const own = ownStatus(id) ?? "idle";
    const ownWins = own === "error" || own === "waiting";
    attention.set(id, {
      status: !ownWins && descendantActivity.waiting > 0 ? "waiting" : own,
      blockedBy: ownWins ? null : blockedBy,
      working: own !== "idle" && own !== "error" || descendantActivity.busy > 0 || descendantActivity.waiting > 0,
      descendantActivity,
      inventoryComplete: descendantActivity.unknown === 0,
    });
  }
  return attention;
}

export function sessionAttentionSidebarStatus(attention: SessionAttention): SessionActivityStatus {
  return attention.status === "idle" && attention.descendantActivity.busy > 0 ? "thinking" : attention.status;
}

export function sessionAttentionLabel(source: Omit<SessionAttentionSource, "relationship">): string {
  const prefix = source.kind === "permission"
    ? t("session.subagent_permission_needed")
    : t("session.subagent_question_pending");
  return `${prefix}: ${source.title}`;
}
