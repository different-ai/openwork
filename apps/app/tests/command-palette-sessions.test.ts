import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { buildCommandPaletteSplitSessions } from "../src/react-app/shell/command-palette-sessions";
import type { SessionOption } from "../src/react-app/shell/command-palette";

const sessions: SessionOption[] = [
  {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    title: "Current",
    workspaceTitle: "Workspace A",
    updatedAt: 3,
    searchText: "current workspace a",
    isActive: true,
  },
  {
    workspaceId: "workspace-a",
    sessionId: "session-b",
    title: "Same workspace",
    workspaceTitle: "Workspace A",
    updatedAt: 2,
    searchText: "same workspace a",
    isActive: true,
  },
  {
    workspaceId: "workspace-b",
    sessionId: "session-a",
    title: "Same ID, other workspace",
    workspaceTitle: "Workspace B",
    updatedAt: 1,
    searchText: "same id workspace b",
    isActive: false,
  },
];

describe("command palette split sessions", () => {
  test("keeps conversation search out of the palette while preserving action pickers", () => {
    const source = readFileSync(new URL("../src/react-app/shell/command-palette.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("...sessionItems");
    expect(source).not.toContain('setMode("sessions")');
    expect(source).not.toContain('mode === "sessions"');
    expect(source).not.toContain('id: `session:');
    expect(source).toContain("Search actions and settings…");
    for (const items of ["rootItems", "coreActionItems", "settingsItems"]) {
      expect(source).toContain(`...${items}`);
    }
    expect(source).toContain("...(props.extraItems ?? [])");
    expect(source).toContain('setMode("split-sessions")');
  });

  test("preserves the dedicated conversation search shortcut and palette action", () => {
    const shortcuts = readFileSync(new URL("../src/react-app/shell/use-shell-shortcuts.ts", import.meta.url), "utf8");
    const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");

    expect(shortcuts).toMatch(/if \(event.shiftKey && !event.altKey && event.key\?\.toLowerCase\(\) === "f"\) \{\s*event.preventDefault\(\);\s*setSessionSearchOpen\(\(value\) => !value\);/);
    expect(route).toContain('id: "session-search.open"');
    expect(route).toContain("<SessionSearchDialog");
  });

  test("offers same-workspace and cross-workspace sessions but not the current session", () => {
    const options = buildCommandPaletteSplitSessions(sessions, {
      workspaceId: "workspace-a",
      sessionId: "session-a",
    });

    expect(options.map((option) => `${option.workspaceId}/${option.sessionId}`)).toEqual([
      "workspace-a/session-b",
      "workspace-b/session-a",
    ]);
    expect(options.some((option) => option.workspaceTitle === "Workspace B")).toBe(true);
    expect(options.some((option) => option.workspaceId === "workspace-a" && option.sessionId === "session-a")).toBe(false);
  });
});
