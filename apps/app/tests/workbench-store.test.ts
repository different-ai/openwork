import { describe, expect, test } from "bun:test";

import {
  closeWorkbenchTab,
  focusWorkbenchPane,
  openWorkbenchTab,
  setWorkbenchSplit,
  setWorkbenchSideChat,
  syncWorkbenchSnapshot,
  type WorkbenchSnapshot,
} from "../src/react-app/domains/session/chat/workbench-store";

const emptyWorkbench: WorkbenchSnapshot = {
  revision: 0,
  sideChats: {},
  primary: null,
  tabs: [],
  secondary: null,
  focusedPane: "primary",
};

describe("workbench store", () => {
  test("retains workspace ownership for two visible sessions", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      workspaceTitle: "Workspace A",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-a", title: "Primary" }],
    });
    state = openWorkbenchTab(state, {
      workspaceId: "workspace-b",
      workspaceTitle: "Workspace B",
      sessionId: "session-b",
      title: "Secondary",
    });
    state = setWorkbenchSplit(state, { workspaceId: "workspace-b", sessionId: "session-b" });

    expect(state.primary).toMatchObject({ workspaceId: "workspace-a", sessionId: "session-a" });
    expect(state.secondary).toMatchObject({ workspaceId: "workspace-b", sessionId: "session-b" });
    expect(state.tabs.map((tab) => `${tab.workspaceId}/${tab.sessionId}`)).toEqual([
      "workspace-a/session-a",
      "workspace-b/session-b",
    ]);
    expect(state.focusedPane).toBe("secondary");
  });

  test("preserves a cross-workspace secondary while the primary workspace synchronizes", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-a" }],
    });
    state = openWorkbenchTab(state, { workspaceId: "workspace-b", sessionId: "session-b" });
    state = setWorkbenchSplit(state, { workspaceId: "workspace-b", sessionId: "session-b" });

    const synchronized = syncWorkbenchSnapshot(state, {
      workspaceId: "workspace-a",
      workspaceTitle: "Workspace A renamed",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-a", title: "Primary renamed" }],
    });

    expect(synchronized.primary?.title).toBe("Primary renamed");
    expect(synchronized.secondary).toMatchObject({ workspaceId: "workspace-b", sessionId: "session-b" });
  });

  test("treats identical session IDs in different workspaces as distinct", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-shared",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-shared" }],
    });
    state = openWorkbenchTab(state, { workspaceId: "workspace-b", sessionId: "session-shared" });
    state = setWorkbenchSplit(state, { workspaceId: "workspace-b", sessionId: "session-shared" });

    expect(state.tabs).toHaveLength(2);
    expect(state.secondary?.workspaceId).toBe("workspace-b");
  });

  test("focuses and closes a secondary by its full workspace reference", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-a" }],
    });
    state = openWorkbenchTab(state, { workspaceId: "workspace-b", sessionId: "session-b" });
    state = setWorkbenchSplit(state, { workspaceId: "workspace-b", sessionId: "session-b" });
    state = focusWorkbenchPane(state, "primary");
    state = focusWorkbenchPane(state, "secondary");
    state = closeWorkbenchTab(state, { workspaceId: "workspace-b", sessionId: "session-b" });

    expect(state.secondary).toBeNull();
    expect(state.primary).toMatchObject({ workspaceId: "workspace-a", sessionId: "session-a" });
    expect(state.focusedPane).toBe("primary");
  });

  test("promotes the secondary session when the primary closes", () => {
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: true,
      sessions: [{ workspaceId: "workspace-a", sessionId: "session-a" }],
    });
    state = openWorkbenchTab(state, { workspaceId: "workspace-b", sessionId: "session-b" });
    state = setWorkbenchSplit(state, { workspaceId: "workspace-b", sessionId: "session-b" });
    state = closeWorkbenchTab(state, { workspaceId: "workspace-a", sessionId: "session-a" });

    expect(state.primary).toMatchObject({ workspaceId: "workspace-b", sessionId: "session-b" });
    expect(state.secondary).toBeNull();
    expect(state.focusedPane).toBe("primary");
    expect(state.tabs.map((tab) => `${tab.workspaceId}/${tab.sessionId}`)).toEqual([
      "workspace-b/session-b",
    ]);
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
  });

  test("does not prune retained same-workspace tabs while the session index reloads", () => {
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
    state = setWorkbenchSplit(state, { workspaceId: "workspace-a", sessionId: "session-b" });

    const loading = syncWorkbenchSnapshot(state, {
      workspaceId: "workspace-a",
      primarySessionId: "session-a",
      sessionsKnown: false,
      sessions: [],
    });

    expect(loading.tabs.map((tab) => tab.sessionId)).toEqual(["session-a", "session-b"]);
    expect(loading.secondary?.sessionId).toBe("session-b");
  });

  test("restores saved pairs when an initial session index omits their sessions", () => {
    const owner = { workspaceId: "workspace-a", sessionId: "session-a" };
    const side = { workspaceId: "workspace-a", sessionId: "session-b" };
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: owner.workspaceId, primarySessionId: owner.sessionId,
      sessionsKnown: true, sessions: [owner, side],
    });
    state = setWorkbenchSplit(openWorkbenchTab(state, side), side);
    // These are the only fields persisted across a renderer reload.
    const restored = { ...emptyWorkbench, tabs: state.tabs, sideChats: state.sideChats };
    const initial = syncWorkbenchSnapshot(restored, {
      workspaceId: owner.workspaceId, primarySessionId: owner.sessionId,
      sessionsKnown: true, sessions: [],
    });
    expect(initial.secondary).toEqual(side);
    expect(initial.sideChats).toEqual(state.sideChats);
    const loaded = syncWorkbenchSnapshot(initial, {
      workspaceId: owner.workspaceId, primarySessionId: owner.sessionId,
      sessionsKnown: true, sessions: [owner, side],
    });
    expect(loaded.secondary?.sessionId).toBe(side.sessionId);
    expect(closeWorkbenchTab(loaded, side).secondary).toBeNull();
  });
});


