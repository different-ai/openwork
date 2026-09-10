import { getDisplaySessionTitle } from "../../../../app/lib/session-title";

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
};

export function controlWorkspaceLabel(workspace: ControlSessionWorkspace) {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || "workspace";
}

function matchesWorkspace(workspace: ControlSessionWorkspace, query: string) {
  const lower = query.toLowerCase();
  return workspace.id.toLowerCase() === lower || controlWorkspaceLabel(workspace).toLowerCase() === lower;
}

/**
 * Sessions the app already holds in memory, pinned first then newest first.
 * The list is only truncated when the caller asks for a `limit`; a silent cap
 * made large workspaces impossible to inventory through the control surface.
 */
export function listControlSessions(input: {
  workspaces: ControlSessionWorkspace[];
  sessionsByWorkspaceId: Record<string, ControlSessionLike[]>;
  pinnedIds: readonly string[];
  workspaceId?: string;
  limit?: number;
}): ListedControlSession[] {
  const workspaceQuery = input.workspaceId?.trim() ?? "";
  const out: ListedControlSession[] = [];
  for (const workspace of input.workspaces) {
    if (workspaceQuery && !matchesWorkspace(workspace, workspaceQuery)) continue;
    for (const session of input.sessionsByWorkspaceId[workspace.id] ?? []) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      out.push({
        sessionId,
        title: getDisplaySessionTitle(session.title ?? ""),
        workspace: controlWorkspaceLabel(workspace),
        updatedAt: session.time?.updated ?? session.time?.created ?? 0,
        pinned: input.pinnedIds.includes(sessionId),
      });
    }
  }
  out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  const limit = input.limit;
  return limit !== undefined && Number.isInteger(limit) && limit > 0 ? out.slice(0, limit) : out;
}
