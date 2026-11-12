import { Archive, ArchiveRestore, Columns2, FolderPlus, Pencil, Pin, PinOff, Tag, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { MenuAction } from "@/components/ui/action-menu-model";
import { t } from "@/i18n";

export type SessionActionKind =
  | "pin"
  | "open-split"
  | "choose-split"
  | "new-split"
  | "close-split"
  | "rename"
  | "move-to-group"
  | "archive"
  | "delete"
  | "ungroup"
  | "group"
  | "new-group";

type SessionActionState = { isPinned?: boolean; isArchived?: boolean };
type PalettePresentation = {
  id: string;
  keywords?: string[];
  detail?: string;
  searchText?: string;
  meta?: string;
  group?: "actions";
  keepOpen?: boolean;
};
type SessionActionDefinition = {
  label: (state: SessionActionState) => string;
  icon?: (state: SessionActionState) => ReactNode;
  variant?: "destructive";
  palette: false | PalettePresentation;
  groupPicker?: boolean;
  legacyQuick?: boolean;
  feedQuick?: boolean;
};

/** Shared presentation. Omitted shortcut/group flags are false; builders own menu order and availability. */
export const sessionActionCatalog: Record<SessionActionKind, SessionActionDefinition> = {
  pin: {
    label: (state) => state.isPinned ? t("session_management.unpin_session") : t("session_management.pin_session"),
    icon: (state) => state.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
    palette: {
      id: "session.pin.toggle",
      keywords: ["pin", "unpin", "favorite", "star", "keep on top", "sidebar"],
    },
    legacyQuick: true,
  },
  rename: {
    label: () => t("workspace_list.rename_session"),
    icon: () => <Pencil className="size-4" />,
    palette: { id: "session.rename", keywords: ["rename", "title", "name", "edit title"] },
  },
  archive: {
    label: (state) => state.isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session"),
    icon: (state) => state.isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
    palette: {
      id: "session.archive",
      keywords: ["archive", "restore", "unarchive", "done", "finished", "clear", "tidy", "sidebar"],
    },
    legacyQuick: true,
    feedQuick: true,
  },
  delete: {
    label: () => t("workspace_list.delete_session"),
    icon: () => <Trash2 className="size-4" />,
    variant: "destructive",
    palette: { id: "session.delete", keywords: ["delete", "remove"] },
  },
  "open-split": {
    label: () => t("session_management.open_in_split_view"),
    icon: () => <Columns2 className="size-4" />,
    // The palette uses the chooser instead of opening the route session.
    palette: false,
  },
  "choose-split": {
    label: () => `${t("session_management.open_in_split_view")}…`,
    icon: () => <Columns2 className="size-4" />,
    palette: {
      id: "open-in-split-view",
      meta: "Workbench",
      group: "actions",
      keepOpen: true,
      detail: "Choose any session, including one from another workspace",
      searchText: "side chat split view side by side session workspace",
    },
  },
  "new-split": {
    label: () => t("session_management.new_split"),
    icon: () => <Columns2 className="size-4" />,
    palette: {
      id: "new-split",
      meta: "Workbench",
      detail: "Start an empty session beside this one",
      searchText: "new side chat new split empty session side by side pane",
    },
  },
  "close-split": {
    label: () => t("session_management.close_split_view"),
    icon: () => <Columns2 className="size-4" />,
    palette: {
      id: "close-split",
      meta: "Workbench",
      searchText: "close side chat split view pane keep conversation",
    },
  },
  "move-to-group": {
    label: () => t("session_management.move_to_group"),
    icon: () => <Tag className="size-4" />,
    // The palette's group submode also supports unsent drafts.
    palette: false,
  },
  ungroup: {
    label: () => t("session_management.no_group"),
    palette: false,
    groupPicker: true,
  },
  group: {
    // Label is supplied by the named group, never its id.
    label: () => "",
    palette: false,
    groupPicker: true,
  },
  "new-group": {
    label: () => t("session_management.new_group"),
    icon: () => <FolderPlus className="size-4" />,
    palette: false,
    groupPicker: true,
  },
};

export type SessionActionItem = Omit<Extract<MenuAction, { type: "item" }>, "submenu"> & {
  kind: SessionActionKind;
  submenu?: readonly SessionAction[];
};
export type SessionAction = { type: "separator" } | SessionActionItem;

type ActionOptions = Partial<Omit<SessionActionItem, "type" | "kind">>;
export function sessionAction(
  kind: SessionActionKind,
  options: ActionOptions = {},
  state: SessionActionState = {},
): SessionActionItem {
  const definition = sessionActionCatalog[kind];
  return {
    type: "item",
    kind,
    id: kind,
    label: definition.label(state),
    icon: definition.icon?.(state),
    variant: definition.variant,
    ...options,
  };
}

/** Unknown runtime descriptors fail closed, with a diagnostic rather than silently disappearing. */
export function sessionActionDefinition(action: SessionActionItem): SessionActionDefinition | undefined {
  const definition = sessionActionCatalog[action.kind];
  if (!definition) console.error("Unmapped session UI action", action.id);
  return definition;
}

export function sessionQuickActions(actions: readonly SessionAction[], surface: "legacyQuick" | "feedQuick"): SessionActionItem[] {
  return actions.flatMap((action) => {
    if (action.type !== "item") return [];
    return sessionActionDefinition(action)?.[surface] ? [action] : [];
  });
}
