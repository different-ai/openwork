import { dispatchMenuAction, type MenuAction } from "@/components/ui/action-menu-model";
import type { PaletteItem } from "./command-palette-search";

const SESSION_ACTION_IDS: Record<string, string> = {
  pin: "session.pin.toggle", settle: "session.settle.toggle", rename: "session.rename",
  archive: "session.archive", delete: "session.delete",
};
const SESSION_ACTION_KEYWORDS: Record<string, string[]> = {
  pin: ["pin", "unpin", "favorite", "star", "keep on top", "sidebar"],
  settle: ["settle", "un-settle", "unsettle", "done", "finished", "clear", "tidy", "sidebar"],
  rename: ["rename", "title", "name", "edit title"],
  archive: ["archive", "restore", "unarchive"],
  delete: ["delete", "remove"],
};

/** Adapt the same human actions used by sidebar/native menus, never raw mutations. */
export function sessionMenuActionsToPalette(actions: readonly MenuAction[], title: string, onClose: () => void): PaletteItem[] {
  return actions.flatMap((action): PaletteItem[] => {
    if (action.type !== "item" || !SESSION_ACTION_IDS[action.id]) return [];
    return [{
      id: SESSION_ACTION_IDS[action.id], title: action.label,
      detail: [title, action.disabledReason].filter(Boolean).join(" — "),
      meta: "Session", group: "actions", disabled: action.disabled,
      keywords: SESSION_ACTION_KEYWORDS[action.id],
      action: () => {
        if (action.disabled) return;
        onClose();
        void dispatchMenuAction(actions, action.id);
      },
    }];
  });
}

export function sessionGroupActionsToPalette(actions: readonly MenuAction[], onClose: () => void): PaletteItem[] {
  return actions.flatMap((action): PaletteItem[] => action.type !== "item" ? [] : [{
    id: action.id === "ungroup" ? "group:none" : action.id === "new-group" ? "group:new" : action.id,
    title: action.label, disabled: action.disabled,
    meta: action.disabled ? "Current" : undefined,
    searchText: `group ${action.label}`,
    action: () => {
      if (action.disabled) return;
      onClose();
      void dispatchMenuAction(actions, action.id);
    },
  }]);
}
