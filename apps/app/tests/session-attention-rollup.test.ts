import { beforeEach, describe, expect, test } from "bun:test";
import { useSessionActivityStore, type SessionActivityStatus } from "../src/react-app/domains/session/status/session-activity-store";
import { selectSessionAttention, sessionAttentionLabel, sessionAttentionSidebarStatus } from "../src/react-app/domains/session/status/session-attention";
import { listControlSessions } from "../src/react-app/domains/session/control/list-control-sessions";

const workspaceId = "ws-rollup";
const parent = { id: "ses-parent", title: "Review changes" };
const child = { id: "ses-child", title: "Review tests", parentID: parent.id };
const grandchild = { id: "ses-grandchild", title: "Read server", parentID: child.id };
const unrelated = { id: "ses-other", title: "Unrelated root" };
const sessions = [parent, child, grandchild, unrelated];

function attentionFor(sessionId: string) {
  const state = useSessionActivityStore.getState();
  return selectSessionAttention(
    sessions,
    (id) => state.statusesByWorkspaceId[workspaceId]?.[id],
    (id) => state.waitingByWorkspaceId[workspaceId]?.[id],
    (id) => state.recordsByWorkspaceId[workspaceId]?.[id]?.childSessionIds ?? [],
  ).get(sessionId);
}

const empty = { busy: 0, waiting: 0, unknown: 0 };

