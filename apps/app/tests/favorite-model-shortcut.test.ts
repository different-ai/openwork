import { describe, expect, test } from "bun:test";

import {
  favoriteModelShortcutLabel,
  isFavoriteModelShortcut,
} from "../src/react-app/shell/favorite-model-shortcut";

const event = (overrides: Partial<KeyboardEvent> = {}) => ({
  altKey: false,
  ctrlKey: false,
  key: "m",
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("favorite model shortcut", () => {
  test("uses Control+Shift+M", () => {
    expect(favoriteModelShortcutLabel).toBe("Ctrl+Shift+M");
    expect(isFavoriteModelShortcut(event({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  test("does not consume neighboring modifier combinations", () => {
    expect(isFavoriteModelShortcut(event({ ctrlKey: true }))).toBe(false);
    expect(isFavoriteModelShortcut(event({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isFavoriteModelShortcut(event({ ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false);
  });
});
