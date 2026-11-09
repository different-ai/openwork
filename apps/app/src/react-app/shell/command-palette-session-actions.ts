import { dispatchMenuAction } from "@/components/ui/action-menu-model";
import { sessionActionDefinition, type SessionAction } from "@/react-app/domains/session/sidebar/session-action-catalog";
import type { PaletteItem } from "./command-palette-search";

/** Exhaustive catalog policy, not a second allowlist. Adapted actions have an explicit alternate home. */
export function sessionMenuActionsToPalette(actions: readonly SessionAction[], title: string, onClose: () => void): PaletteItem[] {
  return actions.flatMap((action): PaletteItem[] => {
    if (action.type !== "item") return [];
    const policy = sessionActionDefinition(action)?.surfaces.palette;
    if (!policy || policy.treatment !== "included") return [];
    return [{
      id: policy.id, title: action.label,
      detail: policy.meta === "Workbench" ? policy.detail : [title, action.disabledReason].filter(Boolean).join(" — "),
      meta: policy.meta ?? "Session", group: policy.meta === "Workbench" ? policy.group : "actions", disabled: action.disabled,
      keywords: policy.keywords, searchText: policy.searchText,
      action: () => {
        if (action.disabled) return;
        if (!policy.keepOpen) onClose();
        void dispatchMenuAction(actions, action.id);
      },
    }];
  });
}

export function sessionGroupActionsToPalette(actions: readonly SessionAction[], onClose: () => void): PaletteItem[] {
  return actions.flatMap((action): PaletteItem[] => {
    if (action.type !== "item" || sessionActionDefinition(action)?.surfaces.groupPicker.treatment !== "included") return [];
    return [{
      id: action.kind === "ungroup" ? "group:none" : action.kind === "new-group" ? "group:new" : action.id,
      title: action.label, disabled: action.disabled,
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
