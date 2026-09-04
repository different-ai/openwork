export const COMMAND_PALETTE_RECENTS_KEY = "openwork.react.command-palette.recents";

type PaletteRecentsStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): PaletteRecentsStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadPaletteRecents(storage = browserStorage()): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(COMMAND_PALETTE_RECENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((id): id is string => typeof id === "string");
    return [...new Set(ids)].slice(0, 8);
  } catch {
    return [];
  }
}

export function recordPaletteRecent(
  id: string,
  storage = browserStorage(),
): string[] {
  const next = [id, ...loadPaletteRecents(storage).filter((recentId) => recentId !== id)].slice(0, 8);
  if (!storage) return next;
  try {
    storage.setItem(COMMAND_PALETTE_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // A blocked or full localStorage should not prevent running the action.
  }
  return next;
}
