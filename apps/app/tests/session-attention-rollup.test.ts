import { beforeEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { currentLocale, setLocale, t } from "../src/i18n";
import { createSessionChildIdsSelector, useSessionActivityStore, type SessionActivityStatus } from "../src/react-app/domains/session/status/session-activity-store";
import { createWorkspaceSessionAttentionSelector, selectSessionAttention, sessionAttentionLabel, sessionAttentionSidebarStatus } from "../src/react-app/domains/session/status/session-attention";
import { listControlSessions } from "../src/react-app/domains/session/control/list-control-sessions";

const workspaceId = "ws-rollup";
const parent = { id: "ses-parent", title: "Review changes" };
const child = { id: "ses-child", title: "Review tests", parentID: parent.id };
const grandchild = { id: "ses-grandchild", title: "Read server", parentID: child.id };
const unrelated = { id: "ses-other", title: "Unrelated root" };
const sessions = [parent, child, grandchild, unrelated];

const selectChildIds = createSessionChildIdsSelector();
const selectWorkspaceAttention = createWorkspaceSessionAttentionSelector();

function workspaceAttention(workspace = workspaceId, inventory = sessions, serverId?: string) {
  const state = useSessionActivityStore.getState();
  const children = selectChildIds(state);
  return selectWorkspaceAttention(inventory, {
    statuses: state.statusesByWorkspaceId[workspace],
    waiting: state.waitingByWorkspaceId[workspace],
    childIds: children[workspace],
    serverStatuses: serverId ? state.statusesByWorkspaceId[serverId] : undefined,
    serverWaiting: serverId ? state.waitingByWorkspaceId[serverId] : undefined,
    serverChildIds: serverId ? children[serverId] : undefined,
  });
}

function attentionFor(sessionId: string) {
  return workspaceAttention().get(sessionId);
}

function taskTranscript(childSessionId: string, text = "Inspecting"): UIMessage[] {
  return [{
    id: "msg-task", role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "task", toolCallId: "call-task", state: "input-available",
      input: { description: "Inspect", prompt: "Inspect tests", subagent_type: "general" },
      callProviderMetadata: { openwork: { childSessionId } },
    }, { type: "text", text }],
  }];
}

const empty = { busy: 0, waiting: 0, unknown: 0 };

