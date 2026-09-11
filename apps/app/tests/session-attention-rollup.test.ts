import { beforeEach, describe, expect, test } from "bun:test";

import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { selectSessionAttention, sessionAttentionLabel } from "../src/react-app/domains/session/status/session-attention";

const workspaceId = "ws-rollup";
const parent = { id: "ses-parent", title: "Slop audit (Astra high)" };
const child = { id: "ses-child", title: "Audit four open PRs", parentID: parent.id };
const grandchild = { id: "ses-grandchild", title: "Read den-web", parentID: child.id };
const unrelated = { id: "ses-other", title: "Unrelated root" };
const sessions = [parent, child, grandchild, unrelated];

function attentionFor(sessionId: string) {
  const state = useSessionActivityStore.getState();
  return selectSessionAttention(
    sessions,
    (id) => state.statusesByWorkspaceId[workspaceId]?.[id],
    (id) => state.waitingByWorkspaceId[workspaceId]?.[id],
  ).get(sessionId);
}

describe("delegated child attention roll-up", () => {
  beforeEach(() => {
    useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {}, waitingByWorkspaceId: {} });
  });

  test("RCA: the store keeps the parent's own status at thinking while its child waits on a permission", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, parent.id, "running");
    store.setRunStatus(workspaceId, child.id, "running");
    store.setWaitingRequest(workspaceId, child.id, "permission", "per-1", true);

    // The child's record carries the request; the parent's does not.
    expect(store.getStatus(workspaceId, child.id)).toBe("waiting");
    expect(store.getStatus(workspaceId, parent.id)).toBe("thinking");
    expect(useSessionActivityStore.getState().waitingByWorkspaceId[workspaceId]).toEqual({ [child.id]: "permission" });

    // The roll-up is what the sidebar, list_sessions, and notifications read.
    expect(attentionFor(parent.id)).toEqual({
      status: "waiting",
      blockedBy: { sessionId: child.id, title: child.title, kind: "permission" },
    });
    expect(attentionFor(child.id)).toEqual({ status: "waiting", blockedBy: null });
    expect(attentionFor(unrelated.id)).toEqual({ status: "idle", blockedBy: null });
  });

  test("answering the request returns the parent to its own working status", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, parent.id, "running");
    store.setWaitingRequest(workspaceId, child.id, "permission", "per-1", true);
    expect(attentionFor(parent.id)?.status).toBe("waiting");

    store.setWaitingRequest(workspaceId, child.id, "permission", "per-1", false);
    expect(useSessionActivityStore.getState().waitingByWorkspaceId[workspaceId]).toEqual({});
    expect(attentionFor(parent.id)).toEqual({ status: "thinking", blockedBy: null });
  });

  test("a grandchild's question reaches every ancestor and names the grandchild", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, parent.id, "running");
    store.setWaitingRequest(workspaceId, grandchild.id, "question", "q-1", true);

    const source = { sessionId: grandchild.id, title: grandchild.title, kind: "question" as const };
    expect(attentionFor(parent.id)).toEqual({ status: "waiting", blockedBy: source });
    expect(attentionFor(child.id)).toEqual({ status: "waiting", blockedBy: source });
    expect(sessionAttentionLabel(source)).toBe("Waiting for your answer: Read den-web");
    expect(sessionAttentionLabel({ sessionId: child.id, title: child.title, kind: "permission" }))
      .toBe("Needs permission: Audit four open PRs");
  });

  test("precedence: the parent's own error or own request wins over a descendant's request", () => {
    const store = useSessionActivityStore.getState();
    store.setWaitingRequest(workspaceId, child.id, "permission", "per-1", true);

    store.setError(workspaceId, parent.id, "boom");
    expect(attentionFor(parent.id)).toEqual({ status: "error", blockedBy: null });

    store.clearError(workspaceId, parent.id);
    store.setRunStatus(workspaceId, parent.id, "running");
    store.setWaitingRequest(workspaceId, parent.id, "question", "q-own", true);
    expect(attentionFor(parent.id)).toEqual({ status: "waiting", blockedBy: null });
  });

  test("a child that is compacting or idle does not roll anything up; a removed child releases the parent", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, parent.id, "running");
    store.setCompacting(workspaceId, child.id, true);
    expect(attentionFor(parent.id)).toEqual({ status: "thinking", blockedBy: null });

    store.setWaitingRequest(workspaceId, child.id, "permission", "per-1", true);
    expect(attentionFor(parent.id)?.status).toBe("waiting");
    store.removeSession(workspaceId, child.id);
    expect(useSessionActivityStore.getState().waitingByWorkspaceId[workspaceId]).toEqual({});
    expect(attentionFor(parent.id)).toEqual({ status: "thinking", blockedBy: null });
  });

  test("cyclic parent data terminates", () => {
    const cyclic = [
      { id: "a", title: "A", parentID: "b" },
      { id: "b", title: "B", parentID: "a" },
    ];
    const attention = selectSessionAttention(cyclic, () => "thinking", (id) => (id === "a" ? "permission" : undefined));
    expect(attention.get("a")).toEqual({ status: "thinking", blockedBy: null });
    expect(attention.get("b")).toEqual({ status: "waiting", blockedBy: { sessionId: "a", title: "A", kind: "permission" } });
  });
});
