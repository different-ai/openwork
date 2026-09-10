import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { SessionActivityStatus } from "../status/session-activity-store";

export type ControlSessionActivity = {
  status: SessionActivityStatus;
  updatedAt: number;
  waitingQuestionIds: string[];
  waitingPermissionIds: string[];
};

export function observedSessionActivity(record: ControlSessionActivity | undefined): {
  freshness: "cached" | "unknown";
  observedAt: number | null;
  status: SessionActivityStatus | null;
  questions: number | null;
  permissions: number | null;
} {
  return {
    freshness: record ? "cached" : "unknown",
    observedAt: record?.updatedAt ?? null,
    status: record?.status ?? null,
    // Default empty arrays can come from run/transcript observations alone.
    // Without per-kind snapshot evidence, only a nonzero cached wait is known.
    questions: record?.waitingQuestionIds.length ? record.waitingQuestionIds.length : null,
    permissions: record?.waitingPermissionIds.length ? record.waitingPermissionIds.length : null,
  };
}

export function observedSessionAttention(record: ControlSessionActivity | undefined): {
  questions: number | null; permissions: number | null;
  questionFreshness: "cached" | "unknown"; permissionFreshness: "cached" | "unknown";
} {
  const activity = observedSessionActivity(record);
  return { questions: activity.questions, permissions: activity.permissions,
    questionFreshness: activity.questions === null ? "unknown" : "cached",
    permissionFreshness: activity.permissions === null ? "unknown" : "cached" };
}

export function sessionAttentionRevision(records: Record<string, Record<string, ControlSessionActivity>>) {
  return JSON.stringify(Object.entries(records).flatMap(([workspaceId, sessions]) =>
    Object.entries(sessions).flatMap(([sessionId, record]) => record.waitingQuestionIds.length || record.waitingPermissionIds.length
      ? [[workspaceId, sessionId, record.waitingQuestionIds.length, record.waitingPermissionIds.length]] : [])));
}

export type ControlSessionWorkspace = {
  id: string;
  name?: string | null;
  path?: string | null;
  displayName?: string | null;
};

export type ControlSessionLike = {
  id?: string;
  title?: string;
  time?: {
    updated?: number;
    created?: number;
  };
};

export type ListedControlSession = {
  sessionId: string;
  workspaceId: string;
  title: string;
  workspace: string;
  updatedAt: number;
  pinned: boolean;
  activity: ReturnType<typeof observedSessionActivity> & ReturnType<typeof observedSessionAttention>;
};

export type ListControlSessionsState = {
  workspaces: ControlSessionWorkspace[];
  sessionsByWorkspaceId: Record<string, ControlSessionLike[]>;
  pinnedIds: readonly string[];
  activityByWorkspaceId?: Record<string, Record<string, ControlSessionActivity>>;
  activityCacheIds?: Record<string, string | null>;
};

export function controlWorkspaceLabel(workspace: ControlSessionWorkspace) {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || "workspace";
}

function matchesWorkspace(workspace: ControlSessionWorkspace, query: string) {
  const lower = query.toLowerCase();
  return workspace.id.toLowerCase() === lower || controlWorkspaceLabel(workspace).toLowerCase() === lower;
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

/**
 * `session.list_sessions`: sessions the app already holds in memory, pinned
 * first then newest first. `args` is the raw control-action payload; the list
 * is only truncated when it carries a positive integer `limit`, and an
 * unknown `workspaceId` yields no sessions rather than another workspace's.
 * A silent cap here made large workspaces impossible to inventory.
 */
export function listControlSessions(args: unknown, state: ListControlSessionsState): ListedControlSession[] {
  const record = argsRecord(args);
  const workspaceQuery = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  const limit = record.limit;
  const out: ListedControlSession[] = [];
  for (const workspace of state.workspaces) {
    if (workspaceQuery && !matchesWorkspace(workspace, workspaceQuery)) continue;
    const cacheId = state.activityCacheIds?.[workspace.id];
    for (const session of state.sessionsByWorkspaceId[workspace.id] ?? []) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      out.push({
        sessionId,
        workspaceId: workspace.id,
        title: getDisplaySessionTitle(session.title ?? ""),
        workspace: controlWorkspaceLabel(workspace),
        updatedAt: session.time?.updated ?? session.time?.created ?? 0,
        pinned: state.pinnedIds.includes(sessionId),
        activity: {
          ...observedSessionActivity(cacheId ? state.activityByWorkspaceId?.[cacheId]?.[sessionId] : undefined),
          ...observedSessionAttention(cacheId ? state.activityByWorkspaceId?.[cacheId]?.[sessionId] : undefined),
        },
      });
    }
  }
  out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? out.slice(0, limit) : out;
}
