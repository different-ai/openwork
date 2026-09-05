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
