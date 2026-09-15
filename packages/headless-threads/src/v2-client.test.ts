import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test, type TestContext } from "node:test";
import { createNativeV2Client } from "./v2-client.ts";
import type { HeadlessFetch } from "./v2-types.ts";

const mount = "/workspace/ws_fixture/opencode2/api";
const sid = "ses_fixture";
const selection = { providerID: "fixture", id: "text", variant: "low" };
const usage = { input: 8, output: 3, reasoning: 0, cache: { read: 0, write: 0 } };
const nativeSession = { id: sid, agent: "fixture", model: selection, projectID: "project_fixture", location: { directory: "/fixture" }, cost: 0, tokens: usage, time: { created: 1, updated: 2 } };
const input = { id: "msg_input", type: "user", text: "Only this request" } satisfies Parameters<ReturnType<typeof createNativeV2Client>["admitInput"]>[1];
const delivered = { id: input.id, type: "user", text: input.text, time: { created: 3 } };
const skill = { id: "skill_fixture", name: "Fixture guidance", description: "Local test skill", location: "/fixture/SKILL.md", content: "Frozen fixture skill body" };
// Synthetic HTTP fixtures follow protocol/schema beta-19086, not the client validators.
const assistant = {
  id: "msg_assistant", type: "assistant", agent: "fixture", model: selection, tokens: usage, cost: 0,
  content: [{ type: "tool", id: "call_fixture", name: "fixture_read", state: {
    status: "completed", input: { path: "example.txt" },
    content: [{ type: "text", text: "Observed" }, { type: "file", uri: "file:///fixture/result.png", mime: "image/png" }],
    metadata: { fixture: true },
  }, time: { created: 4, ran: 5, completed: 6 } }],
  finish: "tool-calls", time: { created: 4, streamed: 5, completed: 6 },
};

type BoundaryState = {
  requests: Array<{ method: string; path: string; body: unknown; headers: IncomingHttpHeaders }>;
  pages: unknown[][];
  inbox: unknown[];
  active: unknown;
  interrupted: boolean;
  persist: "inbox" | "history" | "none";
  fail: "none" | "lost" | "malformed";
  overrides: Map<string, { status: number; body?: unknown }>;
  skills: typeof skill[];
};

