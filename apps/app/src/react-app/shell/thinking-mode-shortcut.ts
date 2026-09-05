export type ThinkingModeShortcutOs = "macos" | "other";
export type ThinkingModeShortcutDirection = "forward" | "reverse";

type ThinkingModeShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

export function resolveThinkingModeShortcutOs(
  os: "macos" | "windows" | "linux" | undefined,
  navigatorPlatform: string,
): ThinkingModeShortcutOs {
  if (os === "macos" || (os === undefined && /Mac/i.test(navigatorPlatform))) return "macos";
  return "other";
}

export function thinkingModeShortcutLabel(
  os: ThinkingModeShortcutOs,
  direction: ThinkingModeShortcutDirection = "forward",
) {
  if (direction === "reverse") {
    return os === "macos" ? "⌃⇧T" : "Ctrl+Alt+Shift+T";
  }
  return os === "macos" ? "⌃T" : "Ctrl+Alt+T";
}

export function isThinkingModeShortcut(event: ThinkingModeShortcutEvent, os: ThinkingModeShortcutOs) {
  return getThinkingModeShortcutDirection(event, os) !== null;
}

export function getThinkingModeShortcutDirection(
  event: ThinkingModeShortcutEvent,
  os: ThinkingModeShortcutOs,
): ThinkingModeShortcutDirection | null {
  if (event.key.toLowerCase() !== "t" || event.metaKey) return null;
  const matches = os === "macos"
    ? event.ctrlKey && !event.altKey
    : event.ctrlKey && event.altKey;
  if (!matches) return null;
  return event.shiftKey ? "reverse" : "forward";
}
