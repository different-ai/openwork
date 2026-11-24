import type { ThinkingModeShortcutOs } from "./thinking-mode-shortcut";

type FastModeShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "code" | "metaKey" | "shiftKey"> & {
  getModifierState?: (key: string) => boolean;
};

export function fastModeShortcutLabel(os: ThinkingModeShortcutOs) {
  return os === "macos" ? "⌃⇧F" : "Ctrl+Alt+F";
}

export function isFastModeShortcut(event: FastModeShortcutEvent, os: ThinkingModeShortcutOs) {
  if (event.getModifierState?.("AltGraph")) return false;
  const isF = event.code === "KeyF" || event.key.toLowerCase() === "f";
  if (!isF || event.metaKey || !event.ctrlKey) return false;
  return os === "macos"
    ? event.shiftKey && !event.altKey
    : event.altKey && !event.shiftKey;
}