async function boundary(t: TestContext) {
  const state: BoundaryState = {
    requests: [], pages: [[]], inbox: [], active: {}, interrupted: false,
    persist: "inbox", fail: "none", overrides: new Map(), skills: [skill],
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body: unknown = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const method = request.method ?? "GET";
      state.requests.push({ method, path: `${url.pathname}${url.search}`, body, headers: request.headers });
      const send = (value: unknown, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(status === 204 ? undefined : JSON.stringify(value));
      };
      const override = state.overrides.get(`${method} ${url.pathname}`);
      if (override) {
        if (override.status === 302) response.setHeader("Location", "/must-not-follow");
        return send(override.body, override.status);
      }
      if (url.pathname === `${mount}/session` && method === "POST") return send({ data: nativeSession });
      if (url.pathname === `${mount}/session/${sid}` && method === "GET") return send({ data: nativeSession });
      if (url.pathname === `${mount}/session/${sid}/inbox` && method === "GET") return send({ data: state.inbox });
      if (url.pathname === `${mount}/skill` && method === "GET") return send({ data: state.skills });
      if (url.pathname === `${mount}/session/${sid}/permission`) return send({ data: method === "POST" ? { id: "per_fixture", effect: "allow" } : [] });
      if (url.pathname === `${mount}/session/${sid}/message` && method === "GET") {
        const cursor = url.searchParams.get("cursor");
        const page = cursor === null ? 0 : Number.parseInt(cursor, 10);
        return send({ data: state.pages[page], cursor: page + 1 < state.pages.length ? { next: `${page + 1}:/opaque? +` } : {} });
      }
      if (method === "POST" && [`${mount}/session/${sid}/prompt`, `${mount}/session/${sid}/synthetic`].includes(url.pathname)) {
        assert.ok(body && typeof body === "object" && "id" in body && "text" in body && "delivery" in body);
        const type = url.pathname.endsWith("/prompt") ? "user" : "synthetic";
        const skills = "skills" in body && Array.isArray(body.skills) ? body.skills.map((value: unknown) => {
          assert.ok(value && typeof value === "object" && "id" in value);
          const found = state.skills.find((item) => item.id === value.id);
          assert.ok(found);
          return { id: found.id, name: found.name, text: found.content };
        }) : undefined;
        const payload = { text: body.text, ...(skills ? { skills } : {}), ...("metadata" in body ? { metadata: body.metadata } : {}) };
        const receipt = { id: body.id, sessionID: sid, type, timeCreated: 3, delivery: body.delivery, payload };
        if (state.persist === "inbox") state.inbox.push(receipt);
        if (state.persist === "history") state.pages.push([{ id: body.id, type, ...payload, time: { created: 3 } }]);
        if (state.fail === "lost") return response.destroy();
        return send(state.fail === "malformed" ? { accepted: true } : { data: receipt });
      }
      if (url.pathname === `${mount}/session/${sid}/interrupt` && method === "POST") return send({ interrupted: state.interrupted });
      if (url.pathname === `${mount}/session/${sid}/wait` && method === "POST") return send(undefined, 204);
      if (url.pathname === `${mount}/session/active` && method === "GET") return send({ data: state.active });
      send({ error: "unimplemented_fixture_route" }, 404);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = { baseUrl: `http://127.0.0.1:${address.port}///`, workspaceId: "ws_fixture", token: "fixture-client-token", requestTimeoutMs: 2_000 };
  return { state, options, client: createNativeV2Client(options) };
}

const postCount = (state: BoundaryState) => state.requests.filter((request) => request.method === "POST" && /\/(prompt|synthetic)$/.test(request.path)).length;

test("native create binding, workspace mount and existing token headers; no v1 fallback", async (t) => {
  const { state, options } = await boundary(t);
  const client = createNativeV2Client({ ...options, hostToken: "fixture-host-token" });
  const created = await client.createSession({ id: sid, title: "Fixture", agent: "fixture", model: selection });
  assert.deepEqual(created, nativeSession);
  assert.deepEqual(state.requests[0]?.body, { id: sid, title: "Fixture", agent: "fixture", model: selection });
  assert.equal(state.requests[0]?.path, `${mount}/session`);
  assert.equal(state.requests[0]?.headers.authorization, "Bearer fixture-client-token");
  assert.equal(state.requests[0]?.headers["x-openwork-host-token"], "fixture-host-token");
  await client.createSession({ id: sid, agent: "fixture", model: selection });
  assert.deepEqual(state.requests.map((request) => request.method), ["POST", "GET", "GET"]);
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 200, body: { data: { ...nativeSession, model: { ...selection, id: "different" } } } });
  await assert.rejects(client.createSession({ id: sid, agent: "fixture", model: selection }), { code: "binding_unconfirmed" });
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 404, body: { error: "missing" } });
  await assert.rejects(client.getSession(sid), { status: 404 });
  // Native create may return an existing foreign ID with the same model/agent.
  // The workspace-scoped GET must authorize it before binding is confirmed.
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 403, body: { error: "wrong_workspace" } });
  const nextClient = createNativeV2Client(options);
  await assert.rejects(nextClient.createSession({ id: sid, agent: "fixture", model: selection }), { status: 403 });
  const creations = state.requests.filter((request) => request.method === "POST").length;
  await assert.rejects(nextClient.createSession({ id: sid, agent: "fixture", model: selection }), { status: 403 });
  assert.equal(state.requests.filter((request) => request.method === "POST").length, creations);
  assert.ok(state.requests.every((request) => request.path.startsWith(mount)));
});

