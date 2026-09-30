import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { NEW_TASK_DRAFT_SESSION_ID, sessionDraftScopeKey } from "../sync/draft-store";
import { useWorkbenchStore, workbenchSessionKey, type WorkbenchSessionTab } from "./workbench-store";
import type { ComposerSessionState } from "../surface/composer-state-store";
import { encodeComposerMentionValue } from "../surface/composer/mention-encoding";

export type NewSessionDestination = {
  workspaceId: string;
  groupId?: string;
  parent?: WorkbenchSessionTab;
};

export function newSessionDraftSlot(destination: NewSessionDestination): string {
  if (!destination.groupId && !destination.parent) return NEW_TASK_DRAFT_SESSION_ID;
  return `${NEW_TASK_DRAFT_SESSION_ID}${JSON.stringify([destination.groupId ?? null, destination.parent?.sessionId ?? null])}`;
}

export function newSessionDraftOwnerKey(scope: string | null | undefined, destination: NewSessionDestination) {
  return sessionDraftScopeKey(scope, destination.workspaceId, newSessionDraftSlot(destination));
}

export function draftWorkspaceChangeBlocked(source: string, destination: string, state: ComposerSessionState) {
  if (source === destination) return false;
  const hasFileMentions = Object.entries(state.mentions).some(([value, kind]) => kind === "file" && state.draft.includes(`@${encodeComposerMentionValue(value)}`));
  return state.attachments.length > 0 || hasFileMentions || /file:\/\//i.test(state.draft);
}

/** One navigation-only command for every New session entry point. */
export function openNewSessionDraft(destination: NewSessionDestination, navigate: (path: string) => void) {
  const workbench = useWorkbenchStore.getState();
  if (destination.parent) {
    const existing = workbench.sideChats[workbenchSessionKey(destination.parent)];
    const tab = existing ?? {
      workspaceId: destination.parent.workspaceId,
      workspaceTitle: destination.parent.workspaceTitle,
      sessionId: newSessionDraftSlot(destination),
      title: "Draft",
      draftDestination: destination,
    };
    workbench.openTab(tab);
    workbench.setSideChat(destination.parent, tab);
    return;
  }
  workbench.focusPane("primary");
  const query = destination.groupId ? `?draftGroup=${encodeURIComponent(destination.groupId)}` : "";
  navigate(`${workspaceSessionRoute(destination.workspaceId)}${query}`);
}
