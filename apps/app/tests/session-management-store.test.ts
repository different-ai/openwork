import { beforeEach, describe, expect, test } from "bun:test";

import { useSessionManagementStore } from "../src/react-app/domains/session/sidebar/session-management-store";

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
});
