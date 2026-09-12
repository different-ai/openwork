import { describe, expect, test } from "bun:test";

import type { SidebarSessionItem } from "../src/app/types";
import {
  flattenSessionRows,
  getSessionDescendantIds,
} from "../src/react-app/domains/session/sidebar/utils";

const sessions: SidebarSessionItem[] = [
  { id: "session-a", title: "Pinned root" },
  { id: "session-a-child", title: "Sub-agent child", parentID: "session-a" },
  { id: "session-b", title: "Regular root" },
];

describe("sidebar session rows", () => {
  test("finds nested sub-agent sessions without including unrelated roots", () => {
    const nested: SidebarSessionItem[] = [
      ...sessions,
      { id: "session-a-grandchild", title: "Nested child", parentID: "session-a-child" },
      { id: "session-cycle-a", title: "Cycle A", parentID: "session-cycle-b" },
      { id: "session-cycle-b", title: "Cycle B", parentID: "session-cycle-a" },
    ];

    expect(getSessionDescendantIds(nested, "session-a")).toEqual([
      "session-a-child",
      "session-a-grandchild",
    ]);
  });

  test("never emits sub-agent (child) sessions", () => {
    const rows = flattenSessionRows(sessions, Number.MAX_SAFE_INTEGER);

    expect(rows.map((row) => row.session.id)).toEqual(["session-a", "session-b"]);
  });

  test("selects a pinned root without its descendants", () => {
    const rows = flattenSessionRows(
      sessions,
      1,
      new Set(["session-a"]),
      [],
      { include: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-a"]);
  });

  test("removes pinned roots before applying the workspace preview limit", () => {
    const rows = flattenSessionRows(
      sessions,
      1,
      new Set(),
      [],
      { exclude: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-b"]);
  });

  test("keeps large-inventory preview counts, manual order, and original session identities", () => {
    const inventory: SidebarSessionItem[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `session-${index}`, title: `Session ${index}`,
    }));
    const pinned = inventory[9_999]!;
    const ordered = inventory[9_998]!;
    const pinnedIds = new Set([pinned.id]);
    const input = [
      { id: "archived", title: "Archived", time: { archived: 1 } },
      { id: "child", title: "Child", parentID: pinned.id },
      ...inventory,
    ];
    const rows = flattenSessionRows(input, 6, new Set(), [ordered.id], { exclude: pinnedIds });
    const pinnedRows = flattenSessionRows(input, 1, pinnedIds, [], { include: pinnedIds });

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.session.id)).toEqual([ordered.id, ...inventory.slice(0, 5).map((session) => session.id)]);
    expect(rows[0]!.session).toBe(ordered);
    expect(rows[1]!.session).toBe(inventory[0]);
    expect(pinnedRows).toHaveLength(1);
    expect(pinnedRows[0]!.session).toBe(pinned);
    const expanded = flattenSessionRows(input, Number.MAX_SAFE_INTEGER, new Set(), [ordered.id], { exclude: pinnedIds });
    expect(expanded).toHaveLength(inventory.length - 1);
    expect(expanded.slice(0, rows.length)).toEqual(rows);
    expect(expanded.at(-1)!.session).toBe(inventory[9_997]);
  });

  test("hides a child even when its parent is archived or outside the list", () => {
    const orphaned: SidebarSessionItem[] = [
      { id: "session-c", title: "Orphan child", parentID: "missing-parent" },
      { id: "session-d", title: "Archived parent", time: { archived: 1 } },
      { id: "session-d-child", title: "Child of archived", parentID: "session-d" },
    ];
    const rows = flattenSessionRows(orphaned, Number.MAX_SAFE_INTEGER);

    expect(rows).toEqual([]);
  });
});
