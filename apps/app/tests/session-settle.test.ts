import { beforeEach, describe, expect, test } from "bun:test";

import { useSessionManagementStore } from "../src/react-app/domains/session/sidebar/session-management-store";
import {
  filterSettledSessions,
  isSessionSettled,
  sessionActivityAt,
  settleWorkspaceIds,
  type SessionSettleInput,
} from "../src/react-app/domains/session/sidebar/session-settle";
import { isSettleSessionShortcut } from "../src/react-app/shell/settle-session-shortcut";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);

function settled(overrides: Partial<SessionSettleInput>) {
  return isSessionSettled({
    activityAt: NOW - 60_000,
    entry: undefined,
    status: "idle",
    pinned: false,
    unread: false,
    autoSettleDays: 3,
    now: NOW,
    ...overrides,
  });
}

describe("settled sessions", () => {
  test("a manual settle holds until the session has newer activity", () => {
    const entry = { settledThrough: NOW - 60_000 };
    expect(settled({ entry })).toBe(true);
    expect(settled({ entry, activityAt: NOW + 1_000 })).toBe(false);
  });

  test("a remote clock ahead of ours does not undo a settle", () => {
    // The workspace server stamped the last activity 30 s in our future.
    const activityAt = NOW + 30_000;
    expect(settled({ activityAt, entry: { settledThrough: activityAt } })).toBe(true);
  });

  test("idle sessions settle on their own after the chosen number of days", () => {
    expect(settled({ activityAt: NOW - 3 * DAY })).toBe(true);
    expect(settled({ activityAt: NOW - 3 * DAY + 60_000 })).toBe(false);
    expect(settled({ activityAt: NOW - 30 * DAY, autoSettleDays: 0 })).toBe(false);
    expect(settled({ activityAt: NOW - DAY, autoSettleDays: 1 })).toBe(true);
  });

  test("pinned, unread, working and waiting sessions stay in view", () => {
    const old = NOW - 10 * DAY;
    expect(settled({ activityAt: old, pinned: true })).toBe(false);
    expect(settled({ activityAt: old, unread: true })).toBe(false);
    expect(settled({ activityAt: old, status: "running" })).toBe(false);
    expect(settled({ activityAt: old, status: "waiting" })).toBe(false);
    expect(settled({ activityAt: old, status: "running", entry: { settledThrough: old } })).toBe(false);
  });

  test("un-settling restarts the auto-settle clock", () => {
    const activityAt = NOW - 10 * DAY;
    expect(settled({ activityAt, entry: { unsettledAt: NOW - DAY } })).toBe(false);
    expect(settled({ activityAt, entry: { unsettledAt: NOW - 3 * DAY } })).toBe(true);
  });

  test("session times in seconds or milliseconds give the same activity time", () => {
    expect(sessionActivityAt({ id: "a", time: { updated: NOW / 1000 } })).toBe(NOW);
    expect(sessionActivityAt({ id: "a", time: { updated: NOW } })).toBe(NOW);
    expect(sessionActivityAt({ id: "a", time: { updated: null, created: NOW } })).toBe(NOW);
  });

  test("lists settled sessions most recently active first", () => {
    const sessions = [
      { id: "old", time: { updated: NOW - 9 * DAY } },
      { id: "active", time: { updated: NOW - 60_000 } },
      { id: "recent", time: { updated: NOW - 4 * DAY } },
      { id: "manual", time: { updated: NOW - 2 * DAY } },
    ];
    const result = filterSettledSessions(sessions, {
      settledById: { manual: { settledThrough: NOW - 2 * DAY } },
      statusById: {},
      pinnedIds: new Set(),
      unreadIds: new Set(),
      autoSettleDays: 3,
      now: NOW,
    });
    expect(result.map((session) => session.id)).toEqual(["manual", "recent", "old"]);
  });
});

