import { describe, expect, test } from "bun:test";

import { panelSessionForWorkbench } from "../src/react-app/domains/session/chat/workbench-panel-session";

const base = {
  primarySessionId: "main",
  primaryWorkspaceId: "ws",
  split: { workspaceId: "ws", sessionId: "side" },
  splitPanelOpen: true,
  focusedPane: "secondary" as const,
};

describe("panelSessionForWorkbench", () => {
  test("shows the side chat's panel while you work in it and it has a page", () => {
    expect(panelSessionForWorkbench(base)).toBe("side");
  });

  test("returns to the main chat when you click back into it", () => {
    expect(panelSessionForWorkbench({ ...base, focusedPane: "primary" })).toBe("main");
  });

  test("keeps the main chat's panel while the side chat has nothing to show", () => {
    expect(panelSessionForWorkbench({ ...base, splitPanelOpen: false })).toBe("main");
  });

  test("ignores a draft, another workspace, and no side chat", () => {
    expect(panelSessionForWorkbench({ ...base, split: { ...base.split, draftDestination: {} } })).toBe("main");
    expect(panelSessionForWorkbench({ ...base, split: { workspaceId: "other", sessionId: "side" } })).toBe("main");
    expect(panelSessionForWorkbench({ ...base, split: null })).toBe("main");
  });
});
