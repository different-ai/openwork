import type { SessionNumberShortcutOs } from "./session-number-shortcuts";

type NewSessionShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> & {
  getModifierState?: (key: string) => boolean;
};

export function isNewSessionShortcut(event: NewSessionShortcutEvent, os: SessionNumberShortcutOs) {
  if (event.getModifierState?.("AltGraph")) return false;
  if (event.shiftKey || event.altKey) return false;
  if (event.key?.toLowerCase() !== "n") return false;
  return os === "macos"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
