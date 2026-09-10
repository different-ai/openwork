import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { listControlSessions } from "../../apps/app/src/react-app/domains/session/control/list-control-sessions";

const workspaces = [
  { id: "ws_alpha", displayName: "Alpha" },
  { id: "ws_beta", name: "beta-repo" },
];

function sessions(prefix: string, count: number, startAt: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${index}`,
    title: `${prefix} task ${index}`,
    time: { updated: startAt + index },
  }));
}

// ~100 sessions in one workspace mirrors the reported inventory that the old
// hard-coded 30-row cap silently dropped.
const sessionsByWorkspaceId = {
  ws_alpha: sessions("alpha", 100, 1_000),
  ws_beta: sessions("beta", 20, 5_000),
};

test("session.list_sessions returns every loaded session instead of a silent 30-row cap", async ({ evidence }) => {
  const listed = listControlSessions({ workspaces, sessionsByWorkspaceId, pinnedIds: [] });

  expect(listed).toHaveLength(120);
  expect(new Set(listed.map((session) => session.sessionId)).size).toBe(120);
  expect(listed.slice(0, 20).every((session) => session.workspace === "beta-repo")).toBe(true);
  expect(listed[20]?.sessionId).toBe("alpha_99");
  expect(listed.at(-1)?.sessionId).toBe("alpha_0");
  evidence.recordAssertionEvidence(
    "Large session inventories are fully visible to the control surface",
    `120 loaded sessions across two workspaces were all returned, newest first, with no truncation.`,
    listed.length === 120,
  );
});

test("session.list_sessions caps output only when the caller passes limit", async ({ evidence }) => {
  const capped = listControlSessions({ workspaces, sessionsByWorkspaceId, pinnedIds: [], limit: 30 });
  const ignoredLimit = listControlSessions({ workspaces, sessionsByWorkspaceId, pinnedIds: [], limit: 0 });

  expect(capped).toHaveLength(30);
  expect(capped.map((session) => session.sessionId)).toEqual([
    ...Array.from({ length: 20 }, (_, index) => `beta_${19 - index}`),
    ...Array.from({ length: 10 }, (_, index) => `alpha_${99 - index}`),
  ]);
  expect(ignoredLimit).toHaveLength(120);
  evidence.recordAssertionEvidence(
    "Truncation is opt-in",
    `limit: 30 returned the 30 newest sessions; limit: 0 was ignored and returned all 120.`,
    capped.length === 30 && ignoredLimit.length === 120,
  );
});

test("session.list_sessions narrows to one workspace by id or display name without leaking others", async ({ evidence }) => {
  const byId = listControlSessions({ workspaces, sessionsByWorkspaceId, pinnedIds: [], workspaceId: "ws_alpha" });
  const byName = listControlSessions({ workspaces, sessionsByWorkspaceId, pinnedIds: [], workspaceId: "alpha" });
  const unknown = listControlSessions({ workspaces, sessionsByWorkspaceId, pinnedIds: [], workspaceId: "ws_missing" });

  expect(byId).toHaveLength(100);
  expect(byId.every((session) => session.workspace === "Alpha")).toBe(true);
  expect(byName.map((session) => session.sessionId)).toEqual(byId.map((session) => session.sessionId));
  expect(unknown).toEqual([]);
  evidence.recordAssertionEvidence(
    "Workspace filter is exact and never falls back to another workspace",
    `ws_alpha and "alpha" both returned the same 100 sessions; an unknown workspace returned none.`,
    byId.length === 100 && unknown.length === 0,
  );
});

test("session.list_sessions keeps pinned sessions first and skips entries without ids", async ({ evidence }) => {
  const listed = listControlSessions({
    workspaces,
    sessionsByWorkspaceId: {
      ws_alpha: [...sessions("alpha", 3, 1_000), { title: "no id" }, { id: "  " }],
      ws_beta: sessions("beta", 2, 5_000),
    },
    pinnedIds: ["alpha_0"],
  });

  expect(listed.map((session) => session.sessionId)).toEqual(["alpha_0", "beta_1", "beta_0", "alpha_2", "alpha_1"]);
  expect(listed[0]?.pinned).toBe(true);
  expect(listed.slice(1).every((session) => !session.pinned)).toBe(true);
  evidence.recordAssertionEvidence(
    "Pinned-first ordering and id hygiene survive the refactor",
    `alpha_0 (pinned, oldest) led the list; two id-less entries were dropped.`,
    listed[0]?.sessionId === "alpha_0" && listed.length === 5,
  );
});
