import type { WorkbenchSnapshot } from "../domains/session/chat/workbench-store";

export type FavoriteModelProviderScope = {
  workspaceId: string;
  sessionId: string | null;
  providerScopeKey: string;
};

type FavoriteModelTarget = FavoriteModelProviderScope & { pane: WorkbenchSnapshot["focusedPane"] };

export function captureFavoriteModelTarget(
  workbench: Pick<WorkbenchSnapshot, "focusedPane" | "secondary">,
  scope: FavoriteModelProviderScope,
): FavoriteModelTarget | null {
  if (workbench.focusedPane === "primary") return { ...scope, pane: "primary" };
  const secondary = workbench.secondary;
  if (!secondary || secondary.workspaceId !== scope.workspaceId) return null;
  return { ...scope, pane: "secondary", sessionId: secondary.sessionId };
}

export function isFavoriteModelTargetCurrent(
  target: FavoriteModelTarget,
  workbench: Pick<WorkbenchSnapshot, "focusedPane" | "secondary">,
  scope: FavoriteModelProviderScope,
): boolean {
  const current = captureFavoriteModelTarget(workbench, scope);
  return current !== null && current.pane === target.pane && current.workspaceId === target.workspaceId
    && current.sessionId === target.sessionId && current.providerScopeKey === target.providerScopeKey;
}

type FavoriteModelShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

export const favoriteModelShortcutLabel = "Ctrl+Shift+M";

export function isFavoriteModelShortcut(event: FavoriteModelShortcutEvent) {
  return event.key.toLowerCase() === "m"
    && event.ctrlKey
    && event.shiftKey
    && !event.altKey
    && !event.metaKey;
}
