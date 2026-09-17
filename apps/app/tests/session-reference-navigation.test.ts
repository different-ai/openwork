import { describe, expect, test } from "bun:test";
import type { SessionReference } from "../src/components/chat/session-reference";
import { openSessionReference } from "../src/react-app/domains/session/chat/session-reference-navigation";
import {
  focusWorkbenchPane,
  openWorkbenchTab,
  setWorkbenchSplit,
  syncWorkbenchSnapshot,
  type WorkbenchSnapshot,
  type WorkbenchSessionTab,
} from "../src/react-app/domains/session/chat/workbench-store";

const primary: SessionReference = { workspaceId: "workspace-a", sessionId: "ses_primary", title: "Primary" };
const secondary: SessionReference = { workspaceId: "workspace-b", sessionId: "ses_secondary", title: "Secondary" };
const target: SessionReference = { workspaceId: "workspace-c", sessionId: "ses_target", title: "Target" };
const empty: WorkbenchSnapshot = { revision: 0, primary: null, secondary: null, tabs: [], focusedPane: "primary", sideChats: {} };

function harness(split = false) {
  let state = syncWorkbenchSnapshot(empty, {
    workspaceId: primary.workspaceId,
    primarySessionId: primary.sessionId,
    sessionsKnown: true,
    sessions: [primary],
  });
  if (split) state = setWorkbenchSplit(openWorkbenchTab(state, secondary), secondary);
  const routes: Array<{ workspaceId: string; sessionId: string }> = [];
  const actions = {
    openTab: (tab: WorkbenchSessionTab) => { state = openWorkbenchTab(state, tab); },
    focusPane: (pane: "primary" | "secondary") => { state = focusWorkbenchPane(state, pane); },
    setSplit: (reference: WorkbenchSessionTab) => { state = setWorkbenchSplit(state, reference); },
    onOpenSession: (workspaceId: string, sessionId: string) => {
      routes.push({ workspaceId, sessionId });
      state = syncWorkbenchSnapshot(state, {
        workspaceId, primarySessionId: sessionId, sessionsKnown: true,
        sessions: state.tabs.filter((tab) => tab.workspaceId === workspaceId),
      });
    },
  };
  return {
    get state() { return state; },
    routes,
    actions,
    open: (reference: SessionReference) => openSessionReference(reference, state, actions),
  };
}

describe("session reference navigation", () => {
  test("focuses an existing primary without replacing its split or adding a tab", () => {
    const bench = harness(true);
    const tabs = bench.state.tabs;
    const sideChats = bench.state.sideChats;
    bench.open(primary);
    expect(bench.state.focusedPane).toBe("primary");
    expect(bench.state.tabs).toBe(tabs);
    expect(bench.state.sideChats).toBe(sideChats);
    expect(bench.state.secondary).toMatchObject(secondary);
    expect(bench.routes).toEqual([]);
  });

  test("focuses an existing secondary without navigating the primary", () => {
    const bench = harness(true);
    bench.actions.focusPane("primary");
    const tabs = bench.state.tabs;
    bench.open(secondary);
    expect(bench.state.focusedPane).toBe("secondary");
    expect(bench.state.primary).toMatchObject(primary);
    expect(bench.state.tabs).toBe(tabs);
    expect(bench.routes).toEqual([]);
  });

  test("does not confuse identical session IDs in different workspaces", () => {
    const bench = harness(true);
    const sameId = { ...primary, workspaceId: "workspace-c", title: "Different owner" };
    bench.open(sameId);
    expect(bench.state.primary).toMatchObject(primary);
    expect(bench.state.secondary).toMatchObject(sameId);
    expect(bench.state.focusedPane).toBe("secondary");
    expect(bench.state.tabs.filter((tab) => tab.sessionId === primary.sessionId)).toHaveLength(2);
    expect(bench.routes).toEqual([]);
  });

  test("opens a new target in the focused secondary and retains the primary", () => {
    const bench = harness(true);
    const originalPrimary = bench.state.primary;
    bench.open(target);
    expect(bench.state.primary).toBe(originalPrimary);
    expect(bench.state.secondary).toMatchObject(target);
    expect(bench.state.focusedPane).toBe("secondary");
    expect(bench.state.tabs).toHaveLength(3);
    expect(bench.routes).toEqual([]);
    bench.open(target);
    expect(bench.state.tabs).toHaveLength(3);
  });

  test("reuses a retained tab with fresh metadata, never its persisted title", () => {
    const bench = harness();
    bench.actions.openTab({ ...target, title: "Persisted old title" });
    bench.open(target);
    expect(bench.state.primary).toMatchObject(target);
    expect(bench.state.tabs).toHaveLength(2);
    expect(bench.routes).toEqual([{ workspaceId: target.workspaceId, sessionId: target.sessionId }]);
    bench.open(target);
    expect(bench.routes).toHaveLength(1);
    expect(bench.state.tabs).toHaveLength(2);
  });

  test("uses primary route navigation when the primary is focused and retains saved split ownership", () => {
    const bench = harness(true);
    bench.actions.focusPane("primary");
    const sideChats = bench.state.sideChats;
    bench.open(target);
    expect(bench.state.primary).toMatchObject(target);
    expect(bench.state.focusedPane).toBe("primary");
    expect(bench.state.sideChats).toBe(sideChats);
    expect(bench.routes).toEqual([{ workspaceId: target.workspaceId, sessionId: target.sessionId }]);
    bench.open(primary);
    expect(bench.state.secondary).toMatchObject(secondary);
  });

  test("opens archived metadata in the primary read-only route, with no restore action", () => {
    const bench = harness(true);
    const archived = { ...target, archived: true };
    bench.open(archived);
    expect(bench.state.primary).toMatchObject(target);
    expect(bench.state.focusedPane).toBe("primary");
    expect(bench.routes).toEqual([{ workspaceId: target.workspaceId, sessionId: target.sessionId }]);
    expect(bench.state.tabs.find((tab) => tab.sessionId === target.sessionId)).toMatchObject({ archived: true });
  });
});
