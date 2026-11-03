import type { SessionNumberShortcutOs } from "./session-number-shortcuts";

// Cmd+N on macOS, Ctrl+N on Windows/Linux. Works from anywhere, including the
// focused composer and other text fields, because N never types text while
// the primary modifier is down.

type NewSessionShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> & {
  getModifierState?: (key: string) => boolean;
};

export function isNewSessionShortcut(event: NewSessionShortcutEvent, os: SessionNumberShortcutOs) {
  // AltGr reports Control+Alt on Windows and must keep typing characters.
  if (event.getModifierState?.("AltGraph")) return false;
  if (event.shiftKey || event.altKey) return false;
  // Match the produced character (not event.code) so non-QWERTY layouts keep
  // Cmd+N on the key labelled N.
  if (event.key?.toLowerCase() !== "n") return false;
  return os === "macos"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
