import { describe, expect, test } from "bun:test";

import {
  SESSION_NUMBER_SHORTCUT_LIMIT,
  assignSessionNumberShortcuts,
  getSessionNumberShortcutIntent,
  isSessionNumberShortcutBlockingOwner,
  isSessionNumberModifierKey,
  isSessionNumberModifierPressed,
  nextSessionNumberModifierHeld,
  resolveSessionNumberShortcutOs,
  sessionNumberAriaKeyShortcut,
  sessionNumberShortcutDescription,
  sessionNumberShortcutHelp,
  sessionNumberShortcutLabel,
  type SessionNumberShortcutCandidate,
  type SessionNumberShortcutOs,
  type SessionNumberShortcutTransition,
} from "../src/react-app/shell/session-number-shortcuts";

const macModifier = {
  key: "Meta",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

const available = {
  ownerActive: false,
  cancelled: false,
};

describe("visible session number shortcut ordering", () => {
  test("numbers only actionable rows in exact pinned, grouped, nested, and regular visual order", () => {
    const candidates: SessionNumberShortcutCandidate[] = [
      { workspaceId: "a", sessionId: "pinned", visible: true, actionable: true },
      { workspaceId: "a", sessionId: "pinned-child", visible: true, actionable: true },
      { workspaceId: "a", sessionId: "group-heading", visible: true, actionable: false },
      { workspaceId: "a", sessionId: "group-one", visible: true, actionable: true },
      { workspaceId: "a", sessionId: "collapsed-child", visible: false, actionable: true },
      { workspaceId: "a", sessionId: "group-two", visible: true, actionable: true },
      { workspaceId: "a", sessionId: "show-more", visible: true, actionable: false },
      { workspaceId: "a", sessionId: "filtered", visible: false, actionable: true },
      { workspaceId: "b", sessionId: "loading", visible: true, actionable: false },
      ...Array.from({ length: 8 }, (_, index) => ({
        workspaceId: "b",
        sessionId: `regular-${index + 1}`,
        visible: true,
        actionable: true,
      })),
    ];

    expect(assignSessionNumberShortcuts(candidates)).toEqual([
      { workspaceId: "a", sessionId: "pinned", digit: 1 },
      { workspaceId: "a", sessionId: "pinned-child", digit: 2 },
      { workspaceId: "a", sessionId: "group-one", digit: 3 },
      { workspaceId: "a", sessionId: "group-two", digit: 4 },
      { workspaceId: "b", sessionId: "regular-1", digit: 5 },
      { workspaceId: "b", sessionId: "regular-2", digit: 6 },
      { workspaceId: "b", sessionId: "regular-3", digit: 7 },
      { workspaceId: "b", sessionId: "regular-4", digit: 8 },
      { workspaceId: "b", sessionId: "regular-5", digit: 9 },
    ]);
    expect(assignSessionNumberShortcuts(candidates)).toHaveLength(SESSION_NUMBER_SHORTCUT_LIMIT);
  });
});

describe("session number shortcut keyboard ownership", () => {
  test("tracks modifier press and every required cleanup transition", () => {
    expect(getSessionNumberShortcutIntent(macModifier, "macos", available)).toEqual({ type: "hold" });
    expect(nextSessionNumberModifierHeld("modifier-down")).toBe(true);
    const cleanupTransitions: SessionNumberShortcutTransition[] = [
      "modifier-up",
      "modifier-mismatch",
      "blur",
      "focus",
      "visibility-hidden",
      "owner-change",
      "unmount",
    ];
    for (const transition of cleanupTransitions) {
      expect(nextSessionNumberModifierHeld(transition)).toBe(false);
    }
    expect(isSessionNumberModifierKey("Meta", "macos")).toBe(true);
    expect(isSessionNumberModifierKey("Control", "windows")).toBe(true);
  });

  test("reconciles held state from later keyboard and pointer modifier flags", () => {
    expect(isSessionNumberModifierPressed(macModifier, "macos")).toBe(true);
    expect(isSessionNumberModifierPressed({ metaKey: false, ctrlKey: false }, "macos")).toBe(false);
    expect(isSessionNumberModifierPressed({ metaKey: false, ctrlKey: true }, "windows")).toBe(true);
    expect(isSessionNumberModifierPressed({ metaKey: false, ctrlKey: false }, "windows")).toBe(false);
    expect(nextSessionNumberModifierHeld("modifier-mismatch")).toBe(false);
    expect(nextSessionNumberModifierHeld("focus")).toBe(false);
  });

  test("activates digits globally but still yields to modal owners", () => {
    const digit = { ...macModifier, key: "4" };
    expect(getSessionNumberShortcutIntent(digit, "macos", available)).toEqual({ type: "activate", digit: 4 });
    expect(getSessionNumberShortcutIntent(digit, "macos", { ...available, ownerActive: true })).toEqual({ type: "ignore" });
    expect(getSessionNumberShortcutIntent(digit, "macos", { ...available, cancelled: true })).toEqual({ type: "ignore" });
    expect(getSessionNumberShortcutIntent({ ...digit, shiftKey: true }, "macos", available)).toEqual({ type: "ignore" });
    expect(getSessionNumberShortcutIntent({ ...digit, ctrlKey: true }, "macos", available)).toEqual({ type: "ignore" });
  });

  test("keeps open selects and menus non-blocking while dialogs retain ownership", () => {
    const element = (attributes: Record<string, string>) => ({
      getAttribute: (name: string) => attributes[name] ?? null,
    });

    expect(isSessionNumberShortcutBlockingOwner(element({ role: "listbox" }))).toBe(false);
    expect(isSessionNumberShortcutBlockingOwner(element({ role: "menu" }))).toBe(false);
    expect(isSessionNumberShortcutBlockingOwner(
      element({ role: "dialog", "data-slot": "popover-content" }),
    )).toBe(false);
    expect(isSessionNumberShortcutBlockingOwner(element({ role: "dialog" }))).toBe(true);
    expect(isSessionNumberShortcutBlockingOwner(element({ role: "alertdialog" }))).toBe(true);
    expect(isSessionNumberShortcutBlockingOwner(element({ "data-slot": "dialog-content" }))).toBe(true);
  });
});

describe("session number shortcut platform and accessibility metadata", () => {
  test("uses Command labels and Meta aria shortcuts on macOS", () => {
    expect(resolveSessionNumberShortcutOs(undefined, "MacIntel")).toBe("macos");
    expect(sessionNumberShortcutLabel("macos", 3)).toBe("⌘3");
    expect(sessionNumberAriaKeyShortcut("macos", 3)).toBe("Meta+3");
    expect(sessionNumberShortcutDescription("macos", 3)).toContain("⌘3");
    expect(sessionNumberShortcutHelp("macos").meta).toBe("⌘1–⌘9");
  });

  test("uses Ctrl labels and Control aria shortcuts on Windows and Linux", () => {
    expect(resolveSessionNumberShortcutOs(undefined, "Win32")).toBe("windows");
    expect(resolveSessionNumberShortcutOs(undefined, "Linux x86_64")).toBe("linux");
    const controlPlatforms: SessionNumberShortcutOs[] = ["windows", "linux"];
    for (const os of controlPlatforms) {
      expect(sessionNumberShortcutLabel(os, 7)).toBe("Ctrl+7");
      expect(sessionNumberAriaKeyShortcut(os, 7)).toBe("Control+7");
      expect(sessionNumberShortcutHelp(os).meta).toBe("Ctrl+1–9");
    }
  });
});
