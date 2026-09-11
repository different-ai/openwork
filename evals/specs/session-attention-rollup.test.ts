import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { useSessionActivityStore } from "../../apps/app/src/react-app/domains/session/status/session-activity-store";
import { selectSessionAttention, sessionAttentionLabel } from "../../apps/app/src/react-app/domains/session/status/session-attention";
import { listControlSessions } from "../../apps/app/src/react-app/domains/session/control/list-control-sessions";

// The sidebar, session.list_sessions and the transcript all read the same
// roll-up: a delegated child's unanswered permission or question makes its
// parent "waiting" (orange, needs you) instead of "thinking" (spinner).

const workspaceId = "ws_rollup";
const parent = { id: "ses_parent", title: "Slop audit (Astra high)", time: { updated: 300 } };
const child = { id: "ses_child", title: "Audit four open PRs", parentID: parent.id, time: { updated: 310 } };
const grandchild = { id: "ses_grandchild", title: "Read den-web", parentID: child.id, time: { updated: 320 } };
const unrelated = { id: "ses_other", title: "Unrelated root", time: { updated: 200 } };
const sessions = [parent, child, grandchild, unrelated];

function reset() {
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} });
  return useSessionActivityStore.getState();
}

function attention() {
  const state = useSessionActivityStore.getState();
  return selectSessionAttention(
    sessions,
    (id) => state.statusesByWorkspaceId[workspaceId]?.[id],
    (id) => state.waitingByWorkspaceId[workspaceId]?.[id],
  );
}

function listed() {
  const rolled = attention();
  return new Map(listControlSessions(null, {
    workspaces: [{ id: workspaceId, displayName: "Rollup" }],
    sessionsByWorkspaceId: { [workspaceId]: sessions },
    pinnedIds: [],
    statusFor: (_workspace, sessionId) => rolled.get(sessionId)?.status ?? "idle",
  }).map((entry) => [entry.sessionId, entry]));
}

test("the activity store keeps a delegating parent at thinking while its child's permission makes the roll-up waiting", async ({ evidence }) => {
  const store = reset();
  store.setRunStatus(workspaceId, parent.id, "running");
  store.setRunStatus(workspaceId, child.id, "running");
  store.setWaitingRequest(workspaceId, child.id, "permission", "per_1", true);

  const own = store.getStatus(workspaceId, parent.id);
  const rolled = attention();
  expect(own).toBe("thinking");
  expect(store.getStatus(workspaceId, child.id)).toBe("waiting");
  expect(rolled.get(parent.id)).toEqual({
    status: "waiting",
    blockedBy: { sessionId: child.id, title: child.title, kind: "permission" },
  });
  expect(rolled.get(child.id)).toEqual({ status: "waiting", blockedBy: null });
  expect(rolled.get(unrelated.id)).toEqual({ status: "idle", blockedBy: null });
  expect(sessionAttentionLabel({ sessionId: child.id, title: child.title, kind: "permission" }))
    .toBe(`Needs permission: ${child.title}`);
  evidence.recordAssertionEvidence(
    "A child's pending permission rolls up to the parent without touching unrelated roots",
    `Parent own status ${own}; rolled-up parent status ${rolled.get(parent.id)?.status} naming ${rolled.get(parent.id)?.blockedBy?.title}; unrelated root ${rolled.get(unrelated.id)?.status}.`,
    own === "thinking" && rolled.get(parent.id)?.status === "waiting" && rolled.get(unrelated.id)?.status === "idle",
  );
});

test("session.list_sessions reports a blocked parent as waiting and returns it to working once the child is answered", async ({ evidence }) => {
  const store = reset();
  store.setRunStatus(workspaceId, parent.id, "running");
  store.setWaitingRequest(workspaceId, grandchild.id, "question", "que_1", true);

  const blocked = listed();
  expect(blocked.get(parent.id)).toMatchObject({ status: "waiting", working: true });
  expect(blocked.get(child.id)).toMatchObject({ status: "waiting", working: true });
  expect(blocked.get(grandchild.id)).toMatchObject({ status: "waiting", working: true });
  expect(blocked.get(unrelated.id)).toMatchObject({ status: "idle", working: false });

  store.setWaitingRequest(workspaceId, grandchild.id, "question", "que_1", false);
  const answered = listed();
  expect(answered.get(parent.id)).toMatchObject({ status: "thinking", working: true });
  expect(answered.get(child.id)).toMatchObject({ status: "idle", working: false });
  expect(answered.get(grandchild.id)).toMatchObject({ status: "idle", working: false });
  evidence.recordAssertionEvidence(
    "Agents see the parent as waiting only while a descendant's request is unanswered",
    `Blocked: parent ${blocked.get(parent.id)?.status}; answered: parent ${answered.get(parent.id)?.status}, unrelated ${answered.get(unrelated.id)?.status}.`,
    blocked.get(parent.id)?.status === "waiting" && answered.get(parent.id)?.status === "thinking",
  );
});

test("the parent's own error or own request outranks a descendant's request", async ({ evidence }) => {
  const store = reset();
  store.setWaitingRequest(workspaceId, child.id, "permission", "per_1", true);
  store.setError(workspaceId, parent.id, "Provider failed");
  const errored = attention().get(parent.id);
  expect(errored).toEqual({ status: "error", blockedBy: null });

  store.clearError(workspaceId, parent.id);
  store.setRunStatus(workspaceId, parent.id, "running");
  store.setWaitingRequest(workspaceId, parent.id, "question", "que_own", true);
  const own = attention().get(parent.id);
  expect(own).toEqual({ status: "waiting", blockedBy: null });
  evidence.recordAssertionEvidence(
    "Precedence is error > own waiting > descendant waiting",
    `With a child permission pending, an errored parent reports ${errored?.status}; a parent with its own question reports ${own?.status} with blockedBy ${String(own?.blockedBy)}.`,
    errored?.status === "error" && own?.status === "waiting" && own?.blockedBy === null,
  );
});
