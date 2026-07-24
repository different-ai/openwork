import { describe, expect, test } from "bun:test";

import {
  buildOpenworkContext,
  screenFromRoute,
} from "../src/react-app/shell/openwork-context-projector";
import type { WorkbenchSnapshot } from "../src/react-app/domains/session/chat/workbench-store";

type ContextProjectorInput = Parameters<typeof buildOpenworkContext>[0];

const baseInput: ContextProjectorInput = {
  route: "/workspace/workspace-a/session/session-a",
  revision: 4,
  capturedAt: "2026-07-23T12:00:00.000Z",
  workbench: {
    revision: 4,
    workspaceId: "workspace-a",
    workspaceTitle: "Customer workspace",
    primarySessionId: "session-a",
    tabs: [
      { workspaceId: "workspace-a", sessionId: "session-a", title: "Primary" },
      { workspaceId: "workspace-a", sessionId: "session-b", title: "Secondary" },
    ],
    splitSessionId: "session-b",
    focusedPane: "secondary",
  },
  ui: {
    sidebarOpen: true,
    sidePanelState: { "session-b": "panel" },
    applicationMenuVisible: false,
    workspaceRightSidebarExpanded: true,
  },
  panelSessions: {
    "session-b": {
      tabs: [{ id: "artifact-a", type: "artifact", label: "Report", preview: "markdown" }],
      activeTabId: "artifact-a",
    },
  },
  availableAffordances: [],
};

describe("OpenWork context projector", () => {
  test("projects the focused split session and its panel state", () => {
    const context = buildOpenworkContext(baseInput);

    expect(context.conversations.layout).toEqual({
      kind: "split",
      primarySessionId: "session-a",
      secondarySessionId: "session-b",
      focused: "secondary",
    });
    expect(context.resources.find((resource) => resource.kind === "workspace")?.title)
      .toBe("Customer workspace");
    expect(context.sidePanel).toEqual({
      open: true,
      ownerSessionId: "session-b",
      kind: "panel",
      tabs: [{ id: "artifact-a", kind: "artifact", label: "Report" }],
      activeTabId: "artifact-a",
    });
  });

  test("does not leak artifact tabs into a non-panel surface", () => {
    const context = buildOpenworkContext({
      ...baseInput,
      ui: {
        ...baseInput.ui,
        sidePanelState: { "session-b": "extensions" },
      },
    });

    expect(context.sidePanel.kind).toBe("extensions");
    expect(context.sidePanel.tabs).toEqual([]);
    expect(context.sidePanel.activeTabId).toBeNull();
  });
});

const splitWorkbench: WorkbenchSnapshot = {
  revision: 5,
  workspaceId: "workspace-a",
  workspaceTitle: "Workspace A",
  primarySessionId: "session-a",
  tabs: [
    { workspaceId: "workspace-a", sessionId: "session-a", title: "Current plan" },
    { workspaceId: "workspace-a", sessionId: "session-b", title: "Previous research" },
    { workspaceId: "workspace-a", sessionId: "session-c", title: "Draft" },
  ],
  splitSessionId: "session-b",
  focusedPane: "secondary",
};

function contextForRoute(route: string) {
  return buildOpenworkContext({
    route,
    revision: 7,
    capturedAt: "2026-07-23T10:59:00.000Z",
    workbench: splitWorkbench,
    ui: {
      sidebarOpen: false,
      sidePanelState: { "session-a": "panel" },
      applicationMenuVisible: false,
      workspaceRightSidebarExpanded: true,
    },
    panelSessions: {
      "session-a": {
        tabs: [{
          id: "browser-one",
          type: "browser",
          label: "OpenWork docs",
          url: "https://docs.openwork.so",
          favicon: null,
          status: "ready",
          canGoBack: false,
          canGoForward: false,
        }],
        activeTabId: "browser-one",
      },
    },
    availableAffordances: [],
  });
}

describe("OpenWork context projector", () => {
  test("represents all open tabs and both visible split sessions", () => {
    const context = contextForRoute("/workspace/workspace-a/session/session-a");

    expect(context.conversations.tabs.map((tab) => tab.sessionId)).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
    expect(context.conversations.layout).toEqual({
      kind: "split",
      primarySessionId: "session-a",
      secondarySessionId: "session-b",
      focused: "secondary",
    });
    expect(context.resources.find((resource) => resource.ref === "session:session-b")).toMatchObject({
      kind: "session",
      title: "Previous research",
      state: {
        open: true,
        visible: true,
        pane: "secondary",
        focused: true,
      },
    });
    expect(context.chrome.sidebarOpen).toBe(false);
    expect(context.execution).toEqual({
      queries: "parallel",
      commands: "serialized",
      busyCommandId: null,
      busyActor: null,
    });
    expect(context.sidePanel).toMatchObject({
      open: true,
      ownerSessionId: "session-a",
      kind: "panel",
      activeTabId: "browser-one",
    });
  });

  test("retains workbench context while settings is the active screen", () => {
    const context = contextForRoute("/workspace/workspace-a/settings/ai");

    expect(context.screen).toEqual({
      kind: "settings",
      route: "/workspace/workspace-a/settings/ai",
      workspaceId: "workspace-a",
      panel: "ai",
    });
    expect(context.conversations.layout.kind).toBe("split");
    expect(context.conversations.tabs).toHaveLength(3);
  });

  test("parses legacy and workspace-scoped routes without reading the DOM", () => {
    expect(screenFromRoute("/session/session-a")).toMatchObject({
      kind: "conversation",
      sessionId: "session-a",
    });
    expect(screenFromRoute("/settings/extensions")).toMatchObject({
      kind: "settings",
      panel: "extensions",
    });
  });
});
