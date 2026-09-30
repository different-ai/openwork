import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { createV2ConnectionGateBridge, type NativeConnectionRequest } from "./opencode-v2-connection-gate.js";

const connection = {
  schemaVersion: "1", connectionId: "conn_notes", connectionName: "Notes", state: "needs_connection", actor: "member",
  message: "Connect Notes to continue.", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
};
const request = { sessionID: "ses_1", messageID: "msg_1", id: "call_1", tool: "openwork-cloud_execute_capability", connection };

async function fixture(support = true) {
  const calls: { path: string; body?: unknown }[] = [];
  let form: unknown;
  let answer: unknown;
  let running = true;
  let cancelled = false;
  const nativeRequest: NativeConnectionRequest = async (path, init) => {
    calls.push({ path, body: init?.body });
    if (path === "/api/session/ses_1") return { status: 200, json: { data: { id: "ses_1", location: { directory: "/workspace" } } } };
    if (path === "/api/session/active") return { status: 200, json: { data: running ? { ses_1: { type: "running" } } : {} } };
    if (path === "/api/session/ses_1/context") return { status: 200, json: { data: [{ id: "msg_user", type: "user", text: "Prepare my report" }, { id: "msg_1", type: "assistant" }] } };
    if (path === "/api/session/ses_1/message/msg_1") return { status: 200, json: { data: {
      id: "msg_1", type: "assistant", content: [{ type: "text", text: "Your summary is complete." },
        { type: "tool", id: "call_1", name: "execute", state: { status: running ? "running" : "error" } },
        { type: "tool", id: "call_2", name: "execute", state: { status: running ? "running" : "error" } }],
    } } };
    if (path === "/api/session/ses_1/form" && init?.method === "POST") {
      form = init.body;
      return { status: 200, json: { data: { id: "frm_1", sessionID: "ses_1" } } };
    }
    if (path === "/api/session/ses_1/form/frm_1/state") return { status: 200, json: { data: answer
      ? { status: "answered", answer } : { status: cancelled ? "cancelled" : "pending" } } };
    if (path === "/api/session/ses_1/form/frm_1/cancel") { cancelled = true; return { status: 204, json: null }; }
    throw new Error(`Unexpected native request: ${path}`);
  };
  const bridge = await createV2ConnectionGateBridge({ nativeRequest,
    hostRequest: async () => ({ ok: true, context: { features: { connectionQuestions: true, connectionDecisions: support } } }),
  });
  return {
    bridge, calls, form: () => form, cancelled: () => cancelled,
    answer: (value: string) => { answer = { connection: value }; },
    stop: () => { running = false; },
    post: (body: unknown = request, signal?: AbortSignal) => fetch(bridge.url, { method: "POST", signal,
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

async function until(condition: () => boolean) {
  for (let count = 0; count < 100 && !condition(); count++) await delay(10);
  expect(condition()).toBe(true);
}

test.each(["skip", "authenticate"])("the host binds the running call and waits for %s", async (choice) => {
  const world = await fixture();
  let returned = false;
  const pending = world.post().then(async response => { returned = true; return response.json(); });
  try {
    await until(() => world.form() !== undefined || returned);
    expect(returned, "The blocked operation must wait for the native decision").toBe(false);
    expect(world.form()).toMatchObject({
      title: "Connection",
      metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" }, openworkConnectionDecision: { connection } },
      fields: [{ key: "connection", custom: false, options: [{ value: "authenticate", label: "Authenticate" }, { value: "skip", label: "Skip" }] }],
    });
    world.answer(choice);
    expect(await pending).toEqual({ outcome: choice === "skip" ? "skipped" : "connected" });
    expect(world.calls.filter(call => call.path.endsWith("/form"))).toHaveLength(1);
    expect(world.calls.some(call => /prompt|interrupt/.test(call.path))).toBe(false);
  } finally {
    world.stop();
    await world.bridge.close();
    await pending.catch(() => undefined);
  }
});

test("an older host receives no form and retains the manual connection result", async () => {
  const world = await fixture(false);
  try {
    expect(await (await world.post()).json()).toEqual({ outcome: "unsupported" });
    expect(world.form()).toBeUndefined();
    expect(world.calls).toEqual([]);
  } finally { await world.bridge.close(); }
});

test("stopping the originating call cancels its form and cannot release a late Authenticate", async () => {
  const world = await fixture();
  const pending = world.post();
  try {
    await until(() => world.form() !== undefined);
    world.stop();
    world.answer("authenticate");
    expect(await (await pending).json()).toEqual({ outcome: "cancelled" });
    expect(world.cancelled()).toBe(true);
    expect(world.calls.filter(call => call.path.endsWith("/cancel"))).toHaveLength(1);
  } finally { await world.bridge.close(); }
});

test("disconnecting the gate caller cancels the native form", async () => {
  const world = await fixture();
  const controller = new AbortController();
  const pending = world.post(request, controller.signal).catch(() => undefined);
  try {
    await until(() => world.form() !== undefined);
    controller.abort();
    await pending;
    await until(world.cancelled);
  } finally { await world.bridge.close(); }
});

test("shutdown cancels pending decisions before closing its private endpoint", async () => {
  const world = await fixture();
  const pending = world.post().catch(() => undefined);
  await until(() => world.form() !== undefined);
  await world.bridge.close();
  await pending;
  expect(world.cancelled()).toBe(true);
});

test("the gate is authenticated, rejects other actions, and never forwards arbitrary native routes", async () => {
  const world = await fixture();
  try {
    expect((await fetch(world.bridge.url, { method: "POST", body: JSON.stringify(request) })).status).toBe(401);
    for (const body of [
      { ...request, path: "/api/session/ses_1/prompt" },
      { ...request, connection: { ...connection, actor: "organization_admin" } },
      { ...request, tool: "other-server_execute_capability" },
      { ...request, sessionID: "../other" },
    ]) expect((await world.post(body)).status).toBe(400);
    expect(world.calls).toEqual([]);
  } finally { await world.bridge.close(); }
});

test("Skip survives a later status check in the same Code Mode turn", async () => {
  const world = await fixture();
  const first = world.post();
  try {
    await until(() => world.form() !== undefined);
    world.answer("skip");
    expect(await (await first).json()).toEqual({ outcome: "skipped" });
    const second = world.post();
    await second;
    expect(world.calls.filter(call => call.path.endsWith("/form")), "Skip must not open another sign-in decision inside the same turn").toHaveLength(1);
    expect(await (await second).json()).toEqual({ outcome: "skipped" });
  } finally { world.stop(); await world.bridge.close(); }
});

test("parallel calls to one connection share the user's Skip decision", async () => {
  const world = await fixture();
  const first = world.post();
  const second = world.post({ ...request, id: "call_2" });
  try {
    await until(() => world.form() !== undefined);
    world.answer("skip");
    expect(await (await first).json()).toEqual({ outcome: "skipped" });
    expect(await (await second).json()).toEqual({ outcome: "skipped" });
    expect(world.calls.filter(call => call.path.endsWith("/form")), "One user decision covers parallel calls to the same connection").toHaveLength(1);
  } finally { world.stop(); await world.bridge.close(); }
});

test("duplicate reports for the same pending call share one decision", async () => {
  const world = await fixture();
  const first = world.post();
  const second = world.post();
  try {
    await until(() => world.form() !== undefined);
    world.answer("skip");
    expect(await (await first).json()).toEqual({ outcome: "skipped" });
    expect(await (await second).json()).toEqual({ outcome: "skipped" });
    expect(world.calls.filter(call => call.path.endsWith("/form"))).toHaveLength(1);
  } finally { await world.bridge.close(); }
});