test("exact-ID replay is read-only across cursor pages; messages retain native kinds and evidence", async (t) => {
  const { state, client } = await boundary(t);
  const synthetic = { id: "msg_context", type: "synthetic", text: input.text, time: { created: 1 } };
  const system = { id: "msg_system", type: "system", text: "Fixture guidance", time: { created: 2 } };
  state.pages = [[synthetic, system], [delivered, assistant]];
  const result = await client.admitInput(sid, input);
  assert.equal(result.state, "delivered");
  if (result.state === "delivered") assert.deepEqual(result.message, delivered);
  assert.equal(postCount(state), 0);
  const historyRequests = state.requests.filter((request) => request.path.includes("/message?"));
  const [firstRequest, secondRequest] = historyRequests;
  assert.ok(firstRequest && secondRequest);
  assert.equal(new URL(firstRequest.path, "http://fixture.invalid").searchParams.get("order"), "asc");
  const next = new URL(secondRequest.path, "http://fixture.invalid");
  assert.equal(next.searchParams.get("cursor"), "1:/opaque? +");
  assert.equal(next.searchParams.has("order"), false);
  const page = await client.readHistoryPage(sid, { cursor: "1:/opaque? +" });
  const reply = page.data[1];
  assert.ok(reply);
  assert.deepEqual(reply, assistant);
  assert.equal(Object.hasOwn(reply, "parentID"), false);
  await assert.rejects(client.admitInput(sid, { ...input, text: "Different request" }), { code: "input_conflict" });
  for (const attachments of [
    { agents: [{ name: "another-agent" }] },
    { files: [{ data: "", mime: "text/plain", source: { type: "inline" } }] },
  ]) {
    state.pages = [[{ ...delivered, ...attachments }]];
    await assert.rejects(client.admitInput(sid, input), { code: "input_conflict" });
  }
  assert.equal(postCount(state), 0);
});

test("lost POST response reconciles the exact inbox receipt without another submission", async (t) => {
  const { state, client } = await boundary(t);
  state.fail = "lost";
  const result = await client.admitInput(sid, input);
  assert.equal(result.state, "queued");
  if (result.state === "queued") assert.deepEqual(result.receipt, {
    id: input.id, sessionID: sid, type: "user", timeCreated: 3, delivery: "queue", payload: { text: input.text },
  });
  await client.admitInput(sid, input);
  assert.equal(postCount(state), 1);
  const posted = state.requests.find((request) => request.method === "POST");
  assert.deepEqual(posted?.body, { id: input.id, text: input.text, delivery: "queue", resume: true });
  assert.equal(posted?.headers["x-openwork-host-token"], undefined);
});

test("malformed acknowledgement reconciles delivered history, including later cursor pages", async (t) => {
  const { state, client } = await boundary(t);
  state.pages = [[{ ...delivered, id: "msg_other" }]];
  state.persist = "history";
  state.fail = "malformed";
  const result = await client.admitInput(sid, input);
  assert.equal(result.state, "delivered");
  await client.admitInput(sid, input);
  assert.equal(postCount(state), 1);
});

test("unobserved ambiguous admission and concurrent same-ID calls never resend", async (t) => {
  const { state, options, client } = await boundary(t);
  state.persist = "none";
  state.fail = "lost";
  const results = await Promise.allSettled([client.admitInput(sid, input), client.admitInput(sid, input)]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.code === "admission_unknown"));
  await assert.rejects(client.admitInput(sid, input), { code: "admission_unknown" });
  assert.equal(postCount(state), 1);
  // After restart the durable owner must reconcile its saved ID, not request fresh admission.
  const recovered = await createNativeV2Client(options).reconcileAdmission(sid, input.id);
  assert.deepEqual(recovered, { state: "unobserved", id: input.id });
  assert.equal(postCount(state), 1);
});

