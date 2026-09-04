import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_TAB_PRESENCE_BOUNDS,
  BACKGROUND_TAB_VIEWPORT,
  SHARED_OWNER_KEY,
  activeBrowserTabIdForSession,
  backgroundTabEmulationCommands,
  browserTabsForSession,
  createBrowserTabRegistry,
  foregroundTabEmulationCommands,
} from "../index.mjs";

describe("tab ownership", () => {
  test("a tab opened by a background conversation never takes the screen from the visible one", () => {
    const registry = createBrowserTabRegistry();
    registry.setVisibleSession("A");
    registry.add({ tabId: "a1", ownerSessionId: "A" });
    registry.add({ tabId: "b1", ownerSessionId: "B" });
    registry.select("b1");

    expect(registry.surfacingFor("a1")).toBe("foreground");
    expect(registry.surfacingFor("b1")).toBe("background");
    expect(registry.onScreenTabId()).toBe("a1");
    expect(registry.activeTabIdFor("B")).toBe("b1");
  });

  test("switching conversations brings that conversation's active tab on screen", () => {
    const registry = createBrowserTabRegistry();
    registry.setVisibleSession("A");
    registry.add({ tabId: "a1", ownerSessionId: "A" });
    registry.add({ tabId: "b1", ownerSessionId: "B" });
    registry.add({ tabId: "b2", ownerSessionId: "B" });
    registry.select("b2");

    registry.setVisibleSession("B");

    expect(registry.onScreenTabId()).toBe("b2");
    expect(registry.surfacingFor("a1")).toBe("background");
    expect(registry.surfacingFor("b2")).toBe("foreground");
  });

  test("shared tabs without an owner stay visible to every conversation", () => {
    const registry = createBrowserTabRegistry();
    registry.add({ tabId: "s1" });
    registry.setVisibleSession("A");
    expect(registry.surfacingFor("s1")).toBe("foreground");
    expect(registry.onScreenTabId()).toBe("s1");

    registry.add({ tabId: "a1", ownerSessionId: "A" });
    registry.select("a1");
    expect(registry.onScreenTabId()).toBe("a1");
    expect(registry.activeTabIdByOwner()).toEqual({ [SHARED_OWNER_KEY]: "s1", A: "a1" });
  });

  test("picking a shared tab from a conversation's tab strip puts it on screen, and switching conversations forgets that pick", () => {
    const registry = createBrowserTabRegistry();
    registry.setVisibleSession("A");
    registry.add({ tabId: "a1", ownerSessionId: "A" });
    registry.add({ tabId: "s1" });
    expect(registry.onScreenTabId()).toBe("a1");

    registry.select("s1");
    expect(registry.onScreenTabId()).toBe("s1");

    registry.add({ tabId: "b1", ownerSessionId: "B" });
    registry.select("b1");
    expect(registry.onScreenTabId()).toBe("s1");

    registry.setVisibleSession("B");
    expect(registry.onScreenTabId()).toBe("b1");
  });

  test("closing the active tab hands the owner its right neighbour, then its left, then nothing", () => {
    const registry = createBrowserTabRegistry();
    registry.add({ tabId: "a1", ownerSessionId: "A" });
    registry.add({ tabId: "b1", ownerSessionId: "B" });
    registry.add({ tabId: "a2", ownerSessionId: "A" });
    registry.add({ tabId: "a3", ownerSessionId: "A" });
    registry.select("a2");

    expect(registry.remove("a2")).toEqual({
      tab: { tabId: "a2", ownerSessionId: "A" },
      wasActive: true,
      nextActiveTabId: "a3",
      ownerHasTabs: true,
    });
    expect(registry.remove("a3")).toMatchObject({ wasActive: true, nextActiveTabId: "a1" });
    expect(registry.remove("a1")).toMatchObject({ wasActive: true, nextActiveTabId: null, ownerHasTabs: false });
    expect(registry.activeTabIdFor("B")).toBe("b1");
    expect(registry.list().map((tab) => tab.tabId)).toEqual(["b1"]);
  });

  test("closing a background tab leaves the visible conversation untouched", () => {
    const registry = createBrowserTabRegistry();
    registry.setVisibleSession("A");
    registry.add({ tabId: "a1", ownerSessionId: "A" });
    registry.add({ tabId: "b1", ownerSessionId: "B" });

    const removed = registry.remove("b1");

    expect(removed).toMatchObject({ wasActive: true, ownerHasTabs: false });
    expect(registry.onScreenTabId()).toBe("a1");
  });

  test("reordering validates the full tab set", () => {
    const registry = createBrowserTabRegistry();
    registry.add({ tabId: "a1", ownerSessionId: "A" });
    registry.add({ tabId: "a2", ownerSessionId: "A" });

    expect(registry.reorder(["a2", "a1"]).map((tab) => tab.tabId)).toEqual(["a2", "a1"]);
    expect(() => registry.reorder(["a2"])).toThrow("every open tab");
    expect(() => registry.reorder(["a2", "a2"])).toThrow("duplicate");
    expect(() => registry.reorder(["a2", "zz"])).toThrow("unknown tab");
  });

  test("blank or missing owners normalize to shared", () => {
    const registry = createBrowserTabRegistry();
    registry.add({ tabId: "s1", ownerSessionId: "  " });
    expect(registry.ownerOf("s1")).toBe(null);
    expect(registry.setVisibleSession("")).toBe(null);
  });
});

describe("renderer helpers", () => {
  const tabs = [
    { id: "a1", ownerSessionId: "A" },
    { id: "s1", ownerSessionId: null },
    { id: "b1", ownerSessionId: "B" },
  ];

  test("a conversation sees its own tabs and shared tabs only", () => {
    expect(browserTabsForSession(tabs, "A").map((tab) => tab.id)).toEqual(["a1", "s1"]);
    expect(browserTabsForSession(tabs, "C").map((tab) => tab.id)).toEqual(["s1"]);
  });

  test("the active tab comes from the owner, then shared, then on-screen, then first visible", () => {
    const visible = browserTabsForSession(tabs, "A");
    expect(activeBrowserTabIdForSession({ activeTabIdByOwner: { A: "a1" }, activeTabId: "b1" }, "A", visible)).toBe("a1");
    expect(activeBrowserTabIdForSession({ activeTabIdByOwner: { [SHARED_OWNER_KEY]: "s1" } }, "A", visible)).toBe("s1");
    expect(activeBrowserTabIdForSession({ activeTabId: "b1" }, "A", visible)).toBe("a1");
    expect(activeBrowserTabIdForSession({}, "C", [])).toBe(null);
  });
});

describe("background rendering recipe", () => {
  test("a background tab gets a real viewport and focus; the foreground undoes both in reverse", () => {
    expect(backgroundTabEmulationCommands()).toEqual([
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: { ...BACKGROUND_TAB_VIEWPORT, deviceScaleFactor: 0, mobile: false },
      },
      { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } },
    ]);
    expect(foregroundTabEmulationCommands().map((command) => command.method)).toEqual([
      "Emulation.setFocusEmulationEnabled",
      "Emulation.clearDeviceMetricsOverride",
    ]);
  });

  test("the on-window presence is a single corner pixel", () => {
    expect(BACKGROUND_TAB_PRESENCE_BOUNDS).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
