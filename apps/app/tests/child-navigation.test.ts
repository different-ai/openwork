import { expect, test } from "bun:test";
import { childOrigin, consumeChildReturn, prepareChildReturn, registerChildDraftPersistence, rememberChildOrigin } from "../src/lib/child-navigation";

test("returning flushes the mounted child draft and restores only its originating pane", () => {
  const origin = { parentId: "parent", pane: "secondary" as const, anchor: "child", scrollTop: 720, brief: "Inspect the fixture", title: "Fixture chat" };
  rememberChildOrigin("account-a:server-a", "child", origin);
  let flushed = false;
  const unregister = registerChildDraftPersistence("account-a:server-a", "child", () => { flushed = true; });
  try {
    expect(prepareChildReturn("account-b:server-b", "child")).toBeUndefined();
    expect(flushed).toBe(false);
    expect(prepareChildReturn("account-a:server-a", "child")).toEqual(origin);
    expect(flushed).toBe(true);
    expect(consumeChildReturn("account-b:server-b", "parent")).toBeUndefined();
    expect(consumeChildReturn("account-a:server-a", "parent")).toEqual(origin);
    expect(consumeChildReturn("account-a:server-a", "parent")).toBeUndefined();
  } finally { unregister(); }
});

test("unmounting an obsolete pane cannot remove the current child's draft flush", () => {
  const scope = "replacement-pane";
  rememberChildOrigin(scope, "child", { parentId: "parent", pane: "primary", anchor: "child", scrollTop: 0, brief: "Read the fixture" });
  let oldFlush = 0;
  let currentFlush = 0;
  const removeOld = registerChildDraftPersistence(scope, "child", () => { oldFlush++; });
  const removeCurrent = registerChildDraftPersistence(scope, "child", () => { currentFlush++; });
  removeOld();
  prepareChildReturn(scope, "child");
  expect(oldFlush).toBe(0);
  expect(currentFlush).toBe(1);
  removeCurrent();
  prepareChildReturn(scope, "child");
  expect(currentFlush).toBe(1);
  expect(childOrigin(scope, "child")?.parentId).toBe("parent");
});

test("another pane cannot consume the originating pane's return", () => {
  rememberChildOrigin("two-panes", "child", { parentId: "parent", pane: "secondary", anchor: "child", scrollTop: 420, brief: "Review" });
  prepareChildReturn("two-panes", "child");
  expect(consumeChildReturn("two-panes", "parent", "primary")).toBeUndefined();
  expect(consumeChildReturn("two-panes", "parent", "secondary")?.scrollTop).toBe(420);
});
