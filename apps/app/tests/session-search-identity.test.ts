import { expect, test } from "bun:test";

import {
  dedupeSearchableSessions,
  searchableSessionKey,
  type SearchableSession,
} from "../src/react-app/domains/session/search/session-search";

const session = (workspaceId: string, sessionId: string, updatedAt: number): SearchableSession => ({
  workspaceId,
  sessionId,
  title: `${workspaceId} ${sessionId} ${updatedAt}`,
  workspaceTitle: workspaceId,
  updatedAt,
});

test("session search keeps one fresh result per workspace session", () => {
  const stale = session("workspace-a", "session-1", 10);
  const fresh = session("workspace-a", "session-1", 20);
  const otherWorkspace = session("workspace-b", "session-1", 15);

  const unique = dedupeSearchableSessions([stale, otherWorkspace, fresh]);

  expect(unique).toEqual([fresh, otherWorkspace]);
  expect(unique.map(searchableSessionKey)).toEqual([
    "workspace-a\u0000session-1",
    "workspace-b\u0000session-1",
  ]);
  expect(new Set(unique.map(searchableSessionKey)).size).toBe(unique.length);
});
