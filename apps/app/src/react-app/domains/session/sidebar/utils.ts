import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import type { WorkspaceSessionGroup } from "../../../../app/types";
import { isSandboxWorkspace } from "../../../../app/utils";
import { t } from "../../../../i18n";

export const MAX_SESSIONS_PREVIEW = 6;

export type SessionListItem = WorkspaceSessionGroup["sessions"][number];
export type FlattenedSessionRow = { session: SessionListItem; depth: number };
export type SessionTreeState = {
  childrenByParent: Map<string, SessionListItem[]>;
  ancestorIdsBySessionId: Map<string, string[]>;
  descendantCountBySessionId: Map<string, number>;
  activeIds: Set<string>;
  streamingIds: Set<string>;
};

export const isSessionArchived = (session: SessionListItem): boolean =>
  typeof session.time?.archived === "number" && session.time.archived > 0;

export const isStreamingSessionStatus = (status: string | undefined) =>
  status === "running" ||
  status === "busy" ||
  status === "retry" ||
  status === "streaming" ||
  status === "thinking" ||
  status === "responding" ||
  status === "waiting";

const normalizeSessionParentID = (session: SessionListItem) => {
  const parentID = session.parentID?.trim();
  return parentID || "";
};

export const getRootSessions = (sessions: WorkspaceSessionGroup["sessions"]) => {
  const byID = new Set(sessions.map((session) => session.id));
  return sessions.filter((session) => {
    const parentID = normalizeSessionParentID(session);
    return !parentID || !byID.has(parentID);
  });
};

/** Split sessions into active vs. archived. Archived sessions live in their own section. */
export const partitionArchivedSessions = (sessions: WorkspaceSessionGroup["sessions"]) => {
  const active: SessionListItem[] = [];
  const archived: SessionListItem[] = [];
  for (const session of sessions) {
    (isSessionArchived(session) ? archived : active).push(session);
  }
  return { active, archived };
};

/**
 * Order root sessions: pinned first, then manual order, then server recency.
 */
export const orderRootSessions = (
  roots: SessionListItem[],
  pinnedIds: Set<string>,
  orderIds: string[],
): SessionListItem[] => {
  const byId = new Map(roots.map((root) => [root.id, root]));
  const ordered: SessionListItem[] = [];
  const used = new Set<string>();

  for (const id of orderIds) {
    const root = byId.get(id);
    if (!root || used.has(id)) continue;
    ordered.push(root);
    used.add(id);
  }
  for (const root of roots) {
    if (used.has(root.id)) continue;
    ordered.push(root);
    used.add(root.id);
  }

  // Stable partition: pinned roots float to the top, preserving relative order.
  const pinned = ordered.filter((root) => pinnedIds.has(root.id));
  const rest = ordered.filter((root) => !pinnedIds.has(root.id));
  return [...pinned, ...rest];
};

export const buildSessionTreeState = (
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
): SessionTreeState => {
  const childrenByParent = new Map<string, SessionListItem[]>();
  const ancestorIdsBySessionId = new Map<string, string[]>();
  const descendantCountBySessionId = new Map<string, number>();
  const activeIds = new Set<string>();
  const streamingIds = new Set<string>();
  // Archived sessions render in their own flat section, so they never join the
  // active tree (neither as roots nor as children of active sessions).
  const visibleSessions = sessions.filter((session) => !isSessionArchived(session));
  const sessionIds = new Set(visibleSessions.map((session) => session.id));

  visibleSessions.forEach((session) => {
    const parentID = normalizeSessionParentID(session);
    if (!parentID || !sessionIds.has(parentID)) return;
    const siblings = childrenByParent.get(parentID) ?? [];
    siblings.push(session);
    childrenByParent.set(parentID, siblings);
  });

  const walk = (session: SessionListItem, ancestors: string[]) => {
    ancestorIdsBySessionId.set(session.id, ancestors);
    const children = childrenByParent.get(session.id) ?? [];
    let descendantCount = 0;
    const ownStatus = sessionStatusById?.[session.id] ?? "idle";
    let subtreeActive = ownStatus !== "idle";
    let subtreeStreaming = isStreamingSessionStatus(ownStatus);

    children.forEach((child) => {
      const childState = walk(child, [...ancestors, session.id]);
      descendantCount += 1 + childState.descendantCount;
      subtreeActive = subtreeActive || childState.subtreeActive;
      subtreeStreaming = subtreeStreaming || childState.subtreeStreaming;
    });

    descendantCountBySessionId.set(session.id, descendantCount);
    if (subtreeActive) activeIds.add(session.id);
    if (subtreeStreaming) streamingIds.add(session.id);
    return { descendantCount, subtreeActive, subtreeStreaming };
  };

  getRootSessions(visibleSessions).forEach((session) => {
    walk(session, []);
  });

  return {
    childrenByParent,
    ancestorIdsBySessionId,
    descendantCountBySessionId,
    activeIds,
    streamingIds,
  };
};

export const flattenSessionRows = (
  sessions: WorkspaceSessionGroup["sessions"],
  rootLimit: number,
  tree: SessionTreeState,
  expandedSessionIds: Set<string>,
  forcedExpandedSessionIds: Set<string>,
  pinnedIds: Set<string> = EMPTY_SET,
  orderIds: string[] = EMPTY_ARRAY,
) => {
  const { active } = partitionArchivedSessions(sessions);
  const orderedRoots = orderRootSessions(getRootSessions(active), pinnedIds, orderIds).slice(0, rootLimit);
  const rows: FlattenedSessionRow[] = [];
  const visited = new Set<string>();

  const walk = (session: SessionListItem, depth: number) => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    rows.push({ session, depth });
    const children = tree.childrenByParent.get(session.id) ?? [];
    if (!children.length) return;
    const expanded = expandedSessionIds.has(session.id) || forcedExpandedSessionIds.has(session.id);
    if (!expanded) return;
    children.forEach((child) => walk(child, depth + 1));
  };

  orderedRoots.forEach((root) => walk(root, 0));
  return rows;
};

const EMPTY_SET: Set<string> = new Set();
const EMPTY_ARRAY: string[] = [];

export const workspaceLabel = (workspace: WorkspaceInfo) =>
  workspace.displayName?.trim() ||
  workspace.openworkWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.path?.trim() ||
  t("workspace_list.workspace_fallback");

export const workspaceKindLabel = (workspace: WorkspaceInfo) =>
  workspace.workspaceType === "remote"
    ? isSandboxWorkspace(workspace)
      ? t("workspace.sandbox_badge")
      : t("workspace.remote_badge")
    : t("workspace.local_badge");

const WORKSPACE_SWATCHES = ["#2563eb", "#5a67d8", "#f97316", "#10b981"];

export const workspaceSwatchColor = (seed: string) => {
  const value = seed.trim() || "workspace";
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return WORKSPACE_SWATCHES[Math.abs(hash) % WORKSPACE_SWATCHES.length];
};
