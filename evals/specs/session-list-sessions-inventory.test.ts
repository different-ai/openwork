import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { listControlSessions } from "../../apps/app/src/react-app/domains/session/control/list-control-sessions";

// The hook's execute is `(args) => listControlSessions(args, state)`, so every
// call below passes the raw control-action payload exactly as the control
// bridge delivers it (null / {} / a JSON object).

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
const state = {
  workspaces,
  sessionsByWorkspaceId: {
    ws_alpha: sessions("alpha", 100, 1_000),
    ws_beta: sessions("beta", 20, 5_000),
  },
  pinnedIds: [],
  statusFor: () => "idle" as const,
};

test("session.list_sessions returns every loaded session instead of a silent 30-row cap", async ({ evidence }) => {
  const withNull = listControlSessions(null, state);
  const withEmpty = listControlSessions({}, state);

  expect(withNull).toHaveLength(120);
  expect(withEmpty).toEqual(withNull);
  expect(new Set(withNull.map((session) => session.sessionId)).size).toBe(120);
  expect(withNull.slice(0, 20).every((session) => session.workspace === "beta-repo")).toBe(true);
  expect(withNull[20]?.sessionId).toBe("alpha_99");
  expect(withNull.at(-1)?.sessionId).toBe("alpha_0");
  evidence.recordAssertionEvidence(
    "Large session inventories are fully visible to the control surface",
    `120 loaded sessions across two workspaces were all returned for both null and {} args, newest first, with no truncation.`,
    withNull.length === 120 && withEmpty.length === 120,
  );
});

test("session.list_sessions caps output only when args carry a positive integer limit", async ({ evidence }) => {
  const capped = listControlSessions({ limit: 30 }, state);
  const zero = listControlSessions({ limit: 0 }, state);
  const fractional = listControlSessions({ limit: 2.5 }, state);
  const stringy = listControlSessions({ limit: "30" }, state);

  expect(capped).toHaveLength(30);
  expect(capped.map((session) => session.sessionId)).toEqual([
    ...Array.from({ length: 20 }, (_, index) => `beta_${19 - index}`),
    ...Array.from({ length: 10 }, (_, index) => `alpha_${99 - index}`),
  ]);
  expect(zero).toHaveLength(120);
  expect(fractional).toHaveLength(120);
  expect(stringy).toHaveLength(120);
  evidence.recordAssertionEvidence(
    "Truncation is opt-in and only honours a positive integer limit",
    `limit: 30 returned the 30 newest sessions; 0, 2.5 and "30" were ignored and returned all 120.`,
    capped.length === 30 && zero.length === 120 && fractional.length === 120 && stringy.length === 120,
  );
});

test("session.list_sessions narrows to one workspace by id or display name without leaking others", async ({ evidence }) => {
  const byId = listControlSessions({ workspaceId: "ws_alpha" }, state);
  const byName = listControlSessions({ workspaceId: " alpha " }, state);
  const unknown = listControlSessions({ workspaceId: "ws_missing" }, state);
  const combined = listControlSessions({ workspaceId: "ws_alpha", limit: 5 }, state);

  expect(byId).toHaveLength(100);
  expect(byId.every((session) => session.workspace === "Alpha")).toBe(true);
  expect(byName.map((session) => session.sessionId)).toEqual(byId.map((session) => session.sessionId));
  expect(unknown).toEqual([]);
  expect(combined.map((session) => session.sessionId)).toEqual(["alpha_99", "alpha_98", "alpha_97", "alpha_96", "alpha_95"]);
  evidence.recordAssertionEvidence(
    "Workspace filter is exact, composes with limit, and never falls back to another workspace",
    `ws_alpha and " alpha " both returned the same 100 sessions; an unknown workspace returned none; limit 5 kept the 5 newest alpha sessions.`,
    byId.length === 100 && unknown.length === 0 && combined.length === 5,
  );
});

test("session.list_sessions keeps pinned sessions first and skips entries without ids", async ({ evidence }) => {
  const listed = listControlSessions(null, {
    workspaces,
    sessionsByWorkspaceId: {
      ws_alpha: [...sessions("alpha", 3, 1_000), { title: "no id" }, { id: "  " }],
      ws_beta: sessions("beta", 2, 5_000),
    },
    pinnedIds: ["alpha_0"],
    statusFor: () => "idle" as const,
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

test("session.list_sessions exposes each session's bound model and reasoning effort as `model`", async ({ evidence }) => {
  // The engine's session record carries {id, providerID, variant}; the app
  // holds it verbatim, and agents read it back in the session.create shape
  // (the engine's literal "default" variant reads as null, the composer's value).
  const listed = listControlSessions(null, {
    workspaces,
    sessionsByWorkspaceId: {
      ws_alpha: [
        { id: "alpha_high", title: "Runs at high", time: { updated: 3 }, model: { id: "claude-fable-5-1", providerID: "lpr_test", variant: "high" } },
        { id: "alpha_default", title: "Runs at the provider default", time: { updated: 2 }, model: { id: "gpt-6-astra", providerID: "openai", variant: "default" } },
        { id: "alpha_unbound", title: "No model bound yet", time: { updated: 1 } },
      ],
      ws_beta: [],
    },
    pinnedIds: [],
    statusFor: () => "idle" as const,
  });

  expect(listed.map((session) => [session.sessionId, session.model])).toEqual([
    ["alpha_high", { providerId: "lpr_test", modelId: "claude-fable-5-1", variant: "high" }],
    ["alpha_default", { providerId: "openai", modelId: "gpt-6-astra", variant: null }],
    ["alpha_unbound", null],
  ]);
  expect(listed.every((session) => "model" in session)).toBe(true);
  evidence.recordAssertionEvidence(
    "Agents can read a session's model and effort without opening the SQLite store",
    `Three sessions listed with model {providerId, modelId, variant}: high effort, provider default (variant null), and null before any model is bound.`,
    listed[0]?.model?.variant === "high" && listed[1]?.model?.variant === null && listed[2]?.model === null,
  );
});
