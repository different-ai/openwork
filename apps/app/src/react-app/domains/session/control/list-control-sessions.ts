import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { SessionActivityStatus } from "../status/session-activity-store";

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
  title: string;
  workspace: string;
  updatedAt: number;
  pinned: boolean;
  /** Live activity, the same source as the sidebar indicator. */
  status: SessionActivityStatus;
  /** True while a turn, subtask, compaction, permission, or question is still open. */
  working: boolean;
};

export type ListControlSessionsState = {
  workspaces: ControlSessionWorkspace[];
  sessionsByWorkspaceId: Record<string, ControlSessionLike[]>;
  pinnedIds: readonly string[];
  statusFor: (workspaceId: string, sessionId: string) => SessionActivityStatus;
};

/** Anything but a finished or failed turn still needs Stop before archive. */
export function isWorkingStatus(status: SessionActivityStatus): boolean {
  return status !== "idle" && status !== "error";
}

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
    for (const session of state.sessionsByWorkspaceId[workspace.id] ?? []) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      const status = state.statusFor(workspace.id, sessionId);
      out.push({
        sessionId,
        title: getDisplaySessionTitle(session.title ?? ""),
        workspace: controlWorkspaceLabel(workspace),
        updatedAt: session.time?.updated ?? session.time?.created ?? 0,
        pinned: state.pinnedIds.includes(sessionId),
        status,
        working: isWorkingStatus(status),
      });
    }
  }
  out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? out.slice(0, limit) : out;
}
