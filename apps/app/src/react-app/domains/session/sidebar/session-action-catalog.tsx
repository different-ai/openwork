import { Archive, ArchiveRestore, Columns2, FolderPlus, Pencil, Pin, PinOff, Tag, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { MenuAction } from "@/components/ui/action-menu-model";
import { t } from "@/i18n";

export type SessionActionKind = "pin" | "open-split" | "choose-split" | "new-split" | "close-split"
  | "rename" | "move-to-group" | "archive" | "delete" | "ungroup" | "group" | "new-group";
type State = { isPinned?: boolean; isArchived?: boolean };
type Decision = { treatment: "included" } | { treatment: "adapted" | "excluded"; reason: string };
type PaletteDecision = { treatment: "adapted" | "excluded"; reason: string } | { treatment: "included"; id: string;
  keywords?: string[]; detail?: string; searchText?: string; meta?: string; group?: "actions"; keepOpen?: boolean };
type Definition = {
  label: (state: State) => string;
  icon?: (state: State) => ReactNode;
  variant?: "destructive";
  surfaces: { menu: Decision; palette: PaletteDecision; groupPicker: Decision; legacyQuick: Decision; feedQuick: Decision };
};
const included: Decision = { treatment: "included" };
const excluded = (reason: string): Decision => ({ treatment: "excluded", reason });
const adapted = (reason: string): { treatment: "adapted"; reason: string } => ({ treatment: "adapted", reason });
const menuOnly = { menu: included, groupPicker: excluded("Not a group destination"),
  legacyQuick: excluded("Only Pin and Archive have legacy shortcuts"), feedQuick: excluded("Only Archive has a Feed shortcut") };
const workbenchOnly = { ...menuOnly, menu: excluded("Palette intent; row opening is a separate intent") };
const groupOnly = { ...menuOnly, groupPicker: included, palette: adapted("Reached through the group picker") };

/** Every action must explicitly account for every human UI adapter. No open string allowlists. */
export const sessionActionCatalog: Record<SessionActionKind, Definition> = {
  pin: { label: (s) => s.isPinned ? t("session_management.unpin_session") : t("session_management.pin_session"),
    icon: (s) => s.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
    surfaces: { ...menuOnly, legacyQuick: included, palette: { treatment: "included", id: "session.pin.toggle", keywords: ["pin", "unpin", "favorite", "star", "keep on top", "sidebar"] } } },
  rename: { label: () => t("workspace_list.rename_session"), icon: () => <Pencil className="size-4" />,
    surfaces: { ...menuOnly, palette: { treatment: "included", id: "session.rename", keywords: ["rename", "title", "name", "edit title"] } } },
  archive: { label: (s) => s.isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session"),
    icon: (s) => s.isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
    surfaces: { ...menuOnly, legacyQuick: included, feedQuick: included, palette: { treatment: "included", id: "session.archive", keywords: ["archive", "restore", "unarchive", "done", "finished", "clear", "tidy", "sidebar"] } } },
  delete: { label: () => t("workspace_list.delete_session"), icon: () => <Trash2 className="size-4" />, variant: "destructive",
    surfaces: { ...menuOnly, palette: { treatment: "included", id: "session.delete", keywords: ["delete", "remove"] } } },
  "open-split": { label: () => t("session_management.open_in_split_view"), icon: () => <Columns2 className="size-4" />,
    surfaces: { ...menuOnly, palette: adapted("Choose an existing side chat instead of opening the route session") } },
  "choose-split": { label: () => `${t("session_management.open_in_split_view")}…`, icon: () => <Columns2 className="size-4" />,
    surfaces: { ...workbenchOnly, palette: { treatment: "included", id: "open-in-split-view", meta: "Workbench", group: "actions", keepOpen: true,
      detail: "Choose any session, including one from another workspace", searchText: "side chat split view side by side session workspace" } } },
  "new-split": { label: () => t("session_management.new_split"), icon: () => <Columns2 className="size-4" />,
    surfaces: { ...workbenchOnly, palette: { treatment: "included", id: "new-split", meta: "Workbench",
      detail: "Start an empty session beside this one", searchText: "new side chat new split empty session side by side pane" } } },
  "close-split": { label: () => t("session_management.close_split_view"), icon: () => <Columns2 className="size-4" />,
    surfaces: { ...menuOnly, palette: { treatment: "included", id: "close-split", meta: "Workbench", searchText: "close side chat split view pane keep conversation" } } },
  "move-to-group": { label: () => t("session_management.move_to_group"), icon: () => <Tag className="size-4" />,
    surfaces: { ...menuOnly, palette: adapted("Palette group submode also supports unsent drafts") } },
  ungroup: { label: () => t("session_management.no_group"), surfaces: groupOnly },
  group: { label: () => "", surfaces: groupOnly }, // Label is supplied by the named group, never its id.
  "new-group": { label: () => t("session_management.new_group"), icon: () => <FolderPlus className="size-4" />, surfaces: groupOnly },
};

export type SessionAction = { type: "separator" } | (Omit<Extract<MenuAction, { type: "item" }>, "id" | "submenu"> & {
  id: SessionActionKind | `group:${string}`;
  kind: SessionActionKind;
  submenu?: readonly SessionAction[];
});
export type SessionActionItem = Extract<SessionAction, { type: "item" }>;

type ActionOptions = Partial<Omit<SessionActionItem, "type" | "kind" | "id">>;
export function sessionAction(kind: "group", options: ActionOptions & { id: `group:${string}`; label: string }, state?: State): SessionActionItem;
export function sessionAction(kind: Exclude<SessionActionKind, "group">, options?: ActionOptions, state?: State): SessionActionItem;
export function sessionAction(kind: SessionActionKind, options: ActionOptions & { id?: `group:${string}` } = {}, state: State = {}): SessionActionItem {
  const definition = sessionActionCatalog[kind];
  return { type: "item", kind, id: kind, label: definition.label(state), icon: definition.icon?.(state), variant: definition.variant, ...options };
}

/** Unknown runtime descriptors fail closed, with a diagnostic rather than silently disappearing. */
export function sessionActionDefinition(action: SessionActionItem): Definition | undefined {
  const definition = sessionActionCatalog[action.kind];
  if (!definition) console.error("Unmapped session UI action", action.id);
  return definition;
}

export function sessionQuickActions(actions: readonly SessionAction[], surface: "legacyQuick" | "feedQuick"): SessionActionItem[] {
  return actions.flatMap((action) => action.type === "item" && sessionActionDefinition(action)?.surfaces[surface].treatment === "included" ? [action] : []);
}
