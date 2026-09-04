import { describe, expect, test } from "bun:test";

import {
  COMMAND_PALETTE_RECENTS_KEY,
  loadPaletteRecents,
  recordPaletteRecent,
} from "../src/react-app/shell/command-palette-recents";

function fakeStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (key: string) => key === COMMAND_PALETTE_RECENTS_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === COMMAND_PALETTE_RECENTS_KEY) value = next;
    },
  };
}

describe("command palette recents", () => {
  test("loads only valid string ids", () => {
    const storage = fakeStorage(JSON.stringify(["one", 2, "two", "one"]));
    expect(loadPaletteRecents(storage)).toEqual(["one", "two"]);
  });

  test("moves selections to the front, dedupes, and caps at eight", () => {
    const storage = fakeStorage(JSON.stringify(["one", "two", "three", "four", "five", "six", "seven", "eight"]));
    expect(recordPaletteRecent("session:workspace:id", storage)).toEqual([
      "session:workspace:id", "one", "two", "three", "four", "five", "six", "seven",
    ]);
    expect(recordPaletteRecent("three", storage)[0]).toBe("three");
  });

  test("ignores malformed storage", () => {
    expect(loadPaletteRecents(fakeStorage("not json"))).toEqual([]);
  });
});
