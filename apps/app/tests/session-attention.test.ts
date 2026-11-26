import { describe, expect, test } from "bun:test";
import { createWorkspaceSessionAttentionSelector, sessionAttentionSidebarStatus } from "../src/react-app/domains/session/status/session-attention";

const sessions = [
  { id: "parent", title: "Plan the route" },
  { id: "child", title: "Check travel times", parentID: "parent" },
  { id: "other", title: "Review supplies" },
];
const approval = { id: "approval", reason: "credential" };

describe("sidebar computer approvals", () => {
  test("a parent waits for its own approval while its child and unrelated chat keep working", () => {
    const select = createWorkspaceSessionAttentionSelector();
    const inputs = { statuses: { parent: "responding", child: "thinking", other: "responding" } } as const;
    const active = select(sessions, inputs);
    const waiting = select(sessions, { ...inputs, computerRequests: { parent: approval } });
    expect(active.get("parent")?.status).toBe("responding");
    expect(waiting.get("parent")).toMatchObject({ status: "waiting", blockedBy: null, descendantActivity: { busy: 1, waiting: 0 } });
    expect(waiting.get("child")?.status).toBe("thinking");
    expect(waiting.get("other")?.status).toBe("responding");
    expect(select(sessions, inputs).get("parent")?.status).toBe("responding");
  });

  test("an approval from a known child also reaches its parent, even without a run snapshot", () => {
    const select = createWorkspaceSessionAttentionSelector();
    const attention = select(sessions, { computerRequests: { child: approval } });
    expect(attention.get("child")?.status).toBe("waiting");
    expect(attention.get("parent")).toMatchObject({
      status: "waiting",
      blockedBy: { sessionId: "child", kind: "permission", relationship: "child" },
      descendantActivity: { busy: 0, waiting: 1, unknown: 0 },
    });
  });

  test("when only the child is working, the parent can show the working indicator", () => {
    const select = createWorkspaceSessionAttentionSelector();
    const parent = select(sessions, { statuses: { child: "thinking" } }).get("parent");
    expect(parent && sessionAttentionSidebarStatus(parent)).toBe("thinking");
  });
});
