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
