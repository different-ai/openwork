import { isSameWorkbenchSession, type WorkbenchSessionTab } from "../chat/workbench-store";
import { sessionAction, type SessionAction } from "./session-action-catalog";
import { buildSessionMenuActions, type SessionActionTarget } from "./session-menu-actions";

type SessionRef = { workspaceId: string; sessionId: string };
export function canOpenSessionAsSideChat(row: SessionRef, primary?: SessionRef | null, secondary?: SessionRef | null) {
  return Boolean(primary) && !isSameWorkbenchSession(row, primary) && !isSameWorkbenchSession(row, secondary);
}

/** Row-open, chooser, new and close are distinct intents with shared visibility rules/metadata. */
export function resolveWorkbenchActions(options: {
  primary?: SessionRef | null; secondary?: SessionRef | null; row?: SessionRef;
  onOpenRow?: () => void; onChoose?: () => void; onNew?: () => void; onClose?: () => void;
}): SessionAction[] {
  const { row, primary, secondary } = options;
  const actions: SessionAction[] = [];
  if (row && options.onOpenRow && canOpenSessionAsSideChat(row, primary, secondary)) {
    actions.push(sessionAction("open-split", { dataAttributes: { "data-session-menu-open-split": true }, onSelect: options.onOpenRow }));
  }
  if (!row && primary && options.onChoose) actions.push(sessionAction("choose-split", { onSelect: options.onChoose }));
  if (!row && primary && options.onNew) actions.push(sessionAction("new-split", { onSelect: options.onNew }));
  if (options.onClose && (!row || (secondary && (isSameWorkbenchSession(row, primary) || isSameWorkbenchSession(row, secondary))))) {
    actions.push(sessionAction("close-split", { dataAttributes: { "data-session-menu-close-split": true }, onSelect: options.onClose }));
  }
  return actions;
}

type Management = {
  togglePin: (sessionId: string) => void;
  assignGroup: (workspaceId: string, sessionId: string, groupId: string | null) => void;
};
type Services = {
  management: () => Management;
  onOpenRenameSession?: (sessionId: string, workspaceId: string) => void;
  onOpenDeleteSession?: (sessionId: string, workspaceId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean, workspaceId: string) => void | Promise<void>;
  onOpenCreateGroupModal?: (workspaceId: string) => void;
  /** Palette uses the named dialog bridge, sidebar uses its existing dialog callbacks. */
  requestDialog?: (request: { action: "rename" | "delete"; target: SessionActionTarget }) => void;
};

/** Bound to an explicit owner/target, never current focus or a fallback workspace. No new safety service. */
export function resolveSessionActions(options: {
  target: SessionActionTarget;
  surface: "sidebar" | "palette";
  isPinned: boolean; isArchived: boolean;
  groups: readonly { id: string; label: string }[]; assignedGroupId: string | null;
  capabilities?: { rename: boolean; delete: boolean; archive: boolean };
  archiveDisabledReason?: string | null;
  services: Services;
  workbench?: {
    primary: WorkbenchSessionTab | null; secondary: WorkbenchSessionTab | null;
    workspaceTitle?: string;
    getState: () => { openTab: (tab: WorkbenchSessionTab) => void; setSplit: (tab: WorkbenchSessionTab | null) => void };
  };
}): SessionAction[] {
  const { services, isArchived, workbench } = options;
  const target = { ...options.target }; // Freeze identity/title before a palette closes or dialog opens.
  const rename = services.onOpenRenameSession || (options.capabilities?.rename && services.requestDialog);
  const remove = services.onOpenDeleteSession || (options.capabilities?.delete && services.requestDialog);
  // Preserve shipped surface differences: sidebar hides blocked Archive; route palette follows its runtime callback.
  const archive = services.onArchiveSession && options.capabilities?.archive !== false
    && (options.surface === "palette" || !options.archiveDisabledReason);
  const actions = buildSessionMenuActions({
    ...options,
    onTogglePin: () => services.management().togglePin(target.sessionId),
    onAssignGroup: (groupId) => services.management().assignGroup(target.workspaceId, target.sessionId, groupId),
    onCreateGroup: services.onOpenCreateGroupModal ? () => services.onOpenCreateGroupModal?.(target.workspaceId) : undefined,
    onRename: rename ? () => {
      if (services.onOpenRenameSession) services.onOpenRenameSession(target.sessionId, target.workspaceId);
      else services.requestDialog?.({ action: "rename", target });
    } : undefined,
    onDelete: remove ? () => {
      if (services.onOpenDeleteSession) services.onOpenDeleteSession(target.sessionId, target.workspaceId);
      else services.requestDialog?.({ action: "delete", target });
    } : undefined,
    onArchive: archive ? () => services.onArchiveSession?.(target.sessionId, !isArchived, target.workspaceId) : undefined,
  });
  const sideActions = workbench ? resolveWorkbenchActions({
    row: target, primary: workbench.primary, secondary: workbench.secondary,
    onOpenRow: () => {
      const tab = { ...target, workspaceTitle: workbench.workspaceTitle?.trim() || target.workspaceId };
      const state = workbench.getState();
      state.openTab(tab);
      state.setSplit(tab);
    },
    onClose: () => workbench.getState().setSplit(null),
  }) : [];
  actions.splice(1, 0, ...sideActions);
  return actions;
}