describe("descendant attention inventory", () => {
  beforeEach(() => {
    useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} });
    for (const session of sessions) useSessionActivityStore.getState().setRunStatus(workspaceId, session.id, "idle");
  });

  test("a busy child keeps an idle parent working without fabricating own activity", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, child.id, "running");
    expect(store.getStatus(workspaceId, parent.id)).toBe("idle");
    const listed = listControlSessions({}, {
      workspaces: [{ id: workspaceId }], sessionsByWorkspaceId: { [workspaceId]: sessions }, pinnedIds: [],
      statusFor: store.getStatus, attentionFor: (_workspace, id) => attentionFor(id),
    });
    expect(listed.find((session) => session.sessionId === parent.id)?.working).toBe(true);
    const attention = attentionFor(parent.id);
    expect(attention).toEqual({ status: "idle", blockedBy: null, working: true, descendantActivity: { ...empty, busy: 1 }, inventoryComplete: true });
    expect(attention && sessionAttentionSidebarStatus(attention)).toBe("thinking");
    expect(attentionFor(unrelated.id)).toEqual({ status: "idle", blockedBy: null, working: false, descendantActivity: empty, inventoryComplete: true });
  });

  test("a busy grandchild reaches every hop once even with duplicate session rows", () => {
    const attention = selectSessionAttention([...sessions, grandchild], (id) => id === grandchild.id ? "responding" : "idle", () => undefined);
    expect(attention.get(parent.id)?.descendantActivity).toEqual({ ...empty, busy: 1 });
    expect(attention.get(child.id)?.descendantActivity).toEqual({ ...empty, busy: 1 });
    expect(attention.get(grandchild.id)?.descendantActivity).toEqual(empty);
  });

  test("waiting wins over a busy descendant and normal own running", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, parent.id, "running");
    store.setRunStatus(workspaceId, child.id, "running");
    store.setWaitingRequest(workspaceId, grandchild.id, "question", "q-1", true);
    const attention = attentionFor(parent.id);
    expect(attention).toEqual({
      status: "waiting", working: true, inventoryComplete: true,
      descendantActivity: { busy: 1, waiting: 1, unknown: 0 },
      blockedBy: { sessionId: grandchild.id, title: grandchild.title, kind: "question", relationship: "descendant" },
    });
    expect(attention && sessionAttentionSidebarStatus(attention)).toBe("waiting");
    expect(attentionFor(child.id)?.blockedBy?.relationship).toBe("child");
    expect(attention?.blockedBy && sessionAttentionLabel(attention.blockedBy)).toBe("Waiting for your answer: Read server");
  });

  test("answering a child request releases waiting but keeps known work", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, parent.id, "running");
    store.setWaitingRequest(workspaceId, child.id, "permission", "per-1", true);
    expect(attentionFor(parent.id)?.blockedBy).toEqual({ sessionId: child.id, title: child.title, kind: "permission", relationship: "child" });
    expect(sessionAttentionLabel({ sessionId: child.id, title: child.title, kind: "permission" })).toBe("Needs permission: Review tests");
    store.setWaitingRequest(workspaceId, child.id, "permission", "per-1", false);
    expect(attentionFor(parent.id)).toEqual({ status: "thinking", blockedBy: null, working: true, descendantActivity: empty, inventoryComplete: true });
  });

  const statuses: SessionActivityStatus[] = ["error", "waiting", "compacting", "thinking", "responding", "idle"];
  for (const own of statuses) {
    test(`own ${own} precedence is preserved with busy and waiting descendants`, () => {
      const busy = selectSessionAttention(sessions, (id) => id === parent.id ? own : "thinking", () => undefined).get(parent.id);
      expect(busy?.status).toBe(own);
      expect(busy?.working).toBe(true);
      const waiting = selectSessionAttention(sessions, (id) => id === parent.id ? own : "waiting", () => "permission").get(parent.id);
      expect(waiting?.status).toBe(own === "error" || own === "waiting" ? own : "waiting");
      expect(waiting?.blockedBy === null).toBe(own === "error" || own === "waiting");
    });
  }

  test("compacting descendants count as busy; idle and errored descendants do not", () => {
    const store = useSessionActivityStore.getState();
    store.setCompacting(workspaceId, child.id, true);
    store.setError(workspaceId, grandchild.id, "failed");
    expect(attentionFor(parent.id)?.descendantActivity).toEqual({ ...empty, busy: 1 });
  });

  test("an archived branch contributes neither activity nor unknown descendants", () => {
    const attention = selectSessionAttention([parent, { ...child, time: { archived: 1 } }, grandchild],
      (id) => id === parent.id ? "idle" : "thinking", () => "permission", (id) => id === grandchild.id ? ["missing"] : []);
    expect(attention.get(parent.id)).toEqual({ status: "idle", blockedBy: null, working: false, descendantActivity: empty, inventoryComplete: true });
  });

  test("missing activity for a known child is unknown, not idle or working", () => {
    const attention = selectSessionAttention([parent, child], (id) => id === parent.id ? "idle" : undefined, () => undefined).get(parent.id);
    expect(attention).toEqual({ status: "idle", blockedBy: null, working: false, descendantActivity: { ...empty, unknown: 1 }, inventoryComplete: false });
  });

  test("a task child absent from the app inventory is unknown even with a stale busy status", () => {
    const store = useSessionActivityStore.getState();
    store.observeTranscript(workspaceId, parent.id, [{
      id: "msg-task", role: "assistant", parts: [{
        type: "dynamic-tool", toolName: "task", toolCallId: "call-task", state: "input-available",
        input: { description: "Inspect", prompt: "Inspect tests", subagent_type: "general" },
        callProviderMetadata: { openwork: { childSessionId: "missing-child" } },
      }],
    }]);
    store.setRunStatus(workspaceId, "missing-child", "running");
    const attention = attentionFor(parent.id);
    expect(attention?.descendantActivity).toEqual({ ...empty, unknown: 1 });
    expect(attention?.working).toBe(false);
    expect(attention?.inventoryComplete).toBe(false);
  });

  test("unknown never erases known busy/waiting descendants", () => {
    const attention = selectSessionAttention(sessions, (id) => id === child.id ? "thinking" : "idle",
      (id) => id === grandchild.id ? "question" : undefined, (id) => id === child.id ? ["missing"] : []).get(parent.id);
    expect(attention).toMatchObject({ status: "waiting", working: true, inventoryComplete: false, descendantActivity: { busy: 1, waiting: 1, unknown: 1 } });
  });

  test("cyclic and duplicate graph references terminate without counting the root", () => {
    const cyclic = [{ id: "a", parentID: "b" }, { id: "b", parentID: "a" }];
    const attention = selectSessionAttention(cyclic, () => "thinking", () => undefined, () => ["a", "b", "b"]);
    expect(attention.get("a")?.descendantActivity).toEqual({ ...empty, busy: 1 });
    expect(attention.get("b")?.descendantActivity).toEqual({ ...empty, busy: 1 });
  });

  test("list_sessions projects the complete rollup including unknown and own error", () => {
    const attention = selectSessionAttention(sessions, (id) => id === parent.id ? "error" : "thinking", () => undefined, (id) => id === parent.id ? ["missing"] : []);
    const listed = listControlSessions({}, {
      workspaces: [{ id: workspaceId }], sessionsByWorkspaceId: { [workspaceId]: sessions }, pinnedIds: [],
      statusFor: () => "idle", attentionFor: (_workspace, id) => attention.get(id),
    });
    expect(listed.find((session) => session.sessionId === parent.id)).toMatchObject({
      status: "error", working: true, descendantActivity: { busy: 2, waiting: 0, unknown: 1 }, inventoryComplete: false,
    });
  });
});
