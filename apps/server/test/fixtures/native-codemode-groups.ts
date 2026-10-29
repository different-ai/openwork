import assert from "node:assert/strict";
import { z } from "zod";

/** Real host-route shapes; only the backing store is in memory. No desktop window. */
export function groupHost() {
  const assignments: Record<string, string> = { keep: "working", "move-a": "working", "move-b": "working" };
  const groups = [{ id: "working", label: "Working" }, { id: "done", label: "Done" }];
  const writes: unknown[] = [];
  const state = () => ({ state: { groups, assignments: { ...assignments } } });
  const sessions = Object.keys(assignments).map(id => ({ id, title: `Task ${id}` }));
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    init?.signal?.throwIfAborted();
    if (path === "/experimental/connect/skills") return { skills: [] };
    if (path === "/experimental/extensions/actions") return { actions: [] };
    if (path === "/workspaces") return { items: [{ id: "ws1", name: "Workspace" }] };
    if (path.startsWith("/workspace/ws1/opencode2/api/session?")) return { data: sessions };
    if (path.startsWith("/workspace/ws1/opencode/session?")) return sessions;
    if (path === "/workspace/ws1/session-groups") return state();
    const assignment = /^\/workspace\/ws1\/session-groups\/assignments\/([^/]+)$/.exec(path);
    if (assignment?.[1]) {
      assert.equal(init?.method, "PATCH");
      const body = z.object({ groupId: z.string().optional() }).parse(JSON.parse(String(init?.body)));
      writes.push({ path, body });
      const sessionId = decodeURIComponent(assignment[1]);
      if (body.groupId) assignments[sessionId] = body.groupId;
      else delete assignments[sessionId];
      return state();
    }
    if (path === "/experimental/ui-control/request") {
      const body = z.object({ kind: z.literal("context") }).parse(JSON.parse(String(init?.body)));
      assert.equal(body.kind, "context");
      return { ok: true, context: { revision: 9, availableAffordances: [
        { id: "session.create", kind: "command", executor: { kind: "openwork" } },
        { id: "connect.call", kind: "command", executor: { kind: "tool", tool: "remote" } },
      ] } };
    }
    throw new Error(`unexpected host request ${init?.method ?? "GET"} ${path}`);
  };
  return { request, writes, assignments };
}

export const groupListingSchema = z.object({ ok: z.boolean(), result: z.object({ groups: z.array(z.object({
  id: z.string(), sessions: z.array(z.object({ sessionId: z.string() })),
})) }) });
export function listedAssignments(value: unknown) {
  const listing = groupListingSchema.parse(value);
  return Object.fromEntries(listing.result.groups.flatMap(group => group.sessions.map(session => [session.sessionId, group.id])));
}