test("synthetic context has its own native admission and never becomes user text", async (t) => {
  const { state, client } = await boundary(t);
  const result = await client.admitInput(sid, { type: "synthetic", id: "msg_reference", text: "Untrusted reference data" });
  assert.equal(result.state, "accepted");
  if (result.state === "accepted") assert.equal(result.receipt.type, "synthetic");
  await client.admitInput(sid, input);
  const posts = state.requests.filter((request) => request.method === "POST");
  assert.deepEqual(posts.map((request) => [request.path, request.body]), [
    [`${mount}/session/${sid}/synthetic`, { id: "msg_reference", text: "Untrusted reference data", delivery: "queue", resume: false }],
    [`${mount}/session/${sid}/prompt`, { id: input.id, text: input.text, delivery: "queue", resume: true }],
  ]);
  await assert.rejects(client.admitInput(sid, { ...input, ...{ context: "must not be flattened" } }));
  assert.equal(postCount(state), 2);
});

test("stop distinguishes interrupted work from idle no-op and preserves pending work", async (t) => {
  const { state, client } = await boundary(t);
  const pending = { id: "msg_pending", sessionID: sid, type: "compaction", payload: {}, delivery: "steer", timeCreated: 3 };
  state.inbox = [pending];
  assert.deepEqual(await client.stop(sid), { interrupted: false, idle: true, pending: [pending] });
  state.interrupted = true;
  assert.deepEqual(await client.stop(sid), { interrupted: true, idle: true, pending: [pending] });
  assert.ok(state.requests.filter((request) => request.method === "POST").every((request) => /\/(interrupt\?continue=false|wait)$/.test(request.path)));
  state.active = { [sid]: { type: "running" } };
  await assert.rejects(client.stop(sid), { code: "stop_unconfirmed" });
  state.active = { [sid]: { type: "mystery" } };
  await assert.rejects(client.stop(sid), { code: "invalid_response" });
  state.overrides.set(`GET ${mount}/session/active`, { status: 200, body: {} });
  await assert.rejects(client.stop(sid), { code: "invalid_response" });
  state.overrides.delete(`GET ${mount}/session/active`);
  state.overrides.set(`POST ${mount}/session/${sid}/wait`, { status: 503, body: {} });
  await assert.rejects(client.stop(sid), { status: 503 });
});

test("malformed history, cross-session inbox, repeated cursor, redirect and cancellation fail closed", async (t) => {
  const { state, client } = await boundary(t);
  const historyPath = `GET ${mount}/session/${sid}/message`;
  for (const body of [
    { data: [], cursor: { next: 12 } },
    { data: [{ ...delivered, type: "unknown-kind" }], cursor: {} },
    { data: [{ ...assistant, content: [{ type: "tool", id: "call_bad", name: "fixture_read", time: { created: 1 }, state: { status: "mystery" } }] }], cursor: {} },
    { data: [], cursor: { next: "repeated" } },
  ]) {
    state.overrides.set(historyPath, { status: 200, body });
    await assert.rejects(client.admitInput(sid, input), { code: "invalid_response" });
  }
  state.overrides.delete(historyPath);
  state.inbox = [{ id: input.id, sessionID: "ses_other", type: "user", payload: { text: input.text }, delivery: "queue", timeCreated: 3 }];
  await assert.rejects(client.admitInput(sid, input), { code: "invalid_response" });
  assert.equal(postCount(state), 0);
  const controller = new AbortController();
  controller.abort();
  const count = state.requests.length;
  await assert.rejects(client.admitInput(sid, input, controller.signal));
  assert.equal(state.requests.length, count);
  state.overrides.set(`GET ${mount}/session/${sid}`, { status: 302, body: {} });
  await assert.rejects(client.getSession(sid), { code: "request_failed" });
  assert.equal(state.requests.length, count + 1);
  assert.ok(state.requests.every((request) => !request.path.includes("must-not-follow")));
});

