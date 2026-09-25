import type { ThinkingModeShortcutOs } from "./thinking-mode-shortcut";

// Toggle Fast for the focused conversation. Mirrors the thinking-mode chord:
// Control+Shift+F on macOS (Command+Shift+F searches every session) and
// Control+Alt+F elsewhere (Control+Shift+F is that search on Windows/Linux).

type FastModeShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "code" | "metaKey" | "shiftKey"> & {
  getModifierState?: (key: string) => boolean;
};

export function fastModeShortcutLabel(os: ThinkingModeShortcutOs) {
  return os === "macos" ? "⌃⇧F" : "Ctrl+Alt+F";
}

export function isFastModeShortcut(event: FastModeShortcutEvent, os: ThinkingModeShortcutOs) {
  // AltGr reports Control+Alt on Windows and must keep typing characters.
  if (event.getModifierState?.("AltGraph")) return false;
  const isF = event.code === "KeyF" || event.key.toLowerCase() === "f";
  if (!isF || event.metaKey || !event.ctrlKey) return false;
  return os === "macos"
    ? event.shiftKey && !event.altKey
    : event.altKey && !event.shiftKey;
}
