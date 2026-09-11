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

  test("archive drops persisted pairs without promoting a side chat or disturbing unrelated pairs", () => {
    const owner = { workspaceId: "workspace-a", sessionId: "owner" };
    const side = { workspaceId: "workspace-b", sessionId: "side" };
    const other = { workspaceId: "workspace-a", sessionId: "other" };
    const otherSide = { workspaceId: "workspace-b", sessionId: "other-side" };
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: owner.workspaceId, primarySessionId: owner.sessionId,
      sessionsKnown: true, sessions: [owner, other],
    });
    for (const tab of [side, other, otherSide]) state = openWorkbenchTab(state, tab);
    state = setWorkbenchSideChat(state, other, otherSide);
    state = setWorkbenchSideChat(state, owner, side);
    const archivedSide = closeWorkbenchTab(state, side, false);
    expect(archivedSide.primary?.sessionId).toBe(owner.sessionId);
    expect(archivedSide.secondary).toBeNull();
    expect(Object.values(archivedSide.sideChats)).toEqual([otherSide]);
    const archivedOwner = closeWorkbenchTab(state, owner, false);
    expect(archivedOwner.primary).toBeNull();
    expect(archivedOwner.secondary).toBeNull();
    expect(archivedOwner.focusedPane).toBe("primary");
    expect(Object.values(archivedOwner.sideChats)).toEqual([otherSide]);
    const restored = syncWorkbenchSnapshot(archivedOwner, {
      workspaceId: owner.workspaceId, primarySessionId: owner.sessionId,
      sessionsKnown: true, sessions: [owner, other],
    });
    expect(restored.secondary).toBeNull();
    expect(closeWorkbenchTab(state, otherSide, false).secondary).toEqual(side);
  });

  for (const archivedId of ["owner", "side"]) {
    test(`explicit archive metadata removes a retained ${archivedId} and its pair without pruning unknown history`, () => {
      const primary = { workspaceId: "workspace-a", sessionId: "primary" };
      const owner = { workspaceId: "workspace-a", sessionId: "owner" };
      const side = { workspaceId: "workspace-a", sessionId: "side" };
      const unknown = { workspaceId: "workspace-a", sessionId: "other-engine" };
      const otherWorkspace = { workspaceId: "workspace-b", sessionId: archivedId };
      let state = syncWorkbenchSnapshot(emptyWorkbench, {
        workspaceId: primary.workspaceId, primarySessionId: primary.sessionId,
        sessionsKnown: true, sessions: [primary],
      });
      for (const tab of [owner, side, unknown, otherWorkspace]) state = openWorkbenchTab(state, tab);
      state = setWorkbenchSideChat(state, owner, side);
      state = setWorkbenchSideChat(state, primary, otherWorkspace);
      state = syncWorkbenchSnapshot(state, {
        workspaceId: primary.workspaceId, primarySessionId: primary.sessionId,
        sessionsKnown: true, sessions: [primary], archivedSessionIds: [archivedId],
      });

      expect(state.tabs.some((tab) => tab.workspaceId === "workspace-a" && tab.sessionId === archivedId)).toBe(false);
      expect(state.tabs).toContainEqual(unknown);
      expect(state.tabs).toContainEqual(otherWorkspace);
      expect(Object.values(state.sideChats)).toEqual([otherWorkspace]);
      expect(state.secondary).toEqual(otherWorkspace);
    });
  }

  test("explicitly archiving the visible side chat clears the split and restores primary focus", () => {
    const primary = { workspaceId: "workspace-a", sessionId: "primary" };
    const side = { workspaceId: "workspace-a", sessionId: "side" };
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: primary.workspaceId, primarySessionId: primary.sessionId,
      sessionsKnown: true, sessions: [primary, side],
    });
    state = setWorkbenchSplit(openWorkbenchTab(state, side), side);
    state = syncWorkbenchSnapshot(state, {
      workspaceId: primary.workspaceId, primarySessionId: primary.sessionId,
      sessionsKnown: true, sessions: [primary, side], archivedSessionIds: [side.sessionId],
    });
    expect(state.tabs.map((tab) => tab.sessionId)).toEqual([primary.sessionId]);
    expect(state.sideChats).toEqual({});
    expect(state.secondary).toBeNull();
    expect(state.focusedPane).toBe("primary");
  });

  test("keeps an explicitly archived primary viewable until navigating away", () => {
    const primary = { workspaceId: "workspace-a", sessionId: "primary" };
    const input = {
      workspaceId: primary.workspaceId, primarySessionId: primary.sessionId,
      sessionsKnown: true, sessions: [primary], archivedSessionIds: [primary.sessionId],
    };
    const state = syncWorkbenchSnapshot(emptyWorkbench, input);
    expect(state.primary).toMatchObject(primary);
    expect(state.tabs).toHaveLength(1);
    const navigated = syncWorkbenchSnapshot(state, { ...input, primarySessionId: null });
    expect(navigated.primary).toBeNull();
    expect(navigated.tabs).toEqual([]);
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

  test("retains unpaired history across engine switches, workspace navigation, and reload", () => {
    const first = { workspaceId: "workspace-a", sessionId: "v1-first", title: "First" };
    const second = { workspaceId: "workspace-a", sessionId: "v1-second", title: "Second" };
    const upgraded = { workspaceId: "workspace-a", sessionId: "v2-chat", title: "Upgraded" };
    let state = syncWorkbenchSnapshot(emptyWorkbench, {
      workspaceId: first.workspaceId, primarySessionId: first.sessionId,
      sessionsKnown: true, sessions: [first, second],
    });
    state = openWorkbenchTab(state, second);
    state = syncWorkbenchSnapshot(state, {
      workspaceId: upgraded.workspaceId, primarySessionId: upgraded.sessionId,
      sessionsKnown: true, sessions: [upgraded],
    });
    state = syncWorkbenchSnapshot(state, {
      workspaceId: "workspace-b", primarySessionId: null, sessionsKnown: true, sessions: [],
    });
    const restored = { ...emptyWorkbench, tabs: state.tabs, sideChats: state.sideChats };
    state = syncWorkbenchSnapshot(restored, {
      workspaceId: first.workspaceId, primarySessionId: first.sessionId,
      sessionsKnown: true, sessions: [first, second],
    });
    expect(state.tabs.map(tab => tab.sessionId)).toEqual([first.sessionId, second.sessionId, upgraded.sessionId]);
    expect(state.primary).toMatchObject(first);
    expect(state.secondary).toBeNull();
    const closed = closeWorkbenchTab(state, second);
    expect(closed.tabs.map(tab => tab.sessionId)).toEqual([first.sessionId, upgraded.sessionId]);
    const archived = closeWorkbenchTab(state, upgraded, false);
    expect(archived.tabs.map(tab => tab.sessionId)).toEqual([first.sessionId, second.sessionId]);
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
