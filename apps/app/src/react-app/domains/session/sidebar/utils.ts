import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import type { WorkspaceSessionGroup } from "../../../../app/types";
import { isSandboxWorkspace } from "../../../../app/utils";
import { t } from "../../../../i18n";

export const MAX_SESSIONS_PREVIEW = 6;

export type SessionListItem = WorkspaceSessionGroup["sessions"][number];
export type FlattenedSessionRow = { session: SessionListItem };

export const isSessionArchived = (session: SessionListItem): boolean =>
  typeof session.time?.archived === "number" && session.time.archived > 0;

/** Active agent work shown as the left-lane loader (never a completion / unread state). */
export const isActiveWorkSessionStatus = (status: string | undefined) =>
  status === "running" ||
  status === "busy" ||
  status === "retry" ||
  status === "streaming" ||
  status === "thinking" ||
  status === "responding" ||
  status === "compacting";

/** Waiting is "needs you" on the right edge — not left-lane activity. */
export const isStreamingSessionStatus = (status: string | undefined) =>
  isActiveWorkSessionStatus(status) || status === "waiting";

export const isNeedsAttentionSessionStatus = (status: string | undefined) =>
  status === "waiting";

export function formatSessionRelativeTime(updatedAt: number | null | undefined): string | null {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const ms = updatedAt < 1_000_000_000_000 ? updatedAt * 1000 : updatedAt;
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const normalizeSessionParentID = (session: SessionListItem) => {
  const parentID = session.parentID?.trim();
  return parentID || "";
};

/**
 * A session with a parentID is a sub-agent child, whether or not its parent is
 * in the loaded page (the parent may be archived, deleted, or beyond the list
 * limit). Children are only reached from the task card in their parent.
 */
export const getRootSessions = (sessions: WorkspaceSessionGroup["sessions"]) =>
  sessions.filter((session) => !normalizeSessionParentID(session));

/**
 * Return every descendant of a session in stable session-list order. The
 * visited set keeps malformed cyclic parent data from looping forever.
 */
export const getSessionDescendantIds = (
  sessions: WorkspaceSessionGroup["sessions"],
  sessionId: string,
): string[] => {
  const root = sessionId.trim();
  if (!root) return [];

  const descendants: string[] = [];
  const visited = new Set([root]);
  let parents = new Set([root]);

  while (parents.size > 0) {
    const nextParents = new Set<string>();
    for (const session of sessions) {
      const id = session.id.trim();
      if (!id || visited.has(id)) continue;
      const parentID = normalizeSessionParentID(session);
      if (!parents.has(parentID)) continue;
      visited.add(id);
      descendants.push(id);
      nextParents.add(id);
    }
    parents = nextParents;
  }

  return descendants;
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

/**
 * Sub-agent (child) sessions never render in the sidebar: they are reached
 * through the task card in their parent's transcript. Only root sessions
 * become rows.
 */
export const flattenSessionRows = (
  sessions: WorkspaceSessionGroup["sessions"],
  rootLimit: number,
  pinnedIds: Set<string> = EMPTY_SET,
  orderIds: string[] = EMPTY_ARRAY,
  rootFilter?: { include?: Set<string>; exclude?: Set<string> },
): FlattenedSessionRow[] => {
  const { active } = partitionArchivedSessions(sessions);
  return orderRootSessions(getRootSessions(active), pinnedIds, orderIds)
    .filter((root) => (
      (!rootFilter?.include || rootFilter.include.has(root.id)) &&
      !rootFilter?.exclude?.has(root.id)
    ))
    .slice(0, rootLimit)
    .map((session) => ({ session }));
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