test("native skill catalog and ID-only inputs validate strictly; missing or revoked IDs never submit", async (t) => {
  const { client, state } = await boundary(t);
  assert.deepEqual(await client.listSkills(), [skill]);
  const source = { type: "openwork-cloud", uri: "skill://fixture-guidance/SKILL.md", scope: "a".repeat(64) };
  const cloudSkill = { ...skill, id: "native_cloud_fixture", source };
  state.overrides.set(`GET ${mount}/skill`, { status: 200, body: { data: [skill, cloudSkill] } });
  const catalog = await client.listSkills();
  assert.equal(catalog.find((item) => item.source?.type === source.type && item.source.uri === source.uri)?.id, cloudSkill.id);
  assert.deepEqual(catalog, [skill, cloudSkill]);
  for (const invalidSource of [
    null, { ...source, type: "other" }, { type: "openwork-cloud" },
    { ...source, uri: "https://fixture.invalid/SKILL.md" },
    { ...source, uri: `skill://${"x".repeat(1024)}` },
    { ...source, path: "/guessed" }, { type: source.type, uri: source.uri },
    { ...source, scope: "A".repeat(64) }, { ...source, scope: "a".repeat(63) },
  ]) {
    state.overrides.set(`GET ${mount}/skill`, { status: 200, body: { data: [{ ...skill, source: invalidSource }] } });
    await assert.rejects(client.listSkills(), { code: "invalid_response" });
  }
  state.overrides.delete(`GET ${mount}/skill`);
  for (const value of [
    { skills: [{ id: "" }] }, { skills: [{ id: " skill_fixture" }] },
    { skills: [{ id: skill.id, name: skill.name }] }, { skills: [{ id: skill.id, text: "Injected" }] },
    { skills: [{ id: skill.id, mention: { start: 0, end: 1, text: "x" } }] },
    { skills: Array.from({ length: 33 }, () => ({ id: skill.id })) },
    { files: [] }, { agents: [] },
  ]) await assert.rejects(client.admitInput(sid, { ...input, ...value }));
  await assert.rejects(client.admitInput(sid, { ...input, type: "synthetic", skills: [{ id: skill.id }] }));
  await assert.rejects(client.admitInput(sid, { ...input, skills: [{ id: skill.name }] }), { code: "skill_unavailable" });
  state.skills = [];
  await assert.rejects(client.admitInput(sid, { ...input, skills: [{ id: skill.id }] }), { code: "skill_unavailable" });
  state.skills = [skill, skill];
  await assert.rejects(client.listSkills(), { code: "invalid_response" });
  state.overrides.set(`GET ${mount}/skill`, { status: 200, body: { data: [{ id: skill.id, name: skill.name }] } });
  await assert.rejects(client.listSkills(), { code: "invalid_response" });
  assert.equal(state.requests.filter((request) => request.method === "POST").length, 0);
});

test("selected skills use the actual session agent; deny and ask preserve native permission without a prompt", async (t) => {
  const { client, state } = await boundary(t);
  const selected = { ...input, skills: [{ id: skill.id }] };
  const path = `${mount}/session/${sid}/permission`;
  for (const effect of ["deny", "ask"]) {
    state.overrides.set(`POST ${path}`, { status: 200, body: { data: { id: "per_fixture", effect } } });
    await assert.rejects(client.admitInput(sid, selected), { code: effect === "ask" ? "skill_permission_required" : "skill_denied" });
  }
  const pending = { id: "per_fixture", sessionID: sid, action: "skill", resources: [skill.id], save: [skill.id] };
  state.overrides.set(`GET ${path}`, { status: 200, body: { data: [pending] } });
  await assert.rejects(client.admitInput(sid, selected), { code: "skill_permission_required" });
  assert.deepEqual(await client.listPermissions(sid), [pending]);
  assert.deepEqual(state.requests.filter((request) => request.method === "POST").map((request) => request.body), [
    { action: "skill", resources: [skill.id], save: [skill.id], agent: "fixture" },
    { action: "skill", resources: [skill.id], save: [skill.id], agent: "fixture" },
  ]);
  assert.equal(postCount(state), 0);
});

