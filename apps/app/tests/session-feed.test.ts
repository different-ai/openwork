import { describe, expect, test } from "bun:test";

import type { WorkspaceSessionGroup } from "../src/app/types";
import { buildSessionFeed, type SessionFeedContext } from "../src/react-app/domains/session/sidebar/session-feed";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 29, 15, 0).getTime();
const MIDNIGHT = new Date(2026, 9, 29).getTime();

function session(id: string, updated: number, extra: Record<string, unknown> = {}, created = updated) {
  return { id, title: id, time: { created, updated }, ...extra };
}

function group(workspaceId: string, sessions: ReturnType<typeof session>[]): WorkspaceSessionGroup {
  // Only the fields the feed reads; the rest of the shape is irrelevant here.
  return JSON.parse(JSON.stringify({ workspace: { id: workspaceId, name: workspaceId }, sessions, status: "ready" }));
}

function feed(groups: WorkspaceSessionGroup[], overrides: Partial<SessionFeedContext> = {}) {
  return buildSessionFeed(groups, {
    pinnedIds: new Set(),
    unreadIds: new Set(),
    settledById: {},
    statusById: {},
    settleWorkspaceIds: new Set(["lounge", "flow"]),
    autoSettleDays: 3,
    now: NOW,
    feedFolders: [],
    groupsByWorkspace: {},
    groupBy: "day",
    sortBy: "activity",
    ...overrides,
  });
}

const ids = (entries: { session: { id: string } }[]) => entries.map((entry) => entry.session.id);
const sections = (result: ReturnType<typeof feed>) =>
  result.sections.map(({ section, entries }) => `${section}:${ids(entries).join(",")}`);

describe("sidebar feed", () => {
  const groups = [
    group("lounge", [
      session("today-old", MIDNIGHT + 60_000),
      session("approval", MIDNIGHT - 2 * DAY),
      session("yesterday", MIDNIGHT - 60_000),
      session("idle-week", NOW - 7 * DAY),
      session("child", NOW, { parentID: "today-old" }),
    ]),
    group("flow", [session("today-new", NOW - 60_000), session("earlier", MIDNIGHT - 2 * DAY)]),
  ];

  test("merges every workspace, newest first, by day", () => {
    const result = feed(groups, { statusById: { approval: "waiting" } });
    expect(ids(result.needsYou)).toEqual(["approval"]);
    expect(sections(result)).toEqual([
      "today:today-new,today-old",
      "yesterday:yesterday",
      "earlier:earlier",
    ]);
    expect(ids(result.settled)).toEqual(["idle-week"]);
  });

  test("leaves out pinned and sub-agent sessions", () => {
    const result = feed(groups, { pinnedIds: new Set(["today-new"]) });
    const all = [...result.needsYou, ...result.sections.flatMap((section) => section.entries), ...result.settled];
    expect(ids(all)).not.toContain("today-new");
    expect(ids(all)).not.toContain("child");
  });

  test("workspaces that cannot settle keep every session active", () => {
    const result = feed(groups, { settleWorkspaceIds: new Set(["flow"]) });
    expect(result.settled).toEqual([]);
    expect(ids(result.sections.find((section) => section.section === "earlier")?.entries ?? [])).toContain("idle-week");
  });

  test("pinned folders keep their sessions, even with new activity, and flag what needs you", () => {
    const result = feed(groups, {
      feedFolders: [{ workspaceId: "flow", groupId: "later" }, { workspaceId: "lounge", groupId: "removed" }],
      groupsByWorkspace: {
        flow: { groups: [{ id: "later", label: "Later" }], assignments: { "today-new": "later", earlier: "later" } },
      },
      unreadIds: new Set(["today-new"]),
    });
    expect(result.folders.map((folder) => `${folder.label}:${ids(folder.entries).join(",")}:${folder.attention}`)).toEqual([
      "Later:today-new,earlier:unread",
    ]);
    const outside = [...result.needsYou, ...result.sections.flatMap((section) => section.entries), ...result.settled];
    expect(ids(outside)).not.toContain("today-new");
    expect(ids(outside)).not.toContain("earlier");
  });

  test("groups into active and inactive, keeping Needs you on top", () => {
    const result = feed(groups, {
      groupBy: "activity",
      statusById: { approval: "waiting", yesterday: "running" },
      unreadIds: new Set(["earlier"]),
    });
    expect(ids(result.needsYou)).toEqual(["approval"]);
    expect(sections(result)).toEqual([
      "active:yesterday,earlier",
      "inactive:today-new,today-old",
    ]);
  });

  test("lists everything in one section when not grouped", () => {
    expect(sections(feed(groups, { groupBy: "none" }))).toEqual([
      "all:today-new,today-old,yesterday,approval,earlier",
    ]);
  });

  test("sorts and groups by creation time", () => {
    const created = [
      group("lounge", [
        session("old-but-busy", NOW - 60_000, {}, MIDNIGHT - 2 * DAY),
        session("new-and-quiet", MIDNIGHT + 60_000, {}, MIDNIGHT + 30_000),
        session("made-yesterday", MIDNIGHT + 120_000, {}, MIDNIGHT - 60_000),
      ]),
    ];
    expect(sections(feed(created))).toEqual(["today:old-but-busy,made-yesterday,new-and-quiet"]);
    expect(sections(feed(created, { sortBy: "created" }))).toEqual([
      "today:new-and-quiet",
      "yesterday:made-yesterday",
      "earlier:old-but-busy",
    ]);
  });
});
