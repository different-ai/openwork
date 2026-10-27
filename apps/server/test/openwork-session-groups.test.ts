import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenWorkExtensionsPreview } from "../src/opencode-plugins/openwork-extensions-preview.js";
import { openworkReadTransport, type OpenworkReadTransport } from "../src/opencode-plugins/openwork-read-transport.js";
import { isSessionGroupWritePath } from "../src/opencode-v2-context-bridge.js";

type State = { groups: Array<{ id: string; label: string }>; assignments: Record<string, string> };

// A host with the session-group route semantics and no desktop window: any
// UI-control request fails the test, so every call must run on the server.
function fakeHost(state: State, sessions: string[]) {
  const writes: string[] = [];
  const groupsBase = "/workspace/ws1/session-groups";
  const reply = () => ({ state: structuredClone(state), updatedAt: Date.now() });
  const transport: OpenworkReadTransport = {
    engine: "v2",
    get: async (path) => {
      if (path === "/workspaces") return { items: [{ id: "ws1", name: "Enterprise" }] };
      if (path === groupsBase) return reply();
      if (path.startsWith("/workspace/ws1/opencode/session?")) {
        return sessions.map((id) => ({ id, title: `Task ${id}` }));
      }
      const session = /^\/workspace\/ws1\/opencode\/session\/([^/?]+)$/.exec(path)?.[1];
      if (session && sessions.includes(decodeURIComponent(session))) return { id: decodeURIComponent(session), title: `Task ${session}` };
      throw new Error(`unexpected read ${path}`);
    },
    post: async (path) => { throw new Error(`no window should be needed (${path})`); },
    send: async (method, path, body) => {
      writes.push(`${method} ${path}`);
      if (method === "POST" && path === groupsBase) {
        state.groups.push({ id: `g${state.groups.length + 1}`, label: String(body?.label) });
        return reply();
      }
      const assigned = /\/session-groups\/assignments\/([^/]+)$/.exec(path)?.[1];
      if (method === "PATCH" && assigned) {
        const groupId = typeof body?.groupId === "string" ? body.groupId : null;
        if (groupId && state.groups.some((group) => group.id === groupId)) state.assignments[decodeURIComponent(assigned)] = groupId;
        else delete state.assignments[decodeURIComponent(assigned)];
        return reply();
      }
      const removed = /\/session-groups\/([^/?]+)(?:\?destinationGroupId=(.+))?$/.exec(path);
      if (method === "DELETE" && removed?.[1]) {
        const destination = removed[2] ? decodeURIComponent(removed[2]) : null;
        for (const [sessionId, groupId] of Object.entries(state.assignments)) {
          if (groupId !== removed[1]) continue;
          if (destination) state.assignments[sessionId] = destination;
          else delete state.assignments[sessionId];
        }
        state.groups = state.groups.filter((group) => group.id !== removed[1]);
        return reply();
      }
      throw new Error(`unexpected write ${method} ${path}`);
    },
  };
  return { transport, writes };
}

async function call(transport: OpenworkReadTransport, tool: "openwork_query" | "openwork_execute", id: string, args: Record<string, unknown>) {
  const plugin = await OpenWorkExtensionsPreview();
  try {
    const raw = await openworkReadTransport.run(transport, () => plugin.tool[tool].execute({ id, args }, {}));
    return JSON.parse(String(raw));
  } finally {
    await plugin.dispose?.();
  }
}

