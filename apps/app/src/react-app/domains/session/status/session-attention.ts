import type { OpenworkSessionActivityInventory } from "@openwork/types/openwork-affordance";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import { currentLocale, t } from "../../../../i18n";
import type { SessionActivityStatus, SessionChildIds, SessionWaitingKind } from "./session-activity-store";

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

type WorkspaceAttentionInputs = {
  statuses?: Readonly<Record<string, SessionActivityStatus>>;
  waiting?: Readonly<Record<string, SessionWaitingKind>>;
  childIds?: SessionChildIds;
  serverStatuses?: Readonly<Record<string, SessionActivityStatus>>;
  serverWaiting?: Readonly<Record<string, SessionWaitingKind>>;
  serverChildIds?: SessionChildIds;
};

export function createWorkspaceSessionAttentionSelector() {
  const cache = new WeakMap<readonly AttentionSession[], {
    inputs: WorkspaceAttentionInputs;
    locale: ReturnType<typeof currentLocale>;
    attention: Map<string, SessionAttention>;
  }>();
  return (sessions: readonly AttentionSession[], inputs: WorkspaceAttentionInputs) => {
    const locale = currentLocale();
    const previous = cache.get(sessions);
    if (previous
      && previous.locale === locale
      && previous.inputs.statuses === inputs.statuses
      && previous.inputs.waiting === inputs.waiting
      && previous.inputs.childIds === inputs.childIds
      && previous.inputs.serverStatuses === inputs.serverStatuses
      && previous.inputs.serverWaiting === inputs.serverWaiting
      && previous.inputs.serverChildIds === inputs.serverChildIds) return previous.attention;
    const attention = selectSessionAttention(
      sessions,
      (id) => inputs.serverStatuses?.[id] ?? inputs.statuses?.[id],
      (id) => inputs.serverWaiting?.[id] ?? inputs.waiting?.[id],
      (id) => [...inputs.childIds?.[id] ?? [], ...inputs.serverChildIds?.[id] ?? []],
    );
    cache.set(sessions, { inputs, locale, attention });
    return attention;
  };
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
