import { describe, expect, test } from "bun:test";

import { panelSessionForChatItem, panelSessionForWorkbench } from "../src/react-app/domains/session/chat/workbench-panel-session";

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

describe("panelSessionForChatItem", () => {
  const link = {
    sourceSessionId: "side",
    panelSessionId: "main",
    primarySessionId: "main",
    primaryWorkspaceId: "ws",
    split: { workspaceId: "ws", sessionId: "side" },
  };

  test("opens the split pane chat's own panel for a split pane file", () => {
    expect(panelSessionForChatItem(link)).toBe("side");
  });

  test("shows a split pane draft's file in the main chat's panel", () => {
    expect(panelSessionForChatItem({ ...link, split: { ...link.split, draftDestination: {} } })).toBe("main");
  });

  test("opens the main chat's panel for a main chat file while the split pane's panel shows", () => {
    expect(panelSessionForChatItem({ ...link, sourceSessionId: "main", panelSessionId: "side" })).toBe("main");
  });

  test("uses the panel on screen for a file from its own chat or from no chat", () => {
    expect(panelSessionForChatItem({ ...link, sourceSessionId: "main" })).toBe("main");
    expect(panelSessionForChatItem({ ...link, sourceSessionId: null })).toBe("main");
  });

  test("keeps a file from another workspace with its own chat", () => {
    expect(panelSessionForChatItem({ ...link, split: { workspaceId: "other", sessionId: "side" } })).toBe("side");
  });
});
