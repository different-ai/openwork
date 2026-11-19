import { expect, test } from "bun:test";
import type { WorkspaceSessionGroup } from "../src/app/types.ts";
import {
  buildGlobalArchivedSessions,
  flattenSessionRows,
  partitionArchivedSessions,
  type SessionListItem,
} from "../src/react-app/domains/session/sidebar/utils.ts";

function group(id: string, sessions: SessionListItem[]): WorkspaceSessionGroup {
  return {
    workspace: { id, name: id, path: `/work/${id}`, preset: "starter", workspaceType: "local" },
    sessions,
    status: "ready",
  };
}

function archived(id: string, archivedAt: number): SessionListItem {
  return { id, title: id, time: { archived: archivedAt } };
}

function keys(groups: WorkspaceSessionGroup[]) {
  return buildGlobalArchivedSessions(groups).map(({ group, session }) => `${group.workspace.id}/${session.id}`);
}

test("Archived uses global archive recency, not workspace, creation, or update order", () => {
  const groups = [
    group("a", [
      { id: "old", title: "Old archive", time: { archived: 100, created: 900, updated: 900 } },
      { id: "middle", title: "Middle archive", time: { archived: 200, created: 800, updated: 800 } },
    ]),
    group("b", [
      { id: "new", title: "New archive", time: { archived: 300, created: 1, updated: 1 } },
    ]),
  ];
  expect(keys(groups)).toEqual(["b/new", "a/middle", "a/old"]);
  expect(keys(groups)).not.toEqual(["a/old", "a/middle", "b/new"]);
});

test("Archived ties use workspace id then session id regardless of workspace and fetched order", () => {
  const groups = [
    group("b", [archived("b", 100), archived("a", 100)]),
    group("a", [archived("b", 100), archived("a", 100)]),
  ];
  const expected = ["a/a", "a/b", "b/a", "b/b"];
  for (const workspaces of [groups, [...groups].reverse()]) {
    expect(keys(workspaces)).toEqual(expected);
    expect(keys(workspaces.map((entry) => ({ ...entry, sessions: [...entry.sessions].reverse() })))).toEqual(expected);
  }
});

test("Archiving adds a row, restoring removes it, and rearchiving moves it to the top", () => {
  const session: SessionListItem = { id: "changing", title: "Changing", time: { created: 1, updated: 999 } };
  const other = group("b", [archived("other", 200)]);
  expect(keys([group("a", [session]), other])).toEqual(["b/other"]);

  const firstArchive = { ...session, time: { ...session.time, archived: 100 } };
  expect(keys([group("a", [firstArchive]), other])).toEqual(["b/other", "a/changing"]);

  const restored = { ...firstArchive, time: { ...firstArchive.time, archived: undefined } };
  expect(keys([group("a", [restored]), other])).toEqual(["b/other"]);
  expect(partitionArchivedSessions([restored]).active).toEqual([restored]);

  const rearchived = { ...restored, time: { ...restored.time, archived: 300 } };
  expect(keys([other, group("a", [rearchived])])).toEqual(["a/changing", "b/other"]);
  expect(partitionArchivedSessions([rearchived]).active).toEqual([]);
});

test("Archived preserves membership including children without mutating inputs or active ordering", () => {
  const parent = archived("parent", 100);
  const child = { ...archived("child", 300), parentID: "parent" };
  const active: SessionListItem[] = [
    { id: "active", title: "Active" },
    { id: "pinned", title: "Pinned", time: { archived: 0 } },
    { id: "manual", title: "Manual", time: { archived: null } },
    { id: "negative", title: "Negative", time: { archived: -1 } },
    { id: "active-child", title: "Active child", parentID: "active" },
  ];
  const first = group("a", [parent, ...active, child]);
  const groups = [first, group("b", [archived("other", 200)])];
  const before = structuredClone(groups);
  for (const entry of groups) {
    for (const session of entry.sessions) {
      if (session.time) Object.freeze(session.time);
      Object.freeze(session);
    }
    Object.freeze(entry.sessions);
    Object.freeze(entry.workspace);
    Object.freeze(entry);
  }
  Object.freeze(groups);

  const entries = buildGlobalArchivedSessions(groups);
  expect(entries.map(({ session }) => session.id)).toEqual(["child", "other", "parent"]);
  expect(entries[0]?.session).toBe(child);
  expect(entries[0]?.group).toBe(groups[0]);
  expect(groups).toEqual(before);
  expect(partitionArchivedSessions(first.sessions).active).toEqual(active);
  expect(flattenSessionRows(first.sessions, 10, new Set(["pinned"]), ["manual", "active"])
    .map(({ session }) => session.id)).toEqual(["pinned", "manual", "active", "negative"]);
  expect(buildGlobalArchivedSessions([])).toEqual([]);
  expect(buildGlobalArchivedSessions([group("empty", active)])).toEqual([]);
});
