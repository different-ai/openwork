import { describe, expect, test } from "bun:test";

import {
  rankSearchableSessions,
  type SearchableSession,
} from "../src/react-app/domains/session/search/session-search";
import { buildCommandPaletteSessions } from "../src/react-app/shell/command-palette-sessions";
import type { RouteSession, RouteWorkspace } from "../src/react-app/shell/route-workspaces";

const NOW = new Date(2026, 9, 29, 15, 0).getTime();
const MINUTE = 60 * 1000;

function searchable(sessionId: string, title: string, updatedAt: number, workspaceTitle = "Lounge"): SearchableSession {
  return { workspaceId: "lounge", sessionId, title, workspaceTitle, updatedAt };
}

function routeSession(id: string, updated: number, extra: Record<string, unknown> = {}): RouteSession {
  // Only the fields the builder reads; the rest of the shape is irrelevant here.
  return JSON.parse(JSON.stringify({ id, title: id, time: { created: updated, updated }, ...extra }));
}

function workspace(id: string): RouteWorkspace {
  return JSON.parse(JSON.stringify({ id, name: id, path: `/tmp/${id}` }));
}

const ids = (sessions: { sessionId: string }[]) => sessions.map((session) => session.sessionId);

describe("rankSearchableSessions", () => {
  test("lists the newest message first with no query", () => {
    const sessions = [
      searchable("old", "Quarterly report", NOW - 60 * MINUTE),
      searchable("new", "Launch plan", NOW - MINUTE),
      searchable("mid", "Hiring notes", NOW - 10 * MINUTE),
    ];
    expect(ids(rankSearchableSessions(sessions, "", 15))).toEqual(["new", "mid", "old"]);
    expect(ids(rankSearchableSessions(sessions, "", 2))).toEqual(["new", "mid"]);
  });

  test("orders title matches by newest message, not match quality", () => {
    const sessions = [
      searchable("exact-old", "report", NOW - 60 * MINUTE),
      searchable("partial-new", "Weekly report draft", NOW - MINUTE),
      searchable("unrelated", "Launch plan", NOW),
    ];
    expect(ids(rankSearchableSessions(sessions, "report", 50))).toEqual(["partial-new", "exact-old"]);
  });

  test("matches every word across title and workspace", () => {
    const sessions = [
      searchable("both", "Budget review", NOW - 5 * MINUTE, "Finance"),
      searchable("title-only", "Budget ideas", NOW - MINUTE, "Lounge"),
    ];
    expect(ids(rankSearchableSessions(sessions, "budget finance", 50))).toEqual(["both"]);
  });

  test("keeps looser fuzzy matches below every contained match", () => {
    const sessions = [
      searchable("typo-new", "Reprot cleanup", NOW),
      searchable("contains-old", "Monthly report", NOW - 60 * MINUTE),
    ];
    const ranked = ids(rankSearchableSessions(sessions, "report", 50));
    expect(ranked[0]).toBe("contains-old");
  });
});

describe("buildCommandPaletteSessions", () => {
  test("leaves out sub-agent sessions", () => {
    const options = buildCommandPaletteSessions(
      [workspace("lounge")],
      {
        lounge: [
          routeSession("parent", NOW - MINUTE),
          routeSession("child", NOW, { parentID: "parent" }),
          routeSession("blank-parent", NOW - 2 * MINUTE, { parentID: "  " }),
        ],
      },
      "lounge",
    );
    expect(ids(options)).toEqual(["parent", "blank-parent"]);
  });

  test("normalizes engines that report seconds", () => {
    const options = buildCommandPaletteSessions(
      [workspace("seconds"), workspace("millis")],
      {
        seconds: [routeSession("in-seconds", Math.floor(NOW / 1000))],
        millis: [routeSession("in-millis", NOW - MINUTE)],
      },
      "",
    );
    expect(ids(options)).toEqual(["in-seconds", "in-millis"]);
    expect(options[0]?.updatedAt).toBe(Math.floor(NOW / 1000) * 1000);
  });
});
