import { describe, expect, test } from "bun:test";

import type { SidebarSessionItem, WorkspaceSessionGroup } from "../src/app/types";
import {
  buildGlobalPinnedSessions,
  flattenSessionRows,
  getSessionDescendantIds,
  groupSessionRows,
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

  test("combines task references and metadata transitively without duplicates or cycles", () => {
    expect(getSessionDescendantIds([
      ...sessions,
      { id: "nested", parentID: "missing-from-list", title: "Nested" },
    ], "session-a", {
      "session-a": ["missing-from-list", "session-a-child"],
      "missing-from-list": ["session-a", "nested"],
      "nested": ["task-only"],
      "unrelated": ["not-related"],
    })).toEqual(["session-a-child", "missing-from-list", "nested", "task-only"]);
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
      id: `session-${String(index).padStart(5, "0")}`, title: `Session ${index}`,
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

  test("global pins reuse root objects in pin order and exclude archived, child, and missing entries", () => {
    const inventory: SidebarSessionItem[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `root-${index}`, title: `Root ${index}`,
    }));
    const group: WorkspaceSessionGroup = {
      workspace: { id: "workspace", name: "Workspace", path: "/work/workspace", preset: "starter", workspaceType: "local" },
      status: "ready",
      sessions: [
        ...inventory,
        { ...inventory[0], title: "Duplicate root" },
        { id: "archived", title: "Archived", time: { archived: 1 } },
        { id: "child", title: "Child", parentID: inventory[0].id },
      ],
    };
    const pins = ["root-999", "archived", "child", "missing", "root-0"];
    const entries = buildGlobalPinnedSessions([group], pins);
    expect(entries.map((entry) => entry.session.id)).toEqual(["root-999", "root-0"]);
    expect(entries[0].session).toBe(inventory[999]);
    expect(entries[1].session).toBe(inventory[0]);
    expect(entries.every((entry) => entry.group === group)).toBe(true);
    for (const entry of entries) {
      expect(entry.session).toBe(flattenSessionRows(group.sessions, 1, new Set(pins), [], {
        include: new Set([entry.session.id]),
      })[0].session);
    }
    const other: WorkspaceSessionGroup = {
      ...group,
      workspace: { ...group.workspace, id: "other" },
      sessions: [{ id: "root-0", title: "Last workspace wins" }],
    };
    const shared = buildGlobalPinnedSessions([group, other], ["root-0"]);
    expect(shared[0].group).toBe(other);
    expect(shared[0].session).toBe(other.sessions[0]);
  });

  test("group buckets preserve manual order, row identity, empty groups, and unknown assignments", () => {
    const inventory = Array.from({ length: 9 }, (_, index) => ({ id: `root-${index}`, title: `Root ${index}` }));
    const rows = flattenSessionRows(inventory, Number.MAX_SAFE_INTEGER, new Set(), ["root-7", "root-2"]);
    const groups = [{ id: "group-b" }, { id: "empty-group" }, { id: "group-a" }];
    const assignments = Object.fromEntries(inventory.slice(0, 8).map((session) => [session.id, "group-a"]));
    assignments["root-8"] = "removed-group";
    const grouped = groupSessionRows(rows, groups, assignments);
    expect(grouped.groupIds).toEqual(["group-b", "empty-group", "group-a"]);
    expect(grouped.rootRowsByGroup.get("empty-group")).toBeUndefined();
    const assigned = grouped.rootRowsByGroup.get("group-a");
    expect(assigned).toHaveLength(8);
    expect(assigned?.slice(0, 6).map((row) => row.session.id)).toEqual(["root-7", "root-2", "root-0", "root-1", "root-3", "root-4"]);
    expect(assigned?.[0]).toBe(rows[0]);
    expect(grouped.ungroupedRows).toEqual([rows[8]]);
    const moved = groupSessionRows(rows, groups, { ...assignments, "root-7": "group-b" });
    expect(moved.rootRowsByGroup.get("group-b")).toEqual([rows[0]]);
    expect(moved.rootRowsByGroup.get("group-a")).toHaveLength(7);
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
