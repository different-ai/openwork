import { describe, expect, test } from "bun:test";

import {
  closeWorkbenchTab,
  focusWorkbenchPane,
  openWorkbenchTab,
  setWorkbenchSplit,
  syncWorkbenchSnapshot,
  type WorkbenchSnapshot,
} from "../src/react-app/domains/session/chat/workbench-store";

const emptyWorkbench: WorkbenchSnapshot = {
  revision: 0,
  workspaceId: null,
  workspaceTitle: null,
  primarySessionId: null,
  tabs: [],
  splitSessionId: null,
  focusedPane: "primary",
};

describe("workbench store", () => {
  test("retains open tabs and represents two visible sessions", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      workspaceTitle: "Customer workspace",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [
        { workspaceId: "workspace-a", sessionId: "session-a", title: "Primary" },
        { workspaceId: "workspace-a", sessionId: "session-b", title: "Secondary" },
      ],
    });
    state = openWorkbenchTab(state, {
      workspaceId: "workspace-a",
      sessionId: "session-b",
      title: "Secondary",
    });
    state = setWorkbenchSplit(state, "session-b");

    expect(state.tabs.map((tab) => tab.sessionId)).toEqual(["session-a", "session-b"]);
    expect(state.workspaceTitle).toBe("Customer workspace");
    expect(state.primarySessionId).toBe("session-a");
    expect(state.splitSessionId).toBe("session-b");
    expect(state.focusedPane).toBe("secondary");
  });

  test("focuses an existing split pane without duplicating its tab", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [
        { workspaceId: "workspace-a", sessionId: "session-a" },
        { workspaceId: "workspace-a", sessionId: "session-b" },
      ],
    });
    state = openWorkbenchTab(state, { workspaceId: "workspace-a", sessionId: "session-b" });
    state = setWorkbenchSplit(state, "session-b");
    state = focusWorkbenchPane(state, "primary");
    state = focusWorkbenchPane(state, "secondary");

    expect(state.tabs).toHaveLength(2);
    expect(state.focusedPane).toBe("secondary");
  });

  test("removes a closed split session and returns focus to primary", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [
        { workspaceId: "workspace-a", sessionId: "session-a" },
        { workspaceId: "workspace-a", sessionId: "session-b" },
      ],
    });
    state = openWorkbenchTab(state, { workspaceId: "workspace-a", sessionId: "session-b" });
    state = setWorkbenchSplit(state, "session-b");
    state = closeWorkbenchTab(state, "session-b");

    expect(state.splitSessionId).toBeNull();
    expect(state.focusedPane).toBe("primary");
  });

  test("keeps the same revision when synchronization changes nothing", () => {
    const state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-a", title: "Session" }],
    });
    const unchanged = syncWorkbenchSnapshot(state, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-a", title: "Session" }],
    });

    expect(unchanged).toBe(state);
    expect(unchanged.revision).toBe(state.revision);
  });

  test("does not prune retained tabs while the session index reloads", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [
        { workspaceId: "workspace-a", sessionId: "session-a" },
        { workspaceId: "workspace-a", sessionId: "session-b" },
      ],
    });
    state = openWorkbenchTab(state, { workspaceId: "workspace-a", sessionId: "session-b" });
    state = setWorkbenchSplit(state, "session-b");

    const loading = syncWorkbenchSnapshot(state, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: false,
      sessions: [],
    });

    expect(loading.tabs.map((tab) => tab.sessionId)).toEqual(["session-a", "session-b"]);
    expect(loading.splitSessionId).toBe("session-b");
  });
});
