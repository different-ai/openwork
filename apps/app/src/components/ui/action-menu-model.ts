import type { ReactNode } from "react";
import type { NativeContextMenuItem, NativeContextMenuRequest } from "@/app/lib/desktop-types";

export type MenuAction = { type: "separator" } | {
  type: "item";
  id: string;
  label: string;
  icon?: ReactNode;
  webContent?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  variant?: "default" | "destructive";
  dataAttributes?: Record<`data-${string}`, string | boolean>;
  submenu?: readonly MenuAction[];
  submenuClassName?: Partial<Record<"context" | "dropdown", string>>;
  onSelect?: () => void | Promise<void>;
};

/** Only explicit, plain descriptors cross IPC; presentation and callbacks stay local. */
export function serializeMenuActions(actions: readonly MenuAction[]): NativeContextMenuItem[] {
  return actions.map((action) => {
    if (action.type === "separator") return { type: "separator" };
    return {
      type: "item",
      id: action.id,
      label: action.disabledReason ? `${action.label} (${action.disabledReason})` : action.label,
      enabled: !action.disabled,
      ...(action.submenu ? { submenu: serializeMenuActions(action.submenu) } : {}),
    };
  });
}

export async function dispatchMenuAction(actions: readonly MenuAction[], id: string | null): Promise<boolean> {
  if (!id) return false;
  const matches: { action: Extract<MenuAction, { type: "item" }>; disabled: boolean }[] = [];
  const visit = (items: readonly MenuAction[], disabled: boolean) => {
    for (const action of items) {
      if (action.type === "separator") continue;
      const blocked = disabled || Boolean(action.disabled);
      if (action.id === id) matches.push({ action, disabled: blocked });
      if (action.submenu) visit(action.submenu, blocked);
    }
  };
  visit(actions, false);
  const match = matches[0];
  if (matches.length !== 1 || !match || match.disabled || match.action.submenu || !match.action.onSelect) return false;
  await match.action.onSelect();
  return true;
}

// Native menus are window-wide, so a request from another row also supersedes us.
let latestNativeRequest: AbortController | undefined;

export function createNativeMenuController(showContextMenu: (request: NativeContextMenuRequest, signal?: AbortSignal) => Promise<string | null>) {
  let pending: AbortController | undefined;
  return {
    cancel() {
      pending?.abort();
      pending = undefined;
    },
    async show(actions: readonly MenuAction[], options: Omit<NativeContextMenuRequest, "items">): Promise<boolean> {
      latestNativeRequest?.abort();
      const request = new AbortController();
      pending = request;
      latestNativeRequest = request;
      try {
        const id = await showContextMenu({ ...options, items: serializeMenuActions(actions) }, request.signal);
        if (request.signal.aborted || pending !== request || latestNativeRequest !== request) return false;
        return await dispatchMenuAction(actions, id);
      } catch {
        // Dismissal and IPC failures never open a second, HTML menu.
        return false;
      } finally {
        if (pending === request) pending = undefined;
        if (latestNativeRequest === request) latestNativeRequest = undefined;
      }
    },
  };
}
