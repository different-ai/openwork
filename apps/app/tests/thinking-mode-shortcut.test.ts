import { describe, expect, test } from "bun:test";

import {
  getThinkingModeShortcutDirection,
  isThinkingModeShortcut,
  resolveThinkingModeShortcutOs,
  thinkingModeShortcutLabel,
} from "../src/react-app/shell/thinking-mode-shortcut";

const event = (overrides: Partial<KeyboardEvent> = {}) => ({
  altKey: false,
  ctrlKey: false,
  key: "t",
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("thinking mode shortcut", () => {
  test("uses Control+T on macOS without colliding with Command+T", () => {
    expect(resolveThinkingModeShortcutOs("macos", "")).toBe("macos");
    expect(thinkingModeShortcutLabel("macos")).toBe("⌃T");
    expect(thinkingModeShortcutLabel("macos", "reverse")).toBe("⌃⇧T");
    expect(isThinkingModeShortcut(event({ ctrlKey: true }), "macos")).toBe(true);
    expect(getThinkingModeShortcutDirection(event({ ctrlKey: true }), "macos")).toBe("forward");
    expect(isThinkingModeShortcut(event({ metaKey: true }), "macos")).toBe(false);
  });

  test("uses Control+Shift+T to cycle backward on macOS without taking Command+Shift+T", () => {
    expect(getThinkingModeShortcutDirection(event({ ctrlKey: true, shiftKey: true }), "macos")).toBe("reverse");
    expect(getThinkingModeShortcutDirection(event({ metaKey: true, shiftKey: true }), "macos")).toBeNull();
  });

  test("uses Control+Alt+T where Control+T owns session tab cycling", () => {
    expect(thinkingModeShortcutLabel("other")).toBe("Ctrl+Alt+T");
    expect(thinkingModeShortcutLabel("other", "reverse")).toBe("Ctrl+Alt+Shift+T");
    expect(isThinkingModeShortcut(event({ ctrlKey: true, altKey: true }), "other")).toBe(true);
    expect(getThinkingModeShortcutDirection(event({ ctrlKey: true, altKey: true }), "other")).toBe("forward");
    expect(isThinkingModeShortcut(event({ ctrlKey: true }), "other")).toBe(false);
  });

  test("adds Shift to the non-macOS thinking shortcut without taking the session-tab shortcut", () => {
    expect(getThinkingModeShortcutDirection(event({ ctrlKey: true, altKey: true, shiftKey: true }), "other")).toBe("reverse");
    expect(getThinkingModeShortcutDirection(event({ ctrlKey: true, shiftKey: true }), "other")).toBeNull();
  });

  test("falls back to navigator platform for web builds", () => {
    expect(resolveThinkingModeShortcutOs(undefined, "MacIntel")).toBe("macos");
    expect(resolveThinkingModeShortcutOs(undefined, "Win32")).toBe("other");
  });
});
