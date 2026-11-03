import type { SessionNumberShortcutOs } from "./session-number-shortcuts";

// Cmd+Shift+E on macOS, Ctrl+Shift+E on Windows/Linux settles the open session,
// or un-settles it when it is already settled. Works from the composer too:
// E never types text while the primary modifier is down.

type SettleSessionShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> & {
  getModifierState?: (key: string) => boolean;
};

export const SETTLE_SESSION_CHORD = "Mod+Shift+E";

export function isSettleSessionShortcut(event: SettleSessionShortcutEvent, os: SessionNumberShortcutOs) {
  // AltGr reports Control+Alt on Windows and must keep typing characters.
  if (event.getModifierState?.("AltGraph")) return false;
  if (!event.shiftKey || event.altKey) return false;
  if (event.key?.toLowerCase() !== "e") return false;
  return os === "macos"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
