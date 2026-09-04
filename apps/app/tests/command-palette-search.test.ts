import { describe, expect, test } from "bun:test";

import {
  rankPaletteItems,
  type PaletteItem,
} from "../src/react-app/shell/command-palette-search";

function item(input: Omit<PaletteItem, "action">): PaletteItem {
  return { ...input, action: () => {} };
}

describe("command palette search", () => {
  test("shows recent items first in stored order for an empty query", () => {
    const items = [
      item({ id: "one", title: "One" }),
      item({ id: "two", title: "Two", group: "settings" }),
    ];

    const groups = rankPaletteItems("  ", items, ["two", "one"]);

    expect(groups[0]?.value).toBe("recent");
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(["two", "one"]);
  });

  test("ranks a keyword match for Permissions above Preferences", () => {
    const groups = rankPaletteItems("folders", [
      item({ id: "settings:preferences", title: "Preferences", keywords: ["default folder"], group: "settings" }),
      item({ id: "settings:permissions", title: "Permissions", keywords: ["authorized folders"], group: "settings" }),
    ], []);

    expect(groups[0]?.items[0]?.id).toBe("settings:permissions");
  });

  test("limits > searches to actions", () => {
    const groups = rankPaletteItems(">", [
      item({ id: "action", title: "Action" }),
      item({ id: "setting", title: "Setting", group: "settings" }),
    ], []);

    expect(groups.map((group) => group.value)).toEqual(["actions"]);
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(["action"]);
  });

  test("requires every query token to match", () => {
    const appearance = item({
      id: "settings:appearance",
      title: "Appearance",
      keywords: ["theme dark mode"],
      group: "settings",
    });

    expect(rankPaletteItems("appearance theme", [appearance], [])).toHaveLength(1);
    expect(rankPaletteItems("appearance sessions", [appearance], [])).toEqual([]);
  });

  test("uses recency to break equal-score ties", () => {
    const first = item({ id: "first", title: "Open dashboard" });
    const recent = item({ id: "recent", title: "Open dashboard" });

    const groups = rankPaletteItems("dashboard", [first, recent], ["recent"]);

    expect(groups[0]?.items[0]?.id).toBe("recent");
  });

  test("ranks exact title and alias phrases above fuzzy title partials", () => {
    const items = [
      item({
        id: "models",
        title: "Switch model",
        detail: "Choose the LLM that runs your next prompts",
        searchText: "model models llm provider openai anthropic claude gpt gemini switch pick select default",
      }),
      item({
        id: "settings:appearance",
        title: "Appearance",
        keywords: ["theme", "dark mode", "light mode", "color", "font", "look"],
        group: "settings",
      }),
      item({
        id: "settings:preferences",
        title: "Preferences",
        keywords: ["default model", "reasoning", "thinking", "compaction", "effort"],
        group: "settings",
      }),
    ];

    expect(rankPaletteItems("dark mode", items, [])[0]?.items[0]?.id).toBe("settings:appearance");
    expect(rankPaletteItems("theme", items, [])[0]?.items[0]?.id).toBe("settings:appearance");
    expect(rankPaletteItems("model", items, [])[0]?.items[0]?.id).toBe("models");
  });

  test("ranks current session pin and rename actions first", () => {
    const items = [
      item({
        id: "settings:permissions",
        title: "Permissions",
        keywords: ["authorized folders", "folder access", "file access", "allow", "permission denied", "sandbox", "approvals"],
        group: "settings",
      }),
      item({
        id: "session.pin.toggle",
        title: "Pin session",
        keywords: ["pin", "unpin", "favorite", "star", "keep on top", "sidebar"],
        group: "actions",
      }),
      item({
        id: "session.rename",
        title: "Rename session…",
        keywords: ["rename", "title", "name", "edit title"],
        group: "actions",
      }),
    ];

    expect(rankPaletteItems("pin", items, [])[0]?.items[0]?.id).toBe("session.pin.toggle");
    expect(rankPaletteItems("rename", items, [])[0]?.items[0]?.id).toBe("session.rename");
  });
});
