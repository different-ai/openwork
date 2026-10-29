import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { t } from "@/i18n";
import { sessionActivityAt } from "@/react-app/domains/session/sidebar/session-settle";
import { getRootSessions } from "@/react-app/domains/session/sidebar/utils";

import type { SessionOption } from "./command-palette";
import type { RouteSession, RouteWorkspace } from "./route-workspaces";

export type CommandPaletteSessionRef = {
  workspaceId: string;
  sessionId: string;
};

export function buildCommandPaletteSplitSessions(
  sessions: SessionOption[],
  current: CommandPaletteSessionRef | null | undefined,
) {
  if (!current) return [];
  return sessions.filter((session) => (
    session.workspaceId !== current.workspaceId || session.sessionId !== current.sessionId
  ));
}

export function buildCommandPaletteSessions(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, RouteSession[]>,
  selectedWorkspaceId: string,
) {
  const options: SessionOption[] = [];

  for (const workspace of workspaces) {
    const workspaceTitle =
      workspace.displayName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      t("session.workspace_fallback");

    // Sub-agent sessions live inside their parent's task card, not in pickers.
    for (const session of getRootSessions(sessionsByWorkspaceId[workspace.id] ?? [])) {
      const sessionId = session.id.trim();
      if (!sessionId) continue;
      const title = getDisplaySessionTitle(session.title ?? "");
      const updatedAt = sessionActivityAt(session);
      options.push({
        workspaceId: workspace.id,
        sessionId,
        title,
        workspaceTitle,
        updatedAt,
        searchText: `${title} ${workspaceTitle}`.toLowerCase(),
        isActive: workspace.id === selectedWorkspaceId,
      });
    }
  }

  return options.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}
