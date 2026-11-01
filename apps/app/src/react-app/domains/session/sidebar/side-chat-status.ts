import type { WorkbenchSessionTab } from "../chat/workbench-store";
import { workbenchSessionKey } from "../chat/workbench-store";
import { isActiveWorkSessionStatus, isNeedsAttentionSessionStatus, isSessionArchived, type SessionListItem } from "./utils";

type SessionGroupLike = { workspace: { id: string }; sessions: readonly SessionListItem[] };

/**
 * A side chat's row is hidden while attached, so its running work lights its
 * main chat's loader. Waiting side chats keep their own visible row instead.
 */
export function withSideChatActivity(
  statusById: Readonly<Record<string, string>>,
  sideChats: Readonly<Record<string, WorkbenchSessionTab>>,
  groups: readonly SessionGroupLike[],
): Readonly<Record<string, string>> {
  const activeIds = new Set(groups.flatMap((group) => group.sessions
    .filter((session) => !isSessionArchived(session))
    .map((session) => workbenchSessionKey({ workspaceId: group.workspace.id, sessionId: session.id }))));
  let next: Record<string, string> | null = null;
  for (const group of groups) {
    for (const session of group.sessions) {
      if (isSessionArchived(session)) continue;
      const chat = sideChats[workbenchSessionKey({ workspaceId: group.workspace.id, sessionId: session.id })];
      if (!chat || !activeIds.has(workbenchSessionKey(chat))) continue;
      const own = statusById[session.id];
      if (own === "error" || isNeedsAttentionSessionStatus(own) || isActiveWorkSessionStatus(own)) continue;
      if (!isActiveWorkSessionStatus(statusById[chat.sessionId])) continue;
      next ??= { ...statusById };
      next[session.id] = "thinking";
    }
  }
  return next ?? statusById;
}

/** Attached side chats stay out of the list unless open or waiting on the person. */
export function shouldHideAttachedSideChat(attached: boolean, selected: boolean, status: string | undefined) {
  return attached && !selected && !isNeedsAttentionSessionStatus(status);
}
