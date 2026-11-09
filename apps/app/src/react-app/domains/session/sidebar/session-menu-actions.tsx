import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { sessionAction, type SessionAction } from "./session-action-catalog";

export type SessionActionTarget = { workspaceId: string; sessionId: string; title: string };

export function captureSessionActionTarget(
  groups: readonly { workspace: { id: string }; sessions: readonly { id: string; title?: string }[] }[],
  sessionId: string,
  workspaceId: string,
): SessionActionTarget | null {
  const session = groups.find((group) => group.workspace.id === workspaceId)?.sessions.find((entry) => entry.id === sessionId);
  return session ? { sessionId, workspaceId, title: getDisplaySessionTitle(session.title) } : null;
}

type GroupActionsOptions = {
  groups: readonly { id: string; label: string }[];
  assignedGroupId: string | null;
  onAssignGroup: (groupId: string | null) => void;
  /** Create only: creating a group never moves this session into it. */
  onCreateGroup?: () => void;
};

export function buildSessionGroupActions(options: GroupActionsOptions): SessionAction[] {
  return [
    sessionAction("ungroup", { disabled: !options.assignedGroupId, onSelect: () => options.onAssignGroup(null) }),
    ...options.groups.map((group) => sessionAction("group", {
      id: `group:${group.id}`, label: group.label, disabled: options.assignedGroupId === group.id,
      onSelect: () => options.onAssignGroup(group.id),
    })),
    ...(options.onCreateGroup ? [{ type: "separator" }, sessionAction("new-group", { onSelect: options.onCreateGroup })] satisfies SessionAction[] : []),
  ];
}

/** Human UI actions only. Destructive callbacks open the existing safeguards/dialogs. */
export function buildSessionMenuActions(options: GroupActionsOptions & {
  isPinned: boolean;
  isArchived: boolean;
  onTogglePin: () => void;
  onRename?: () => void;
  onArchive?: () => void | Promise<void>;
  onDelete?: () => void;
}): SessionAction[] {
  const actions: SessionAction[] = [sessionAction("pin", { onSelect: options.onTogglePin }, options)];
  if (options.onRename) actions.push(sessionAction("rename", { onSelect: options.onRename }));
  actions.push(sessionAction("move-to-group", { submenu: buildSessionGroupActions(options), submenuClassName: { dropdown: "w-52" } }));
  if (options.onArchive) actions.push(sessionAction("archive", { onSelect: options.onArchive }, options));
  if (options.onDelete) actions.push({ type: "separator" }, sessionAction("delete", { onSelect: options.onDelete }));
  return actions;
}