test("restores each main session's own side chat and removes closed references", () => {
  const sessions = ["a", "b", "side-a", "side-b"].map((sessionId) => ({ workspaceId: "workspace", sessionId }));
  const sync = (state: WorkbenchSnapshot, primarySessionId: string | null) => syncWorkbenchSnapshot(state, {
    workspaceId: "workspace", primarySessionId, sessionsKnown: true, sessions,
  });
  let state = sync(emptyWorkbench, "a");
  state = openWorkbenchTab(state, sessions[2]!);
  state = setWorkbenchSplit(state, sessions[2]!);
  state = sync(state, "b");
  expect(state.secondary).toBeNull();
  state = openWorkbenchTab(state, sessions[3]!);
  state = setWorkbenchSplit(state, sessions[3]!);
  state = sync(state, "a");
  expect(state.secondary?.sessionId).toBe("side-a");
  state = sync(state, "b");
  expect(state.secondary?.sessionId).toBe("side-b");
  state = closeWorkbenchTab(state, sessions[2]!);
  state = sync(state, "a");
  expect(state.secondary).toBeNull();
  state = sync(state, null);
  expect(setWorkbenchSplit(state, sessions[3]!)).toBe(state);
});

test("a side chat created after navigating attaches to its original owner", () => {
  const owner = { workspaceId: "workspace", sessionId: "a" };
  const other = { workspaceId: "workspace", sessionId: "b" };
  const chat = { workspaceId: "workspace", sessionId: "side-a" };
  let state = syncWorkbenchSnapshot(emptyWorkbench, {
    workspaceId: "workspace", primarySessionId: "a", sessionsKnown: true, sessions: [owner, other, chat],
  });
  state = syncWorkbenchSnapshot(state, {
    workspaceId: "workspace", primarySessionId: "b", sessionsKnown: true, sessions: [owner, other, chat],
  });
  state = openWorkbenchTab(state, chat);
  state = setWorkbenchSideChat(state, owner, chat);
  expect(state.primary?.sessionId).toBe("b");
  expect(state.secondary).toBeNull();
  state = syncWorkbenchSnapshot(state, {
    workspaceId: "workspace", primarySessionId: "a", sessionsKnown: true, sessions: [owner, other, chat],
  });
  expect(state.secondary?.sessionId).toBe("side-a");
});
