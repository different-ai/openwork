import { describe, expect, test } from "bun:test";

import type { WorkspaceSessionGroup } from "../src/app/types";
import { buildSessionFeed, feedKeyBetween, type SessionFeedContext } from "../src/react-app/domains/session/sidebar/session-feed";

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
    workedAtById: {},
    placementById: {},
    statusById: {},
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

  const all = (result: ReturnType<typeof feed>) =>
    ids(result.sections.flatMap((section) => section.entries));

  test("merges every workspace, last active first, by day, with nothing set aside as settled", () => {
    const result = feed(groups);
    expect(result).not.toHaveProperty("needsYou");
    expect(result).not.toHaveProperty("settled");
    expect(sections(result)).toEqual([
      "today:today-new,today-old",
      "yesterday:yesterday",
      "earlier:approval,earlier,idle-week",
    ]);
  });

  test("archived sessions leave the feed", () => {
    const result = feed([group("lounge", [session("kept", NOW - 60_000), session("filed", NOW, { time: { created: NOW, updated: NOW, archived: NOW } })])]);
    expect(all(result)).toEqual(["kept"]);
  });

  test("a waiting session stays in its normal day section, listed once", () => {
    const result = feed(groups, { statusById: { approval: "waiting" } });
    expect(sections(result)).toEqual([
      "today:today-new,today-old",
      "yesterday:yesterday",
      "earlier:approval,earlier,idle-week",
    ]);
    expect(all(result).filter((id) => id === "approval")).toHaveLength(1);
  });

  test("leaves out pinned and sub-agent sessions", () => {
    const result = feed(groups, { pinnedIds: new Set(["today-new"]) });
    expect(all(result)).not.toContain("today-new");
    expect(all(result)).not.toContain("child");
  });

  test("a pinned session that is waiting stays in Pinned, out of the feed", () => {
    const result = feed(groups, { pinnedIds: new Set(["approval"]), statusById: { approval: "waiting" } });
    expect(all(result)).not.toContain("approval");
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
    expect(all(result)).not.toContain("today-new");
    expect(all(result)).not.toContain("earlier");
  });

  test("a waiting session filed in a pinned folder stays there and flags the folder", () => {
    const result = feed(groups, {
      feedFolders: [{ workspaceId: "lounge", groupId: "later" }],
      groupsByWorkspace: {
        lounge: { groups: [{ id: "later", label: "Later" }], assignments: { approval: "later" } },
      },
      statusById: { approval: "waiting" },
      unreadIds: new Set(["approval"]),
    });
    expect(result.folders.map((folder) => `${folder.label}:${ids(folder.entries).join(",")}:${folder.attention}`)).toEqual([
      "Later:approval:needs-you",
    ]);
    expect(all(result)).not.toContain("approval");
  });

  test("groups into active and inactive, with waiting sessions among the active ones", () => {
    const result = feed(groups, {
      groupBy: "activity",
      statusById: { approval: "waiting", yesterday: "running" },
      unreadIds: new Set(["earlier"]),
    });
    expect(sections(result)).toEqual([
      "active:yesterday,approval,earlier",
      "inactive:today-new,today-old,idle-week",
    ]);
  });

  test("lists everything in one section when not grouped, waiting sessions included", () => {
    expect(sections(feed(groups, { groupBy: "none", statusById: { approval: "waiting" } }))).toEqual([
      "all:today-new,today-old,yesterday,approval,earlier,idle-week",
    ]);
  });

  test("a session worked on today shows in Today even when the engine kept its old time", () => {
    // OpenCode v2 does not move time.updated when a message is sent; the
    // sidebar records work starting and finishing on this device instead.
    const result = feed(groups, { workedAtById: { yesterday: NOW - 30_000, earlier: MIDNIGHT - 120_000 } });
    expect(sections(result)).toEqual([
      "today:yesterday,today-new,today-old",
      "yesterday:earlier",
      "earlier:approval,idle-week",
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

  test("a dragged session keeps its spot until it has newer activity, then returns to the top", () => {
    // Dragged below today-old at NOW: placed between today-old and the next row.
    const key = feedKeyBetween(MIDNIGHT + 60_000, undefined);
    const placed = feed(groups, { placementById: { "today-new": { key, at: NOW } } });
    expect(sections(placed)[0]).toBe("today:today-old,today-new");
    expect(placed.sortKeyById.get("today-new")).toBe(key);
    // New work after the drag wins over the dragged spot.
    const worked = feed(groups, { placementById: { "today-new": { key, at: NOW - 120_000 } }, workedAtById: { "today-new": NOW - 60_000 } });
    expect(sections(worked)[0]).toBe("today:today-new,today-old");
  });

  test("a session dragged between days moves into that day", () => {
    const key = feedKeyBetween(MIDNIGHT - 2 * DAY, NOW - 7 * DAY);
    const result = feed(groups, { placementById: { "today-old": { key, at: NOW } } });
    expect(sections(result)).toEqual([
      "today:today-new",
      "yesterday:yesterday",
      "earlier:approval,earlier,today-old,idle-week",
    ]);
  });

  test("sorted by creation, dragged spots are ignored and rows do not reorder", () => {
    const result = feed(groups, { sortBy: "created", placementById: { "today-new": { key: 0, at: NOW } } });
    expect(result.reorderable).toBe(false);
    expect(sections(result)[0]).toBe("today:today-new,today-old");
  });

  test("a drop between two rows sorts between them; at either end it sorts just past the neighbour", () => {
    expect(feedKeyBetween(300, 100)).toBe(200);
    expect(feedKeyBetween(300, undefined)).toBe(299);
    expect(feedKeyBetween(undefined, 100)).toBe(101);
  });
});
