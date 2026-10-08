export const COMPOSER_PLUS_MENU_RECENTS_KEY = "openwork.react.composer-plus-menu.recents";

const MAX_RECENTS = 6;

type RecentsStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): RecentsStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadComposerPlusMenuRecents(storage = browserStorage()): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(COMPOSER_PLUS_MENU_RECENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((id): id is string => typeof id === "string");
    return [...new Set(ids)].slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function recordComposerPlusMenuRecent(id: string, storage = browserStorage()): string[] {
  const next = [id, ...loadComposerPlusMenuRecents(storage).filter((recentId) => recentId !== id)].slice(0, MAX_RECENTS);
  if (!storage) return next;
  try {
    storage.setItem(COMPOSER_PLUS_MENU_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // A blocked or full localStorage should not prevent the pick.
  }
  return next;
}
