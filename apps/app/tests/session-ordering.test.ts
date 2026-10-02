import { describe, expect, test } from "bun:test";
import type { SidebarSessionItem } from "../src/app/types";
import { flattenSessionRows, orderRootSessions } from "../src/react-app/domains/session/sidebar/utils";
import { getSessionOrder, moveSessionInOrder } from "../src/react-app/domains/session/sidebar/session-order";

const session = (id: string, created: number, updated = created): SidebarSessionItem => ({ id, title: id, time: { created, updated } });
const ids = (sessions: SidebarSessionItem[]) => sessions.map(session => session.id);

describe("manual task ordering", () => {
  test("initial order uses creation, never activity or the incoming page order", () => {
    const roots = [session("old", 1, 100), session("new", 3, 3), session("middle", 2, 200)];
    expect(ids(orderRootSessions(roots, new Set(), []))).toEqual(["new", "middle", "old"]);
    expect(ids(orderRootSessions([...roots].reverse(), new Set(), []))).toEqual(["new", "middle", "old"]);
    expect(ids(orderRootSessions(roots.map(root => ({ ...root, time: { ...root.time, updated: 1000 } })), new Set(), [])))
      .toEqual(["new", "middle", "old"]);
  });

  test("new tasks precede saved order before the preview limit and pins keep their own section", () => {
    const saved = Array.from({ length: 8 }, (_, index) => session(`task-${index}`, index + 1));
    const roots = [...saved, session("new", 10), session("pinned", 9)];
    const order = ids(saved);
    expect(flattenSessionRows(roots, 6, new Set(), order, { exclude: new Set(["pinned"]) }).map(row => row.session.id))
      .toEqual(["new", ...order.slice(0, 5)]);
    expect(ids(orderRootSessions(roots, new Set(["pinned"]), order)))
      .toEqual(["pinned", "new", ...order]);
    expect(order).toEqual(ids(saved));
  });

  test("a saved order survives updates, duplicate IDs, and temporarily unloaded or archived tasks", () => {
    const roots = [session("a", 1), session("b", 2, 900), session("c", 3)];
    const saved = ["c", "missing", "a", "b", "a"];
    expect(getSessionOrder(roots, saved)).toEqual(["c", "missing", "a", "b"]);
    expect(ids(orderRootSessions(roots, new Set(), saved))).toEqual(["c", "a", "b"]);
    const partial = roots.filter(root => root.id !== "a");
    const moved = moveSessionInOrder(getSessionOrder(partial, saved), "b", "c", false);
    expect(ids(orderRootSessions(roots, new Set(), moved))).toEqual(["b", "c", "a"]);
  });

  test("equal and missing creation times have deterministic fallback order", () => {
    const roots = [session("b", 1), session("a", 1), { id: "legacy", title: "Legacy" }];
    const first = ids(orderRootSessions(roots, new Set(), []));
    expect(ids(orderRootSessions([...roots].reverse(), new Set(), []))).toEqual(first);
    expect(first).toEqual(["a", "b", "legacy"]);
  });

  test("moving a visible row preserves the order of hidden, pinned, and other-group tasks", () => {
    const all = ["pinned", "a", "other-group", "b", "c", "hidden-1", "hidden-2"];
    expect(moveSessionInOrder(all, "c", "a", false)).toEqual(["pinned", "c", "a", "other-group", "b", "hidden-1", "hidden-2"]);
    expect(moveSessionInOrder(all, "a", "c", true)).toEqual(["pinned", "other-group", "b", "c", "a", "hidden-1", "hidden-2"]);
    expect(moveSessionInOrder(all, "missing", "a", false)).toBe(all);
    expect(moveSessionInOrder(all, "a", "missing", false)).toBe(all);
    expect(moveSessionInOrder(all, "a", "a", false)).toBe(all);
    expect(all).toEqual(["pinned", "a", "other-group", "b", "c", "hidden-1", "hidden-2"]);
  });
});