test("selected Cloud prompts preserve the caller's pinned scope header instead of rebinding current catalog scope", async (t) => {
  const { state, options } = await boundary(t);
  const pinnedScope = "a".repeat(64);
  const cloudSkill = { ...skill, id: "openwork-cloud-fixture", source: { type: "openwork-cloud", uri: "skill://fixture/SKILL.md", scope: pinnedScope } };
  state.skills = [cloudSkill];
  const scopedFetch: HeadlessFetch = (url, init) => globalThis.fetch(url, {
    ...init,
    headers: { ...init?.headers, ...(new URL(url).pathname.endsWith("/prompt") ? { "x-openwork-native-skills-scope": pinnedScope } : {}) },
  });
  const client = createNativeV2Client({ ...options, fetch: scopedFetch });
  assert.equal((await client.listSkills())[0]?.source?.scope, pinnedScope);
  await client.admitInput(sid, { ...input, skills: [{ id: cloudSkill.id }] });
  const first = state.requests.find((request) => request.path.endsWith("/prompt")); assert.ok(first);
  assert.equal(first.headers["x-openwork-native-skills-scope"], pinnedScope);
  assert.deepEqual(first.body, { id: input.id, text: input.text, delivery: "queue", resume: true, skills: [{ id: cloudSkill.id }] });
  cloudSkill.source.scope = "b".repeat(64);
  state.overrides.set(`POST ${mount}/session/${sid}/prompt`, { status: 403, body: { code: "cloud_skill_scope_changed" } });
  await assert.rejects(client.admitInput(sid, { ...input, id: "msg_scope_changed", skills: [{ id: cloudSkill.id }] }), { status: 403 });
  const prompts = state.requests.filter((request) => request.path.endsWith("/prompt"));
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((request) => request.headers["x-openwork-native-skills-scope"] === pinnedScope));
});

test("lost skill acknowledgement reconciles frozen resolved inbox/history attachments without catalog reads or resend", async (t) => {
  for (const persist of ["inbox", "history"] satisfies BoundaryState["persist"][]) {
    const { client, state, options } = await boundary(t);
    state.persist = persist; state.fail = "lost";
    const selected = { ...input, skills: [{ id: skill.id }, { id: skill.id }] };
    const result = await client.admitInput(sid, selected);
    assert.equal(result.state, persist === "inbox" ? "queued" : "delivered");
    const prompt = state.requests.find((request) => request.path.endsWith("/prompt"));
    assert.ok(prompt);
    assert.equal(prompt.headers["x-openwork-native-skills-scope"], undefined, "local skill inputs do not invent a Cloud scope");
    assert.deepEqual(prompt?.body, { id: input.id, text: input.text, delivery: "queue", resume: true, skills: [{ id: skill.id }] });
    assert.ok(state.requests.findIndex((request) => request.method === "POST" && request.path.endsWith("/permission")) < state.requests.indexOf(prompt));
    const reads = state.requests.filter((request) => request.path.endsWith("/skill")).length;
    state.skills = [];
    const recovered = await createNativeV2Client(options).reconcileInput(sid, selected);
    const payload = recovered.state === "delivered" ? recovered.message : recovered.state === "queued" ? recovered.receipt.payload : null;
    assert.ok(payload && "skills" in payload);
    assert.deepEqual(payload.skills, [{ id: skill.id, name: skill.name, text: skill.content }]);
    await client.admitInput(sid, selected);
    for (const skills of [[], [{ id: "different" }]]) await assert.rejects(client.admitInput(sid, { ...input, skills }), { code: "input_conflict" });
    assert.equal(state.requests.filter((request) => request.path.endsWith("/skill")).length, reads);
    assert.equal(postCount(state), 1);
  }
});

test("cancelling a quiet native event stream closes a pending reader even when transport abort stalls", { timeout: 2000 }, async () => {
  let cancelled = false;
  const client = createNativeV2Client({ baseUrl: "http://fixture.invalid", workspaceId: "ws_fixture", token: "fixture", fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"id":"evt_fixture","type":"server.connected","data":{}}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }) });
  const controller = new AbortController();
  const events = client.events(controller.signal);
  assert.equal((await events.next()).value?.type, "server.connected");
  const pending = events.next();
  controller.abort();
  assert.equal((await pending).done, true);
  assert.equal(cancelled, true);
});
