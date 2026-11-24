import { beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";

const savedPreferences = new Map<string, string>();
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (name: string) => savedPreferences.get(name) ?? null,
    setItem: (name: string, value: string) => { savedPreferences.set(name, value); },
    removeItem: (name: string) => { savedPreferences.delete(name); },
  },
});
const { useSessionManagementStore } = await import("../src/react-app/domains/session/sidebar/session-management-store");
if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
else Reflect.deleteProperty(globalThis, "localStorage");

const workspaceId = "workspace-1";

function resetStore() {
  useSessionManagementStore.setState({
    pinnedIds: [],
    orderByWorkspace: {},
    groupsByWorkspace: {
      [workspaceId]: {
        groups: [
          { id: "group-a", label: "Alpha" },
          { id: "group-b", label: "Beta" },
        ],
        assignments: {
          "session-1": "group-a",
          "session-2": "group-a",
          "session-3": "group-b",
        },
      },
    },
  });
}

describe("session group management", () => {
  beforeEach(resetStore);

  test("renames an existing group", () => {
    useSessionManagementStore.getState().renameGroup(workspaceId, "group-a", "Renamed");

    expect(useSessionManagementStore.getState().groupsByWorkspace[workspaceId]?.groups).toEqual([
      { id: "group-a", label: "Renamed" },
      { id: "group-b", label: "Beta" },
    ]);
  });

  test("reordering pins keeps unloaded pins and cannot pin another session or change workspace order", () => {
    useSessionManagementStore.setState({ pinnedIds: ["a", "unloaded", "b"], orderByWorkspace: { [workspaceId]: ["a", "b"] } });
    useSessionManagementStore.getState().reorderPins(["b", "a", "b", "not-pinned"]);
    expect(useSessionManagementStore.getState().pinnedIds).toEqual(["b", "a", "unloaded"]);
    expect(useSessionManagementStore.getState().orderByWorkspace[workspaceId]).toEqual(["a", "b"]);
  });

  test("moves sessions to the selected destination before removing a group", () => {
    useSessionManagementStore.getState().removeGroup(workspaceId, "group-a", "group-b");

    const workspace = useSessionManagementStore.getState().groupsByWorkspace[workspaceId];
    expect(workspace?.groups).toEqual([{ id: "group-b", label: "Beta" }]);
    expect(workspace?.assignments).toEqual({
      "session-1": "group-b",
      "session-2": "group-b",
      "session-3": "group-b",
    });
  });

  test("moves sessions to ungrouped before removing a group", () => {
    useSessionManagementStore.getState().removeGroup(workspaceId, "group-a", null);

    expect(useSessionManagementStore.getState().groupsByWorkspace[workspaceId]?.assignments).toEqual({
      "session-3": "group-b",
    });
  });

  test("does not publish an equivalent server group snapshot", () => {
    const before = useSessionManagementStore.getState().groupsByWorkspace[workspaceId];
    let notifications = 0;
    const unsubscribe = useSessionManagementStore.subscribe(() => {
      notifications += 1;
    });

    useSessionManagementStore.getState().replaceWorkspaceGroups(workspaceId, {
      groups: before.groups.map((group) => ({ ...group })),
      assignments: { ...before.assignments },
    });

    unsubscribe();
    expect(useSessionManagementStore.getState().groupsByWorkspace[workspaceId]).toBe(before);
    expect(notifications).toBe(0);
  });
});

describe("sidebar view", () => {
  test("starts on Workspaces and restores either saved view", async () => {
    const store = useSessionManagementStore;
    const originalStorage = store.persist.getOptions().storage;
    const saved = new Map<string, string>();
    store.persist.setOptions({
      storage: createJSONStorage(() => ({
        getItem: (name) => saved.get(name) ?? null,
        setItem: (name, value) => { saved.set(name, value); },
        removeItem: (name) => { saved.delete(name); },
      })),
    });

    try {
      expect(store.getInitialState().sidebarView).toBe("workspaces");
      for (const view of ["feed", "workspaces"] satisfies Array<"feed" | "workspaces">) {
        store.getState().setSidebarView(view);
        const selectedPreference = saved.get("openwork.react.sessionManagement");
        // Reset in-memory state, then restore the saved preference as on restart.
        store.setState({ sidebarView: view === "feed" ? "workspaces" : "feed" });
        if (selectedPreference) saved.set("openwork.react.sessionManagement", selectedPreference);
        await store.persist.rehydrate();
        expect(store.getState().sidebarView).toBe(view);
      }
    } finally {
      store.persist.setOptions({ storage: originalStorage });
      store.setState({ sidebarView: store.getInitialState().sidebarView });
    }
  });
});
