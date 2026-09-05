import { afterAll, describe, expect, test } from "bun:test";

import type { UiState } from "../src/react-app/shell/ui-state-store";

const PERSISTED_UI_STATE_KEY = "openwork:ui-state:v1";
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function requireJsonObject(raw: string | null): object {
  expect(raw).not.toBeNull();
  if (raw === null) {
    throw new Error("Expected persisted UI state JSON");
  }

  const parsed: unknown = JSON.parse(raw);
  expect(parsed).not.toBeNull();
  expect(typeof parsed).toBe("object");
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Expected persisted UI state object");
  }

  return parsed;
}

function objectValue(object: object, key: string): unknown {
  return Object.entries(object).find(([entryKey]) => entryKey === key)?.[1];
}

const storage = memoryStorage();
storage.setItem(
  PERSISTED_UI_STATE_KEY,
  JSON.stringify({ sidePanelState: { ses_1: "extensions" }, workspaceRightSidebarExpanded: true }),
);

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    document: { cookie: "" },
    localStorage: storage,
  },
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});

const { expandWorkspace, persistUiState, toggleSidePanelState, toggleWorkspaceExpanded, useUiStateStore } = await import(
  "../src/react-app/shell/ui-state-store"
);
const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");

const importedSidePanelState = useUiStateStore.getState().sidePanelState;
const importedWorkspaceRightSidebarExpanded = useUiStateStore.getState().workspaceRightSidebarExpanded;

afterAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
});

describe("ui state store", () => {
  test("persists UI state without side panel state", () => {
    const state: UiState = {
      sidebarOpen: true,
      sidePanelState: { ses_1: "extensions" },
      expandedWorkspaceIds: ["ws_1"],
      applicationMenuVisible: false,
      workspaceLeftSidebarWidth: 260,
      workspaceLeftSidebarResizing: false,
      workspaceRightSidebarExpanded: true,
      workspaceRightSidebarExpandedWidth: 520,
    };

    persistUiState(state);

    const parsed = requireJsonObject(storage.getItem(PERSISTED_UI_STATE_KEY));
    expect("sidePanelState" in parsed).toBe(false);
    expect("expandedWorkspaceIds" in parsed).toBe(false);
    expect(objectValue(parsed, "workspaceRightSidebarExpanded")).toBe(true);
    expect(objectValue(parsed, "workspaceRightSidebarExpandedWidth")).toBe(520);
  });

  test("ignores legacy persisted side panel state on startup", () => {
    expect(importedSidePanelState).toEqual({});
    expect(importedWorkspaceRightSidebarExpanded).toBe(true);
  });

  test("keeps side panel toggles in memory", () => {
    const state: UiState = {
      sidebarOpen: true,
      sidePanelState: {},
      expandedWorkspaceIds: [],
      applicationMenuVisible: false,
      workspaceLeftSidebarWidth: 260,
      workspaceLeftSidebarResizing: false,
      workspaceRightSidebarExpanded: false,
      workspaceRightSidebarExpandedWidth: 520,
    };

    const opened = toggleSidePanelState(state, "ses_1", "extensions");
    expect(opened.sidePanelState).toEqual({ ses_1: "extensions" });

    const closed = toggleSidePanelState(opened, "ses_1", "extensions");
    expect(closed.sidePanelState).toEqual({ ses_1: null });
  });

  test("keeps sidebar workspace expansion in the store so it survives the sidebar unmounting", () => {
    // Opening Settings unmounts the session sidebar. Expansion state must
    // outlive that, so it lives in the store rather than component state.
    const base: UiState = {
      sidebarOpen: true,
      sidePanelState: {},
      expandedWorkspaceIds: [],
      applicationMenuVisible: false,
      workspaceLeftSidebarWidth: 260,
      workspaceLeftSidebarResizing: false,
      workspaceRightSidebarExpanded: false,
      workspaceRightSidebarExpandedWidth: 520,
    };

    const one = expandWorkspace(base, " ws_1 ");
    expect(one.expandedWorkspaceIds).toEqual(["ws_1"]);
    expect(expandWorkspace(one, "ws_1")).toBe(one);
    expect(expandWorkspace(one, "  ")).toBe(one);

    const two = toggleWorkspaceExpanded(one, "ws_2");
    expect(two.expandedWorkspaceIds).toEqual(["ws_1", "ws_2"]);
    const collapsed = toggleWorkspaceExpanded(two, "ws_1");
    expect(collapsed.expandedWorkspaceIds).toEqual(["ws_2"]);

    useUiStateStore.getState().expandWorkspace("ws_store");
    useUiStateStore.getState().toggleWorkspaceExpanded("ws_toggle");
    expect(useUiStateStore.getState().expandedWorkspaceIds).toEqual(["ws_store", "ws_toggle"]);
    useUiStateStore.getState().toggleWorkspaceExpanded("ws_toggle");
    expect(useUiStateStore.getState().expandedWorkspaceIds).toEqual(["ws_store"]);
  });

  test("preserves active panel content while the panel closes and reopens", () => {
    usePanelTabStore.getState().openTab("ses_preserve", {
      id: "file:report.md",
      type: "artifact",
      label: "report.md",
      preview: "markdown",
    });

    const closed = toggleSidePanelState({
      ...useUiStateStore.getState(),
      sidePanelState: { ses_preserve: "panel" },
    }, "ses_preserve", "panel");
    const reopened = toggleSidePanelState(closed, "ses_preserve", "panel");

    expect(reopened.sidePanelState.ses_preserve).toBe("panel");
    expect(usePanelTabStore.getState().sessions.ses_preserve?.activeTabId).toBe("file:report.md");
    usePanelTabStore.getState().clearSession("ses_preserve");
  });

  test("preserves workspace-tree artifact tabs when transcript artifacts resync", () => {
    const target = {
      id: "file:src/example.ts",
      kind: "file" as const,
      value: "src/example.ts",
      name: "example.ts",
      preview: "code" as const,
      confidence: 100,
      reason: "workspace tree",
      exists: true,
    };
    usePanelTabStore.getState().openTab("ses_tree", {
      id: target.id,
      type: "artifact",
      label: target.name,
      preview: target.preview,
      target,
    });

    usePanelTabStore.getState().syncTranscriptArtifacts("ses_tree", []);

    expect(usePanelTabStore.getState().sessions.ses_tree?.tabs).toEqual([
      expect.objectContaining({ id: target.id, target }),
    ]);
    usePanelTabStore.getState().clearSession("ses_tree");
  });
});
