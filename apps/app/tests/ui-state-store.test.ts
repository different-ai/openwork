import { afterAll, describe, expect, test } from "bun:test";

import type { UiState } from "../src/react-app/shell/ui-state-store";

const PERSISTED_UI_STATE_KEY = "openwork:ui-state:v1";
const originalWindow = globalThis.window;

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

const { persistUiState, toggleSidePanelState, useUiStateStore } = await import(
  "../src/react-app/shell/ui-state-store"
);

const importedSidePanelState = useUiStateStore.getState().sidePanelState;
const importedWorkspaceRightSidebarExpanded = useUiStateStore.getState().workspaceRightSidebarExpanded;

afterAll(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("ui state store", () => {
  test("persists UI state without side panel state", () => {
    const state: UiState = {
      sidebarOpen: true,
      sidePanelState: { ses_1: "extensions" },
      applicationMenuVisible: false,
      workspaceLeftSidebarWidth: 260,
      workspaceLeftSidebarResizing: false,
      workspaceRightSidebarExpanded: true,
      workspaceRightSidebarExpandedWidth: 520,
    };

    persistUiState(state);

    const parsed = requireJsonObject(storage.getItem(PERSISTED_UI_STATE_KEY));
    expect("sidePanelState" in parsed).toBe(false);
    expect(objectValue(parsed, "workspaceRightSidebarExpanded")).toBe(true);
  });

  test("ignores legacy persisted side panel state on startup", () => {
    expect(importedSidePanelState).toEqual({});
    expect(importedWorkspaceRightSidebarExpanded).toBe(true);
  });

  test("keeps side panel toggles in memory", () => {
    const state: UiState = {
      sidebarOpen: true,
      sidePanelState: {},
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
});
