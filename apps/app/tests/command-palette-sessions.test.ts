import { describe, expect, test } from "bun:test";

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