describe("OpenCode v2 only", () => {
  test("only workspaces whose chat runs on the v2 engine can settle", () => {
    const urls: Record<string, string | null> = {
      v2: "http://127.0.0.1:8787/workspace/v2/opencode2",
      v1: "http://127.0.0.1:8787/workspace/v1/opencode",
      unprobed: null,
    };
    const ids = settleWorkspaceIds(
      [{ id: "v2" }, { id: "v1" }, { id: "unprobed" }],
      (workspace) => urls[workspace.id],
    );
    expect([...ids]).toEqual(["v2"]);
  });
});

describe("settle actions", () => {
  beforeEach(() => {
    useSessionManagementStore.setState({
      pinnedIds: ["a", "b", "c"],
      unreadIds: ["b"],
      settledById: {},
      autoSettleDays: 3,
    });
  });

  test("settling unpins and marks read, and Undo puts both back", () => {
    const store = useSessionManagementStore.getState();
    const snapshot = store.settle("b", NOW);
    let state = useSessionManagementStore.getState();
    expect(state.settledById.b).toEqual({ settledThrough: NOW });
    expect(state.pinnedIds).toEqual(["a", "c"]);
    expect(state.unreadIds).toEqual([]);

    state.restoreSettle("b", snapshot);
    state = useSessionManagementStore.getState();
    expect(state.settledById.b).toBeUndefined();
    expect(state.pinnedIds).toEqual(["a", "b", "c"]);
    expect(state.unreadIds).toEqual(["b"]);
  });

  test("pinning a settled session brings it back", () => {
    const store = useSessionManagementStore.getState();
    store.settle("d", NOW);
    useSessionManagementStore.getState().togglePin("d");
    expect(useSessionManagementStore.getState().settledById.d).toBeUndefined();
  });

  test("work starting brings a settled session back even when its activity time does not move", () => {
    // OpenCode v2 keeps the session's time when a message is sent, so activity seen here has to count.
    const activityAt = NOW - 10 * DAY;
    const isSettled = (id: string) => settled({
      activityAt,
      entry: useSessionManagementStore.getState().settledById[id],
      now: Date.now(),
    });
    useSessionManagementStore.getState().settle("manual", activityAt);
    expect(isSettled("manual")).toBe(true);
    expect(isSettled("auto")).toBe(true);

    useSessionManagementStore.getState().noteActivity("manual");
    useSessionManagementStore.getState().noteActivity("auto");
    expect(isSettled("manual")).toBe(false);
    expect(isSettled("auto")).toBe(false);
  });

  test("only the offered auto-settle choices are kept", () => {
    const store = useSessionManagementStore.getState();
    store.setAutoSettleDays(7);
    expect(useSessionManagementStore.getState().autoSettleDays).toBe(7);
    store.setAutoSettleDays(0);
    expect(useSessionManagementStore.getState().autoSettleDays).toBe(0);
    store.setAutoSettleDays(5);
    expect(useSessionManagementStore.getState().autoSettleDays).toBe(3);
  });
});

describe("settle shortcut", () => {
  const key = (overrides: Partial<KeyboardEvent>) => ({
    key: "E", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, ...overrides,
  });

  test("uses Cmd+Shift+E on macOS and Ctrl+Shift+E elsewhere", () => {
    expect(isSettleSessionShortcut(key({ metaKey: true }), "macos")).toBe(true);
    expect(isSettleSessionShortcut(key({ ctrlKey: true }), "macos")).toBe(false);
    expect(isSettleSessionShortcut(key({ ctrlKey: true }), "windows")).toBe(true);
    expect(isSettleSessionShortcut(key({ ctrlKey: true }), "linux")).toBe(true);
    expect(isSettleSessionShortcut(key({ metaKey: true, shiftKey: false }), "macos")).toBe(false);
  });

  test("leaves AltGr typing alone", () => {
    expect(isSettleSessionShortcut({ ...key({ ctrlKey: true }), getModifierState: (name) => name === "AltGraph" }, "windows")).toBe(false);
  });
});
