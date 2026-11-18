import { describe, expect, test } from "bun:test";

import { panelSessionForFileLink, panelSessionForWorkbench } from "../src/react-app/domains/session/chat/workbench-panel-session";

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

describe("panelSessionForFileLink", () => {
  const link = {
    sourceSessionId: "side",
    panelSessionId: "main",
    primarySessionId: "main",
    primaryWorkspaceId: "ws",
    split: { workspaceId: "ws", sessionId: "side" },
    splitTakesPanel: false,
  };

  test("shows a split pane file in the main chat's panel when that is the only panel", () => {
    expect(panelSessionForFileLink(link)).toBe("main");
  });

  test("opens the split pane chat's own panel when it can take the panel", () => {
    expect(panelSessionForFileLink({ ...link, splitTakesPanel: true })).toBe("side");
  });

  test("opens the main chat's panel for a main chat file while the split pane's panel shows", () => {
    expect(panelSessionForFileLink({ ...link, sourceSessionId: "main", panelSessionId: "side", splitTakesPanel: true })).toBe("main");
  });

  test("uses the panel on screen for a file from its own chat or from no chat", () => {
    expect(panelSessionForFileLink({ ...link, sourceSessionId: "main" })).toBe("main");
    expect(panelSessionForFileLink({ ...link, sourceSessionId: null })).toBe("main");
  });

  test("keeps a file from another workspace with its own chat", () => {
    expect(panelSessionForFileLink({ ...link, split: { workspaceId: "other", sessionId: "side" } })).toBe("side");
  });
});
