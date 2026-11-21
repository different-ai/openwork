import type { SessionNumberShortcutOs } from "./session-number-shortcuts";

type ArchiveSessionShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> & {
  getModifierState?: (key: string) => boolean;
};

export const ARCHIVE_SESSION_CHORD = "Mod+Shift+E";

export function isArchiveSessionShortcut(event: ArchiveSessionShortcutEvent, os: SessionNumberShortcutOs) {
  if (event.getModifierState?.("AltGraph")) return false;
  if (!event.shiftKey || event.altKey) return false;
  if (event.key?.toLowerCase() !== "e") return false;
  return os === "macos"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