describe("descendant attention inventory", () => {
  beforeEach(() => {
    useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} });
    for (const session of sessions) useSessionActivityStore.getState().setRunStatus(workspaceId, session.id, "idle");
  });

  test("locale changes refresh cached fallback titles without changing attention state", () => {
    const previousLocale = currentLocale();
    const select = createWorkspaceSessionAttentionSelector();
    const inventory = [parent, { ...child, title: "" }];
    const inputs = {
      statuses: { [parent.id]: "idle", [child.id]: "waiting" } satisfies Record<string, SessionActivityStatus>,
      waiting: { [child.id]: "question" } satisfies Record<string, "question">,
    };
    try {
      setLocale("en");
      const english = select(inventory, inputs);
      expect(select(inventory, inputs)).toBe(english);
      expect(english.get(parent.id)?.blockedBy?.title).toBe(t("session.default_title"));
      setLocale("fr");
      const french = select(inventory, inputs);
      expect(french).not.toBe(english);
      expect(select(inventory, inputs)).toBe(french);
      const blockedBy = french.get(parent.id)?.blockedBy;
      expect(blockedBy?.title).toBe(t("session.default_title"));
      expect(blockedBy?.title).not.toBe(english.get(parent.id)?.blockedBy?.title);
      if (!blockedBy) throw new Error("Expected a pending child question");
      expect(sessionAttentionLabel(blockedBy)).toBe(`${t("session.subagent_question_pending")}: ${t("session.default_title")}`);
      expect(french.get(parent.id)?.descendantActivity).toEqual(english.get(parent.id)?.descendantActivity);
      expect(french.get(parent.id)?.status).toBe("waiting");
    } finally {
      setLocale(previousLocale);
    }
  });

  test("progress, timestamps, and unrelated records preserve relationship and attention identity", () => {
    const store = useSessionActivityStore.getState();
    store.observeTranscript(workspaceId, parent.id, taskTranscript(child.id));
    const before = useSessionActivityStore.getState();
    const relationships = selectChildIds(before);
    const attention = workspaceAttention();
    let relationshipChanges = 0;
    const unsubscribe = useSessionActivityStore.subscribe((state) => {
      if (selectChildIds(state) !== relationships) relationshipChanges += 1;
    });
    try {
      store.observeTranscript(workspaceId, parent.id, taskTranscript(child.id, "Inspecting more files"));
      store.seedSessionRun(workspaceId, parent.id, "idle", false, {
        snapshotStartedAt: before.recordsByWorkspaceId[workspaceId][parent.id].runStatusAt + 1,
      });
      store.markMessageRole(workspaceId, unrelated.id, "other-message", "assistant");
      store.markMessageRole("unrelated-workspace", "other-session", "message", "assistant");
      const after = useSessionActivityStore.getState();
      expect(after.recordsByWorkspaceId[workspaceId][parent.id]).not.toBe(before.recordsByWorkspaceId[workspaceId][parent.id]);
      expect(after.recordsByWorkspaceId[workspaceId][parent.id].progressRevision).not.toBe(before.recordsByWorkspaceId[workspaceId][parent.id].progressRevision);
      expect(selectChildIds(after)).toBe(relationships);
      expect(relationshipChanges).toBe(0);
      expect(workspaceAttention()).toBe(attention);
      expect(attentionFor(parent.id)).toBe(attention.get(parent.id));
    } finally {
      unsubscribe();
    }
  });

  test("child and status changes invalidate only the affected workspace attention", () => {
    const store = useSessionActivityStore.getState();
    const otherSessions = [{ id: "other-parent", title: "Other workspace" }];
    store.setRunStatus("other-workspace", "other-parent", "idle");
    store.observeTranscript("other-workspace", "other-parent", taskTranscript("other-missing"));
    const otherRelationships = selectChildIds(useSessionActivityStore.getState())["other-workspace"];
    const otherAttention = workspaceAttention("other-workspace", otherSessions);
    const initial = workspaceAttention();
    store.observeTranscript(workspaceId, parent.id, taskTranscript("missing-child"));
    const relationships = selectChildIds(useSessionActivityStore.getState());
    expect(relationships[workspaceId][parent.id]).toEqual(["missing-child"]);
    expect(relationships["other-workspace"]).toBe(otherRelationships);
    const linked = workspaceAttention();
    expect(linked).not.toBe(initial);
    expect(linked.get(parent.id)?.descendantActivity).toEqual({ ...empty, unknown: 1 });
    store.setRunStatus(workspaceId, child.id, "running");
    expect(selectChildIds(useSessionActivityStore.getState())).toBe(relationships);
    const busy = workspaceAttention();
    expect(busy).not.toBe(linked);
    expect(busy.get(parent.id)?.descendantActivity).toEqual({ busy: 1, waiting: 0, unknown: 1 });
    store.setWaitingRequest(workspaceId, child.id, "question", "question", true);
    const waiting = workspaceAttention();
    expect(waiting).not.toBe(busy);
    expect(waiting.get(parent.id)?.blockedBy?.kind).toBe("question");
    store.setWaitingRequest(workspaceId, child.id, "permission", "permission", true);
    expect(workspaceAttention()).not.toBe(waiting);
    expect(attentionFor(parent.id)?.blockedBy?.kind).toBe("permission");
    expect(workspaceAttention("other-workspace", otherSessions)).toBe(otherAttention);
  });

  test("removal and reset discard relationships without clearing surviving parent links", () => {
    const store = useSessionActivityStore.getState();
    store.observeTranscript(workspaceId, parent.id, taskTranscript(child.id));
    store.observeTranscript(workspaceId, child.id, taskTranscript("missing-child"));
    const before = selectChildIds(useSessionActivityStore.getState());
    const attention = workspaceAttention();
    store.removeSession(workspaceId, child.id);
    const removed = selectChildIds(useSessionActivityStore.getState());
    expect(removed).not.toBe(before);
    expect(removed[workspaceId][parent.id]).toBe(before[workspaceId][parent.id]);
    expect(removed[workspaceId][child.id]).toBeUndefined();
    expect(workspaceAttention()).not.toBe(attention);
    expect(attentionFor(parent.id)?.descendantActivity).toEqual({ ...empty, unknown: 1 });
    store.removeSession(workspaceId, parent.id);
    expect(selectChildIds(useSessionActivityStore.getState())).toEqual({});
    store.observeTranscript(workspaceId, parent.id, taskTranscript("new-child"));
    expect(selectChildIds(useSessionActivityStore.getState())[workspaceId][parent.id]).toEqual(["new-child"]);
    useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} });
    expect(selectChildIds(useSessionActivityStore.getState())).toEqual({});
    store.seedWorkspaceSessions(workspaceId, sessions.map((session) => ({ ...session, status: "idle" })));
    expect(attentionFor(parent.id)?.descendantActivity).toEqual(empty);
  });

  test("workspace and server aliases merge children with server status and waiting precedence", () => {
    const store = useSessionActivityStore.getState();
    store.observeTranscript(workspaceId, parent.id, taskTranscript(child.id));
    store.observeTranscript("server", parent.id, taskTranscript("missing-child"));
    store.setWaitingRequest(workspaceId, child.id, "question", "question", true);
    const local = workspaceAttention();
    store.setWaitingRequest("server", child.id, "permission", "permission", true);
    const aliased = workspaceAttention(workspaceId, sessions, "server");
    expect(aliased.get(parent.id)).toMatchObject({
      status: "waiting", blockedBy: { kind: "permission" },
      descendantActivity: { busy: 0, waiting: 1, unknown: 1 },
    });
    store.setError("server", child.id, "failed");
    const errored = workspaceAttention(workspaceId, sessions, "server");
    expect(errored).not.toBe(aliased);
    expect(errored.get(parent.id)).toMatchObject({ status: "idle", blockedBy: null, descendantActivity: { ...empty, unknown: 1 } });
    expect(workspaceAttention(workspaceId, sessions, "server")).toBe(errored);
    expect(local.get(parent.id)?.blockedBy?.kind).toBe("question");
    store.removeSession("server", child.id);
    expect(workspaceAttention(workspaceId, sessions, "server").get(parent.id)?.blockedBy?.kind).toBe("question");
  });

  test("inventory changes invalidate cached archives, titles, and cyclic parent relationships", () => {
    const select = createWorkspaceSessionAttentionSelector();
    const inputs = {
      statuses: { [parent.id]: "idle", [child.id]: "waiting" } satisfies Record<string, SessionActivityStatus>,
      waiting: { [child.id]: "question" } satisfies Record<string, "question">,
    };
    const inventory = [parent, child];
    const initial = select(inventory, inputs);
    expect(select(inventory, inputs)).toBe(initial);
    const renamed = select([parent, { ...child, title: "Renamed child" }], inputs);
    expect(renamed).not.toBe(initial);
    expect(renamed.get(parent.id)?.blockedBy?.title).toBe("Renamed child");
    const archived = select([parent, { ...child, time: { archived: 1 } }], inputs);
    expect(archived.get(parent.id)?.descendantActivity).toEqual(empty);
    const unlinked = select([parent, { ...child, parentID: null }], inputs);
    expect(unlinked.get(parent.id)?.working).toBe(false);
    const cyclic = select([{ ...parent, parentID: child.id }, child], {
      ...inputs, childIds: { [parent.id]: [child.id, child.id, "missing"], [child.id]: [parent.id] },
    });
    expect(cyclic.get(parent.id)?.descendantActivity).toEqual({ busy: 0, waiting: 1, unknown: 1 });
    expect(cyclic.get(child.id)?.descendantActivity).toEqual({ ...empty, unknown: 1 });
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
