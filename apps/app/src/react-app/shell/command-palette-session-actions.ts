import { dispatchMenuAction } from "@/components/ui/action-menu-model";
import { sessionActionDefinition, type SessionAction } from "@/react-app/domains/session/sidebar/session-action-catalog";
import type { PaletteItem } from "./command-palette-search";

/** Project included catalog entries; other intents stay in their existing menu or group picker. */
export function sessionMenuActionsToPalette(actions: readonly SessionAction[], title: string, onClose: () => void): PaletteItem[] {
  return actions.flatMap((action): PaletteItem[] => {
    if (action.type !== "item") return [];
    const presentation = sessionActionDefinition(action)?.palette;
    if (!presentation) return [];
    return [{
      id: presentation.id,
      title: action.label,
      detail: presentation.meta === "Workbench" ? presentation.detail : [title, action.disabledReason].filter(Boolean).join(" — "),
      meta: presentation.meta ?? "Session",
      group: presentation.meta === "Workbench" ? presentation.group : "actions",
      disabled: action.disabled,
      keywords: presentation.keywords,
      searchText: presentation.searchText,
      action: () => {
        if (action.disabled) return;
        if (!presentation.keepOpen) onClose();
        void dispatchMenuAction(actions, action.id);
      },
    }];
  });
}

export function sessionGroupActionsToPalette(actions: readonly SessionAction[], onClose: () => void): PaletteItem[] {
  return actions.flatMap((action): PaletteItem[] => {
    if (action.type !== "item" || !sessionActionDefinition(action)?.groupPicker) return [];
    return [{
      id: action.kind === "ungroup" ? "group:none" : action.kind === "new-group" ? "group:new" : action.id,
      title: action.label,
      disabled: action.disabled,
      meta: action.disabled ? "Current" : undefined,
      searchText: `group ${action.label}`,
      action: () => {
        if (action.disabled) return;
        onClose();
        void dispatchMenuAction(actions, action.id);
      },
    }];
  });
}
