import { Archive, ArchiveRestore, CheckCheck, Columns2, FolderPlus, Pencil, Pin, PinOff, Tag, Trash2, Undo2 } from "lucide-react";

import type { MenuAction } from "@/components/ui/action-menu-model";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { t } from "@/i18n";
import type { SessionSettleState } from "./session-settle";

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

export function buildSessionGroupActions(options: GroupActionsOptions): MenuAction[] {
  return [
    { type: "item", id: "ungroup", label: t("session_management.no_group"), disabled: !options.assignedGroupId,
      onSelect: () => options.onAssignGroup(null) },
    ...options.groups.map((group): MenuAction => ({
      type: "item", id: `group:${group.id}`, label: group.label, disabled: options.assignedGroupId === group.id,
      onSelect: () => options.onAssignGroup(group.id),
    })),
    ...(options.onCreateGroup ? [{ type: "separator" }, {
      type: "item", id: "new-group", label: t("session_management.new_group"), icon: <FolderPlus className="size-4" />,
      onSelect: options.onCreateGroup,
    }] satisfies MenuAction[] : []),
  ];
}

/** Human UI actions only. Destructive callbacks must open the existing safeguards/dialogs. */
export function buildSessionMenuActions(options: GroupActionsOptions & {
  isPinned: boolean;
  isArchived: boolean;
  settle?: SessionSettleState;
  onTogglePin: () => void;
  onOpenSplit?: () => void;
  onCloseSplit?: () => void;
  onRename?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}): MenuAction[] {
  const { settle } = options;
  const actions: MenuAction[] = [{
    type: "item", id: "pin", label: options.isPinned ? t("session_management.unpin_session") : t("session_management.pin_session"),
    icon: options.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />, onSelect: options.onTogglePin,
  }];
  if (settle?.available && !options.isArchived) actions.push({
    type: "item", id: "settle", label: settle.settled ? t("session_management.unsettle_session") : t("session_management.settle_session"),
    icon: settle.settled ? <Undo2 className="size-4" /> : <CheckCheck className="size-4" />,
    disabled: !settle.settled && !settle.canSettle,
    disabledReason: !settle.settled && !settle.canSettle ? t("session_management.settle_after_finish") : undefined,
    dataAttributes: { "data-session-menu-settle": true }, onSelect: settle.toggle,
  });
  if (options.onOpenSplit) actions.push({
    type: "item", id: "open-split", label: t("session_management.open_in_split_view"), icon: <Columns2 className="size-4" />,
    dataAttributes: { "data-session-menu-open-split": true }, onSelect: options.onOpenSplit,
  });
  if (options.onCloseSplit) actions.push({
    type: "item", id: "close-split", label: t("session_management.close_split_view"), icon: <Columns2 className="size-4" />,
    dataAttributes: { "data-session-menu-close-split": true }, onSelect: options.onCloseSplit,
  });
  if (options.onRename) actions.push({
    type: "item", id: "rename", label: t("workspace_list.rename_session"), icon: <Pencil className="size-4" />, onSelect: options.onRename,
  });
  actions.push({
    type: "item", id: "move-to-group", label: t("session_management.move_to_group"), icon: <Tag className="size-4" />,
    submenu: buildSessionGroupActions(options), submenuClassName: { dropdown: "w-52" },
  });
  if (options.onArchive) actions.push({
    type: "item", id: "archive", label: options.isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session"),
    icon: options.isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />, onSelect: options.onArchive,
  });
  if (options.onDelete) actions.push({ type: "separator" }, {
    type: "item", id: "delete", label: t("workspace_list.delete_session"), icon: <Trash2 className="size-4" />,
    variant: "destructive", onSelect: options.onDelete,
  });
  return actions;
}
