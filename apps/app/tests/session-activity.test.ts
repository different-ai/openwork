import { beforeEach, describe, expect, test } from "bun:test";

import { useSessionManagementStore } from "../src/react-app/domains/session/sidebar/session-management-store";
import { sessionActivityAt, sessionLastActivityAt } from "../src/react-app/domains/session/sidebar/session-activity";
import { isArchiveSessionShortcut } from "../src/react-app/shell/archive-session-shortcut";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12);

describe("session activity", () => {
  test("session times in seconds or milliseconds give the same activity time", () => {
    expect(sessionActivityAt({ id: "a", time: { updated: NOW / 1000 } })).toBe(NOW);
    expect(sessionActivityAt({ id: "a", time: { updated: NOW } })).toBe(NOW);
    expect(sessionActivityAt({ id: "a", time: { updated: null, created: NOW } })).toBe(NOW);
  });

  test("work seen on this device counts when the engine kept the session's old time", () => {
    const session = { id: "a", time: { updated: NOW - 10 * DAY } };
    expect(sessionLastActivityAt(session, undefined)).toBe(NOW - 10 * DAY);
    expect(sessionLastActivityAt(session, NOW - 60_000)).toBe(NOW - 60_000);
    expect(sessionLastActivityAt({ id: "b", time: { updated: NOW } }, NOW - DAY)).toBe(NOW);
  });
});

describe("activity and Feed placement records", () => {
  beforeEach(() => {
    // Another file in the same run may have torn down its DOM globals; the persisted store writes here.
    if (typeof globalThis.localStorage === "undefined") {
      const values = new Map<string, string>();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => { values.set(key, value); },
          removeItem: (key: string) => { values.delete(key); },
          clear: () => values.clear(),
          key: (index: number) => [...values.keys()][index] ?? null,
          get length() { return values.size; },
        },
      });
    }
    useSessionManagementStore.setState({ workedAtById: {}, feedPlacementById: {} });
  });

  test("noting activity records when the session was last worked on", () => {
    const before = Date.now();
    useSessionManagementStore.getState().noteActivity("a");
    expect(useSessionManagementStore.getState().workedAtById.a).toBeGreaterThanOrEqual(before);
  });

  test("placing a session in the Feed keeps its key and when it was dragged", () => {
    const before = Date.now();
    useSessionManagementStore.getState().placeInFeed("a", NOW - DAY);
    const placement = useSessionManagementStore.getState().feedPlacementById.a;
    expect(placement?.key).toBe(NOW - DAY);
    expect(placement?.at).toBeGreaterThanOrEqual(before);
    useSessionManagementStore.getState().placeInFeed("b", Number.NaN);
    expect(useSessionManagementStore.getState().feedPlacementById.b).toBeUndefined();
  });
});

describe("archive shortcut", () => {
  const key = (overrides: Partial<KeyboardEvent>) => ({
    key: "E", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, ...overrides,
  });

  test("uses Cmd+Shift+E on macOS and Ctrl+Shift+E elsewhere", () => {
    expect(isArchiveSessionShortcut(key({ metaKey: true }), "macos")).toBe(true);
    expect(isArchiveSessionShortcut(key({ ctrlKey: true }), "macos")).toBe(false);
    expect(isArchiveSessionShortcut(key({ ctrlKey: true }), "windows")).toBe(true);
    expect(isArchiveSessionShortcut(key({ ctrlKey: true }), "linux")).toBe(true);
    expect(isArchiveSessionShortcut(key({ metaKey: true, shiftKey: false }), "macos")).toBe(false);
  });

  test("leaves AltGr typing alone", () => {
    expect(isArchiveSessionShortcut({ ...key({ ctrlKey: true }), getModifierState: (name) => name === "AltGraph" }, "windows")).toBe(false);
  });
});
