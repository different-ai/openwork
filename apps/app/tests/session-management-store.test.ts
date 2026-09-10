import { beforeEach, describe, expect, test } from "bun:test";

import { useSessionManagementStore } from "../src/react-app/domains/session/sidebar/session-management-store";
import { sidebarPreviewCount, useSidebarPreviewStore } from "../src/react-app/domains/session/sidebar/sidebar-preview-store";

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

describe("app-session sidebar reveal depth", () => {
  beforeEach(() => useSidebarPreviewStore.setState({ scope: null, counts: {} }));

  test("keeps workspace and group depth separate and bounded, without persisting it", () => {
    const { showMore } = useSidebarPreviewStore.getState();
    showMore("owner-a", "workspace-a", 100);
    showMore("owner-a", "workspace-a", 100, "group-a");
    showMore("owner-a", "workspace-a", 14, "group-a");
    let counts = useSidebarPreviewStore.getState().counts;
    expect(sidebarPreviewCount(counts, "workspace-a")).toBe(12);
    expect(sidebarPreviewCount(counts, "workspace-a", "group-a")).toBe(14);
    expect(sidebarPreviewCount(counts, "workspace-b", "group-a")).toBe(6);
    expect(sidebarPreviewCount(counts, "workspace-a", "group-b")).toBe(6);
    for (let index = 0; index < 300; index += 1) showMore("owner-a", `workspace-${index}`, 100);
    counts = useSidebarPreviewStore.getState().counts;
    expect(Object.keys(counts)).toHaveLength(256);
    expect(sidebarPreviewCount(counts, "workspace-a")).toBe(6);
    expect(sidebarPreviewCount(counts, "workspace-299")).toBe(12);
    expect("persist" in useSidebarPreviewStore).toBe(false);
  });

  test("a new owner or unverified account never inherits another owner's depth", () => {
    const { showMore } = useSidebarPreviewStore.getState();
    showMore("owner-a", workspaceId, 100);
    showMore("owner-a", workspaceId, 100);
    showMore("owner-b", workspaceId, 100);
    expect(sidebarPreviewCount(useSidebarPreviewStore.getState().counts, workspaceId)).toBe(12);
    showMore(null, workspaceId, 100);
    expect(useSidebarPreviewStore.getState().scope).toBeNull();
    expect(sidebarPreviewCount(useSidebarPreviewStore.getState().counts, workspaceId)).toBe(12);
    showMore("owner-a", workspaceId, 100);
    expect(sidebarPreviewCount(useSidebarPreviewStore.getState().counts, workspaceId)).toBe(12);
  });
});