test("groups are created, listed and changed without the desktop window", async () => {
  const state: State = { groups: [{ id: "g1", label: "In progress" }], assignments: { s1: "g1", gone: "g1" } };
  const { transport, writes } = fakeHost(state, ["s1", "s2"]);

  const listed = await call(transport, "openwork_query", "session.group.list", {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.groups, [{ id: "g1", label: "In progress", sessions: [{ sessionId: "s1", title: "Task s1" }] }]);
  assert.equal(listed.result.staleAssignments, 1);
  assert.deepEqual(writes, [], "listing never writes");

  const created = await call(transport, "openwork_execute", "session.group.create", { label: "Done" });
  assert.equal(created.result.created, true);
  assert.equal(created.result.pruned, 1, "the deleted task's entry is dropped");
  assert.equal(state.assignments.gone, undefined);
  const again = await call(transport, "openwork_execute", "session.group.create", { label: "done" });
  assert.deepEqual([again.result.created, again.result.groupId], [false, created.result.groupId]);

  const moved = await call(transport, "openwork_execute", "session.group.move", { sessionId: "s1", groupId: "Done" });
  assert.equal(moved.ok, true);
  assert.equal(state.assignments.s1, created.result.groupId);

  const unknown = await call(transport, "openwork_execute", "session.group.move", { sessionId: "s2", groupId: "Backlog" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /No group matched Backlog\. Groups: In progress \(g1\), Done/);

  const removed = await call(transport, "openwork_execute", "session.group.remove", { groupId: "Done", destinationGroupId: "g1", confirmed: true });
  assert.equal(removed.ok, true);
  assert.deepEqual(state, { groups: [{ id: "g1", label: "In progress" }], assignments: { s1: "g1" } });
});

test("stale entries are kept when the task list cannot be read in full", async () => {
  const state: State = { groups: [{ id: "g1", label: "Done" }], assignments: { other: "g1" } };
  const { transport } = fakeHost(state, ["s1"]);
  const get = transport.get;
  transport.get = async (path) => {
    if (path.startsWith("/workspace/ws1/opencode/session?")) throw new Error("engine unavailable");
    return get(path);
  };
  const moved = await call(transport, "openwork_execute", "session.group.move", { sessionId: "s1", groupId: "g1" });
  assert.equal(moved.ok, true);
  assert.deepEqual(state.assignments, { other: "g1", s1: "g1" });
});

test("the v2 bridge writes only session-group routes", () => {
  for (const path of [
    "/workspace/ws1/session-groups",
    "/workspace/ws1/session-groups/assignments/ses_1",
    "/workspace/ws1/session-groups/g1?destinationGroupId=g2",
  ]) assert.equal(isSessionGroupWritePath(path), true, path);
  for (const path of [
    "/workspace/ws1/session-groups/../../config",
    "/workspace/ws1/session-groups/%2e%2e",
    "/workspace/ws1/session-groups/assignments/a/b",
    "/workspace/ws1/session-groups/g1?other=1",
    "/workspace/ws1/opencode/session",
  ]) assert.equal(isSessionGroupWritePath(path), false, path);
});

test("the v2 bridge runs group commands and refuses unregistered commands", async () => {
  const { createV2ContextBridge } = await import("../src/opencode-v2-context-bridge.js");
  const state: State = { groups: [{ id: "g1", label: "Done" }], assignments: {} };
  const { transport } = fakeHost(state, ["s1"]);
  const send = transport.send;
  assert.ok(send);
  const bridge = await createV2ContextBridge(async (path, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    // The bridge reads sessions through the native v2 engine routes.
    if (path.startsWith("/workspace/ws1/opencode2/api/session?")) return { data: [{ id: "s1", title: "Task s1" }] };
    if (path === "/workspace/ws1/opencode2/api/session/s1") return { data: { id: "s1", title: "Task s1" } };
    return method === "GET" ? transport.get(path) : send(method as "POST" | "PATCH" | "DELETE", path, body);
  });
  const post = async (input: unknown) => {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_execute", input, sessionId: "s1" }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const moved = await post({ id: "session.group.move", args: { sessionId: "s1", groupId: "Done" } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.ok, true, JSON.stringify(moved.body));
    assert.equal(state.assignments.s1, "g1");
    const refused = await post({ id: "session.create", args: { sessions: [{ title: "x", prompt: "y" }] } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not available here/);
  } finally {
    await bridge.close();
  }
});

test("the v2 bridge advertises automation proposals without exposing other app commands", async () => {
  const { createV2ContextBridge } = await import("../src/opencode-v2-context-bridge.js");
  const bridge = await createV2ContextBridge(async (path, init) => {
    if (path === "/experimental/connect/skills") return { skills: [] };
    assert.equal(path, "/experimental/ui-control/request");
    assert.equal(JSON.parse(String(init?.body)).kind, "context");
    return { ok: true, context: { availableAffordances: [] } };
  });
  try {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_context", input: {}, sessionId: "s1" }),
    });
    assert.equal(response.status, 200);
    const { context } = await response.json();
    const commands = context.availableAffordances.filter((item: { kind: string }) => item.kind === "command");
    assert.deepEqual(commands.map((item: { id: string }) => item.id).sort(), [
      "automation.propose", "session.group.create", "session.group.move", "session.group.remove",
    ]);
    const proposal = context.contributions.find((item: { featureId: string }) => item.featureId === "automations");
    assert.equal(proposal.affordances[0].id, "automation.propose");
    assert.deepEqual(proposal.affordances[0].effects, { data: "none", ui: "none", external: false });
  } finally {
    await bridge.close();
  }
});

test("a v2 automation proposal is validated and returned for review without creating or running anything", async () => {
  const { createV2ContextBridge } = await import("../src/opencode-v2-context-bridge.js");
  const hostCalls: string[] = [];
  const bridge = await createV2ContextBridge(async (path) => {
    hostCalls.push(path);
    throw new Error("An automation proposal must not call the host");
  });
  const args = {
    name: "Morning greeting",
    instructions: "Post Good morning! in the team's Slack general channel.",
    schedule: { kind: "daily", hour: 9, minute: 0, timezone: "America/Los_Angeles" },
  };
  const post = async (id: string, input = args) => {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_execute", input: { id, args: input }, sessionId: "s1" }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const proposed = await post("automation.propose");
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.equal(proposed.body.ok, true);
    assert.equal(proposed.body.id, "automation.propose");
    assert.deepEqual(proposed.body.result.proposal, args);
    assert.equal(proposed.body.result.created, false);
    assert.equal(proposed.body.result.kind, "automation-proposal");
    assert.deepEqual(proposed.body.effects, { data: "none", ui: "none", external: false });

    const retargeted = { ...args, workspaceId: "ws_other" };
    const untrustedWorkspace = await post("automation.propose", retargeted);
    assert.deepEqual(untrustedWorkspace.body.result.proposal, args, "model-supplied workspace targeting is ignored");
    const unauthorized = await fetch(bridge.url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_execute", input: { id: "automation.propose", args } }),
    });
    assert.equal(unauthorized.status, 401);

    const malformed = await post("automation.propose", { ...args, schedule: { ...args.schedule, hour: 25 } });
    assert.equal(malformed.status, 400);
    assert.match(malformed.body.error, /hour/);
    for (const id of ["automation.create", "automation.activate", "automation.run", "extension.call", "session.create"]) {
      const refused = await post(id);
      assert.equal(refused.status, 400, id);
      assert.match(refused.body.error, /not available here/);
    }
    assert.deepEqual(hostCalls, []);
  } finally {
    await bridge.close();
  }
});
