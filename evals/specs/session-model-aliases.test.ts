import { createServer } from "node:http";
import { afterEach, expect, vi } from "vitest";
import { test } from "@openwork/testkit";
import { openworkCatalogModels } from "@openwork/types/openwork-affordance";
import { OpenWorkExtensionsPreview } from "../../apps/server/src/opencode-plugins/openwork-extensions-preview";
import { listControlSessions, type ListControlSessionsState } from "../../apps/app/src/react-app/domains/session/control/list-control-sessions";

const PROVIDER = "ipr_fixture_01";
const MODEL = "gwm_fixture_01";
const OTHER_PROVIDER = "ipr_fixture_02";
const OTHER_MODEL = "gwm_fixture_02";
const STALE_MODEL = "gwm_fixture_removed";
const NAME = "Fixture Luna";
const SECRET = "synthetic-provider-secret-must-not-escape";
const workspaces = [
  { id: "ws_one", name: "One", path: "/tmp/model-alias-fixture/one" },
  { id: "ws_two", name: "Two", path: "/tmp/model-alias-fixture/two" },
];

function catalog(name = NAME): Parameters<typeof openworkCatalogModels>[0] {
  return {
    connected: [PROVIDER, OTHER_PROVIDER],
    all: [
      { id: PROVIDER, name: "Fixture Managed", models: { [MODEL]: { name }, unnamed: {} } },
      { id: OTHER_PROVIDER, name: "Fixture Alternate", models: { [OTHER_MODEL]: { name: "Fixture Shared" } } },
      { id: "disconnected", name: "Offline", models: { hidden: { name } } },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(record);
}

function resultOf(output: string, id: string) {
  const envelope = record(JSON.parse(output));
  expect(envelope).toMatchObject({ ok: true, id });
  const result = record(envelope.result);
  expect(result.ok).toBe(true);
  return result;
}

type Message = {
  info: { id: string; role: string; time: { created: number }; error?: unknown };
  parts: Array<{ type: string; text: string }>;
};

function message(id: string, role: string, text: string, error?: unknown): Message {
  return { info: { id, role, time: { created: 100 }, ...(error === undefined ? {} : { error }) }, parts: text ? [{ type: "text", text }] : [] };
}

const cleanups: Array<() => Promise<void>> = [];
async function cleanupWitnesses() {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
}
afterEach(cleanupWitnesses);

async function witness() {
  const requests: Array<{ path: string; search: string; method: string; body: unknown }> = [];
  const unexpected: string[] = [];
  const catalogs = new Map(workspaces.map((workspace) => [workspace.id, catalog(workspace.id === "ws_one" ? NAME : "Workspace Two Luna")]));
  const unavailable = new Set<string>();
  const host: { response?: unknown; denied: Set<string> } = { denied: new Set() };
  const transcripts = new Map<string, Message[]>();
  const sessions = new Map<string, Record<string, unknown>>([
    ["ses_bound", { id: "ses_bound", directory: workspaces[0]?.path, title: "Bound fixture", model: { providerID: PROVIDER, id: MODEL, variant: "high" } }],
    ["ses_stale", { id: "ses_stale", directory: workspaces[0]?.path, title: "Stale fixture", model: { providerID: PROVIDER, id: STALE_MODEL, variant: "low" } }],
    ["ses_unbound", { id: "ses_unbound", directory: workspaces[0]?.path, title: "Unbound fixture" }],
  ]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      request.setEncoding("utf8");
      let text = "";
      for await (const chunk of request) text += String(chunk);
      const body: unknown = text ? JSON.parse(text) : null;
      const method = request.method ?? "GET";
      requests.push({ path: url.pathname, search: url.search, method, body });
      if (request.headers.authorization !== "Bearer fixture-token") {
        unexpected.push("unauthorized fixture request");
        return json(401, { message: "Unauthorized" });
      }
      if (method === "GET" && url.pathname === "/workspaces") return json(200, { items: workspaces });
      if (method === "POST" && url.pathname === "/experimental/ui-control/request") {
        const bridge = record(body);
        const input = record(bridge.input);
        if (bridge.kind === "query" && input.id === "models.list") {
          if (host.response !== undefined) return json(200, host.response);
          const args = record(input.args);
          const workspace = workspaces.find((entry) => entry.id === args.workspaceId);
          const value = workspace ? catalogs.get(workspace.id) : undefined;
          if (!workspace || !value) return json(200, { ok: false, id: "models.list", code: "invalid-args", error: "Workspace missing" });
          if (unavailable.has(workspace.id)) return json(200, { ok: false, id: "models.list", code: "unavailable", error: "Fixture catalog unavailable" });
          const models = host.denied.has(workspace.id) ? [] : openworkCatalogModels(value);
          return json(200, { ok: true, id: "models.list", effects: { data: "read", ui: "none", external: false },
            result: { ok: true, workspaceId: workspace.id, models: models.map((model) => ({ ...model, available: true })) } });
        }
        if (bridge.kind === "command" && input.id === "workspace.reload_sessions") return json(200, { ok: true });
      }
      const route = /^\/workspace\/([^/]+)\/opencode(\/.*)$/.exec(url.pathname);
      const workspace = workspaces.find((entry) => entry.id === route?.[1]);
      const path = route?.[2];
      if (workspace && path) {
        if (method === "GET" && path === "/provider") return unavailable.has(workspace.id)
          ? json(503, { message: "Fixture catalog unavailable" }) : json(200, catalogs.get(workspace.id));
        if (method === "POST" && path === "/session") {
          const id = `ses_created_${sessions.size}`;
          const session = { ...record(body), id, directory: workspace.path };
          sessions.set(id, session);
          return json(200, session);
        }
        if (method === "GET" && path === "/session/status") return json(200, {});
        if (method === "GET" && ["/permission", "/question"].includes(path)) return json(200, []);
        const sessionRoute = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
        const sessionId = sessionRoute?.[1];
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (sessionId && session && session.directory === workspace.path) {
          const suffix = sessionRoute?.[2];
          if (method === "GET" && !suffix) return json(200, session);
          if (method === "GET" && suffix === "/children") return json(200, []);
          if (method === "GET" && suffix === "/message") {
            const messages = transcripts.get(sessionId) ?? [];
            const limit = url.searchParams.get("limit");
            return json(200, limit === null ? messages : messages.slice(-Number(limit)));
          }
          if (method === "POST" && suffix === "/prompt_async") return json(200, { ok: true });
        }
      }
      unexpected.push(`${method} ${url.pathname}`);
      return json(404, { message: "Unexpected fixture route" });
    } catch {
      unexpected.push(`invalid fixture request: ${url.pathname}`);
      return json(500, { message: "Invalid fixture request" });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    expect(unexpected).toEqual([]);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to bind");
  vi.stubEnv("OPENWORK_SERVER_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("OPENWORK_SERVER_TOKEN", "fixture-token");
  const plugin = await OpenWorkExtensionsPreview({ directory: workspaces[0]?.path });
  return {
    requests, catalogs, sessions, transcripts, unavailable, host,
    hostQueries: () => requests.filter((request) => isRecord(request.body) && request.body.kind === "query"),
    writes: () => requests.filter((request) => request.method !== "GET" && !(isRecord(request.body) && request.body.kind === "query")),
    query: (id: string, args: Record<string, unknown>) => plugin.tool.openwork_query.execute({ id, args }),
    create: (args: Record<string, unknown>) => plugin.tool.openwork_execute.execute({ id: "session.create", args }, {}),
    read: async (sessionId: string, args: Record<string, unknown> = {}) => resultOf(await plugin.tool.openwork_query.execute({
      id: "session.read", args: { workspaceId: "ws_one", sessionId, ...args },
    }), "session.read"),
  };
}

test("session model aliases preserve workspace scope, canonical bindings, and safe read projections", async ({ evidence }) => {
  const cases: Array<{ name: string; run: () => Promise<void> }> = [];
  const modelCase = (name: string, run: () => Promise<void>) => { cases.push({ name, run }); };

modelCase("models.list returns only connected models from the explicitly requested workspace", async () => {
  const fake = await witness();
  const output = await fake.query("models.list", { workspaceId: "ws_two" });
  const result = resultOf(output, "models.list");
  expect(result).toEqual({ ok: true, workspaceId: "ws_two", models: [
    { providerId: PROVIDER, modelId: MODEL, displayName: "Workspace Two Luna", providerName: "Fixture Managed", available: true },
    { providerId: PROVIDER, modelId: "unnamed", displayName: "unnamed", providerName: "Fixture Managed", available: true },
    { providerId: OTHER_PROVIDER, modelId: OTHER_MODEL, displayName: "Fixture Shared", providerName: "Fixture Alternate", available: true },
  ] });
  expect(record(JSON.parse(output)).effects).toEqual({ data: "read", ui: "none", external: false });
  expect(fake.requests.map((request) => request.path)).toEqual(["/experimental/ui-control/request"]);
  expect(fake.hostQueries().map((request) => request.body)).toEqual([{ kind: "query", input: { id: "models.list", args: { workspaceId: "ws_two" } } }]);
  expect(fake.writes()).toEqual([]);
  const missing = record(JSON.parse(await fake.query("models.list", {})));
  expect(missing).toMatchObject({ ok: false, id: "models.list" });
  expect(record(JSON.parse(await fake.query("models.list", { workspaceId: "ws_missing" })))).toMatchObject({ ok: false, id: "models.list" });
  expect(fake.requests.filter((request) => request.path.endsWith("/provider"))).toHaveLength(0);
  evidence.recordAssertionEvidence("Catalog discovery is workspace-scoped and read-only", "The non-caller workspace returned its three connected models and fallback name; disconnected models, caller catalog reads, writes, and missing-workspace fallback were absent.", fake.writes().length === 0 && records(result.models).length === 3);
});

for (const selector of [{ alias: " fixture luna ", variant: "high" }, { displayName: "FIXTURE LUNA", variant: "low" }]) {
  modelCase(`session.create resolves ${"alias" in selector ? "alias" : "displayName"} to canonical ids on both writes`, async () => {
    const fake = await witness();
    const result = resultOf(await fake.create({ workspaceId: "ws_one", model: selector, sessions: [{ title: "Named model", prompt: "Reply OK" }] }), "session.create");
    const created = records(result.created);
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty("started");
    expect(created[0]).toMatchObject({ accepted: true, model: { providerId: PROVIDER, modelId: MODEL, variant: selector.variant, displayName: NAME, providerName: "Fixture Managed" } });
    expect(result.failures).toEqual([]);
    const writes = fake.writes();
    expect(writes).toEqual([
      { path: "/workspace/ws_one/opencode/session", search: "", method: "POST", body: { title: "Named model", model: { providerID: PROVIDER, id: MODEL, variant: selector.variant } } },
      { path: `/workspace/ws_one/opencode/session/${created[0]?.sessionId}/prompt_async`, search: "", method: "POST", body: { model: { providerID: PROVIDER, modelID: MODEL }, variant: selector.variant, parts: [{ type: "text", text: "Reply OK" }] } },
      { path: "/experimental/ui-control/request", search: "", method: "POST", body: { kind: "command", input: { id: "workspace.reload_sessions", args: { workspaceId: "ws_one" } } } },
    ]);
    expect(JSON.stringify(writes)).not.toContain(NAME);
    expect(fake.requests.some((request) => request.path.includes("/ws_two/"))).toBe(false);
    expect(fake.hostQueries().map((request) => request.body)).toEqual([{ kind: "query", input: { id: "models.list", args: { workspaceId: "ws_one" } } }]);
    expect(fake.requests.some((request) => request.path.endsWith("/provider"))).toBe(false);
    evidence.recordAssertionEvidence("Named model resolution binds creation and first prompt consistently", "Exact HTTP payloads contained opaque canonical ids and requested effort, not picker labels; the result included both human names and no other workspace was touched.", writes.length === 3 && created.length === 1);
  });
}

modelCase("per-session qualified names override a batch default without confusing providers or default effort", async () => {
  const fake = await witness();
  fake.catalogs.set("ws_one", catalog("Fixture Shared"));
  const result = resultOf(await fake.create({ workspaceId: "ws_one", model: { providerId: PROVIDER, modelId: MODEL, variant: "high" }, sessions: [
    { title: "Inherited", prompt: "First" },
    { title: "Override", prompt: "Second", model: { providerId: OTHER_PROVIDER.toUpperCase(), displayName: "fixture shared", variant: "default" } },
  ] }), "session.create");
  const created = records(result.created);
  expect(created.map((entry) => entry.model)).toEqual([
    { providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: "Fixture Shared", providerName: "Fixture Managed" },
    { providerId: OTHER_PROVIDER, modelId: OTHER_MODEL, variant: null, displayName: "Fixture Shared", providerName: "Fixture Alternate" },
  ]);
  expect(fake.writes().filter((request) => request.path.endsWith("/session")).map((request) => request.body)).toEqual(expect.arrayContaining([
    { title: "Inherited", model: { providerID: PROVIDER, id: MODEL, variant: "high" } },
    { title: "Override", model: { providerID: OTHER_PROVIDER, id: OTHER_MODEL } },
  ]));
  expect(fake.writes().filter((request) => request.path.endsWith("/prompt_async"))).toEqual(expect.arrayContaining([
    { path: `/workspace/ws_one/opencode/session/${created[0]?.sessionId}/prompt_async`, method: "POST", search: "", body: { model: { providerID: PROVIDER, modelID: MODEL }, variant: "high", parts: [{ type: "text", text: "First" }] } },
    { path: `/workspace/ws_one/opencode/session/${created[1]?.sessionId}/prompt_async`, method: "POST", search: "", body: { model: { providerID: OTHER_PROVIDER, modelID: OTHER_MODEL }, parts: [{ type: "text", text: "Second" }] } },
  ]));
  expect(fake.writes()).toHaveLength(5);
  evidence.recordAssertionEvidence("Qualified override and inherited batch model stay independent", "Two sessions used different canonical providers and models on both writes; the override did not inherit high effort or send literal default, and returned variant null with alternate provider labels.", created.length === 2 && fake.writes().length === 5);
});

const invalidSelectors = [
  { label: "ambiguous alias", model: { alias: "Fixture Shared" }, error: "Ambiguous model" },
  { label: "ambiguous displayName", model: { displayName: "Fixture Shared" }, error: "Ambiguous model" },
  { label: "missing name", model: { alias: "Missing model" }, error: "Unavailable model" },
  { label: "removed opaque id", model: { providerId: PROVIDER, modelId: STALE_MODEL }, error: "Unavailable model" },
  { label: "disconnected provider", model: { providerId: "disconnected", modelId: "hidden" }, error: "Unavailable model" },
  { label: "selector without model", model: { providerId: PROVIDER }, error: "Provide providerId/modelId" },
  { label: "id without provider", model: { modelId: MODEL }, error: "providerId is required" },
  { label: "mixed selectors", model: { alias: NAME, displayName: NAME }, error: "Use exactly one" },
  { label: "alias with ids", model: { alias: NAME, providerId: PROVIDER, modelId: MODEL }, error: "Use exactly one" },
];
for (const invalid of invalidSelectors) {
  modelCase(`session.create rejects ${invalid.label} before any batch writes`, async () => {
    const fake = await witness();
    fake.catalogs.set("ws_one", catalog("Fixture Shared"));
    const before = [...fake.sessions.entries()];
    const result = record(JSON.parse(await fake.create({ workspaceId: "ws_one", sessions: [
      { title: "Valid first", prompt: "Must not start", model: { providerId: PROVIDER, modelId: MODEL } },
      { title: "Invalid second", prompt: "Must not start either", model: invalid.model },
    ] })));
    expect(result).toMatchObject({ ok: false, id: "session.create", code: "failed" });
    expect(result.error).toContain(invalid.error);
    if (invalid.error.endsWith("model")) expect(result.error).toContain("models.list");
    expect(fake.writes()).toEqual([]);
    expect([...fake.sessions.entries()]).toEqual(before);
    evidence.recordAssertionEvidence(`Reject ${invalid.label} atomically across the batch`, "The public tool returned an actionable failure; the valid first item also produced zero creates, prompts, UI reloads, or session mutations.", result.ok === false && fake.writes().length === 0);
  });
}

modelCase("removed ids are rejected against a fresh catalog after earlier successful discovery", async () => {
  const fake = await witness();
  const listed = resultOf(await fake.query("models.list", { workspaceId: "ws_one" }), "models.list");
  expect(records(listed.models).some((entry) => entry.modelId === MODEL)).toBe(true);
  fake.catalogs.set("ws_one", { connected: [], all: [] });
  const failed = record(JSON.parse(await fake.create({ workspaceId: "ws_one", model: { providerId: PROVIDER, modelId: MODEL }, sessions: [{ title: "Removed", prompt: "Do not start" }] })));
  expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("Unavailable model") });
  expect(fake.hostQueries()).toHaveLength(2);
  expect(fake.requests.some((request) => request.path.endsWith("/provider"))).toBe(false);
  expect(fake.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Discovery is not permanent authorization for a removed model", "A previously listed opaque id was removed before creation; creation reread the catalog and rejected it with zero writes instead of using cached discovery.", failed.ok === false && fake.writes().length === 0);
});

for (const scenario of [
  { label: "missing host", response: { ok: false, id: "models.list", code: "unavailable", error: "No renderer" }, error: "existing renderer host" },
  { label: "malformed envelope", response: { ok: true }, error: "existing renderer host" },
  { label: "wrong affordance", response: { ok: true, id: "other", effects: { data: "read", ui: "none", external: false } }, error: "existing renderer host" },
  { label: "mismatched workspace", response: { ok: true, id: "models.list", effects: { data: "read", ui: "none", external: false }, result: { ok: true, workspaceId: "ws_one", models: [] } }, error: "workspace mismatch" },
  { label: "unavailable projection", response: { ok: true, id: "models.list", effects: { data: "read", ui: "none", external: false }, result: { ok: true, workspaceId: "ws_two", models: [{ providerId: PROVIDER, modelId: MODEL, displayName: NAME, providerName: "Fixture", available: false }] } }, error: "available" },
  { label: "policy denial", error: "Unavailable model" },
]) {
  modelCase(`session.create rejects ${scenario.label} without raw catalog fallback or mutations`, async () => {
    const fake = await witness();
    fake.host.response = "response" in scenario ? scenario.response : undefined;
    fake.host.denied.add("ws_two");
    const before = [...fake.sessions.entries()];
    const failed = record(JSON.parse(await fake.create({ workspaceId: "ws_two", model: { providerId: PROVIDER, modelId: MODEL }, sessions: [{ title: "Blocked", prompt: "Do not start" }] })));
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining(scenario.error) });
    expect(fake.hostQueries().map((request) => request.body)).toEqual([{ kind: "query", input: { id: "models.list", args: { workspaceId: "ws_two" } } }]);
    expect(fake.requests.map((request) => request.path)).toEqual(["/workspaces", "/experimental/ui-control/request"]);
    expect(fake.writes()).toEqual([]);
    expect([...fake.sessions.entries()]).toEqual(before);
    evidence.recordAssertionEvidence(`Fail closed for ${scenario.label}`, "The caller workspace differed from the exact host query workspace; raw connected models were not consulted and no session, prompt or navigation occurred.", failed.ok === false && fake.writes().length === 0);
  });
}

modelCase("decorated read bindings and list projections round-trip by authoritative ids", async () => {
  const fake = await witness();
  const read = await fake.read("ses_bound");
  const listed = resultOf(await fake.query("models.list", { workspaceId: "ws_one" }), "models.list");
  const listing = records(listed.models)[0];
  expect(listing?.available).toBe(true);
  const result = resultOf(await fake.create({ workspaceId: "ws_one", sessions: [
    { title: "Read binding", prompt: "OK", model: { ...record(read.model), displayName: "Stale name", providerName: "Stale provider" } },
    { title: "Listed model", prompt: "OK", model: listing },
  ] }), "session.create");
  expect(records(result.created).map((entry) => entry.model)).toEqual([
    { providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: NAME, providerName: "Fixture Managed" },
    { providerId: PROVIDER, modelId: MODEL, variant: null, displayName: NAME, providerName: "Fixture Managed" },
  ]);
  expect(fake.writes().filter((request) => request.path.endsWith("/session")).map((request) => record(request.body).model)).toEqual([
    { providerID: PROVIDER, id: MODEL, variant: "high" }, { providerID: PROVIDER, id: MODEL },
  ]);
  evidence.recordAssertionEvidence("Decorations never replace binding ids", "Returned bindings and available list projections selected by ids, retained effort and returned canonical labels without an available field in the binding.", records(result.created).length === 2);
});

modelCase("session.read adds current names without rewriting stale ids or inventing unbound models", async () => {
  const fake = await witness();
  const before = JSON.stringify([...fake.sessions.entries()]);
  expect((await fake.read("ses_bound")).model).toEqual({ providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: NAME, providerName: "Fixture Managed" });
  fake.catalogs.set("ws_one", catalog("Renamed Luna"));
  expect((await fake.read("ses_bound", { summary: true })).model).toEqual({ providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: "Renamed Luna", providerName: "Fixture Managed" });
  for (const summary of [false, true]) {
    expect((await fake.read("ses_stale", { summary })).model).toEqual({ providerId: PROVIDER, modelId: STALE_MODEL, variant: "low" });
    expect((await fake.read("ses_unbound", { summary })).model).toBeNull();
  }
  expect(JSON.stringify([...fake.sessions.entries()])).toBe(before);
  expect(fake.writes()).toEqual([]);
  expect(fake.requests.some((request) => request.path.includes("/ws_two/"))).toBe(false);
  evidence.recordAssertionEvidence("Read labels decorate rather than migrate persisted model bindings", "Normal and summary reads returned current labels; removed ids and effort survived verbatim without substitute labels, unbound stayed null, and no model record or other workspace was written.", fake.writes().length === 0 && JSON.stringify([...fake.sessions.entries()]) === before);
});

modelCase("catalog outages preserve readable raw bindings but prevent named creation", async () => {
  const fake = await witness();
  fake.unavailable.add("ws_one");
  expect((await fake.read("ses_bound")).model).toEqual({ providerId: PROVIDER, modelId: MODEL, variant: "high" });
  expect(record(JSON.parse(await fake.query("models.list", { workspaceId: "ws_one" })))).toMatchObject({ ok: false, error: "Fixture catalog unavailable" });
  const failed = record(JSON.parse(await fake.create({ workspaceId: "ws_one", model: { alias: NAME }, sessions: [{ title: "Unavailable", prompt: "Do not start" }] })));
  expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("existing renderer host") });
  expect(fake.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Catalog failure is not an invented model or authorization to create", "Session metadata remained readable with ids and effort only; discovery failed explicitly and named creation failed before all writes.", failed.ok === false && fake.writes().length === 0);
});

const errors = [
  { name: "ProviderAuthError", message: "Provider authentication failed" },
  { name: "ProviderModelNotFoundError", message: "The selected model is unavailable" },
  { name: "MessageOutputLengthError", message: "The model reached its output limit before finishing" },
  { name: "StructuredOutputError", message: "The model could not produce valid structured output" },
  { name: "ContextOverflowError", message: "The conversation is too large for the model context window" },
  { name: "MessageAbortedError", message: "The message was interrupted" },
  { name: "APIError", message: "The provider request failed" },
  { name: `Unknown-${SECRET}`, message: "The assistant reported an error; provider details are omitted" },
];
for (const [index, error] of errors.entries()) {
  modelCase(`session.read sanitizes error-only assistant ${index + 1} and clears it after success`, async () => {
    const fake = await witness();
    const messages = [
      message("msg_user", "user", "Fixture request"),
      message("msg_old", "assistant", "Earlier success"),
      message("msg_error", "assistant", "", { name: error.name, message: SECRET, data: { message: SECRET, responseBody: SECRET, headers: { authorization: SECRET } } }),
    ];
    fake.transcripts.set("ses_bound", messages);
    const expected = { code: index === errors.length - 1 ? "UnknownError" : error.name, message: error.message };
    for (const summary of [false, true]) {
      const read = await fake.read("ses_bound", { summary });
      expect(read.lastError).toEqual(expected);
      expect(JSON.stringify(read)).not.toContain(SECRET);
      if (summary) expect(read.lastAssistant).toMatchObject({ id: "msg_old", text: "Earlier success" });
      else expect(records(read.messages).map((entry) => entry.id)).toEqual(["msg_user", "msg_old"]);
    }
    messages.push(message("msg_success", "assistant", "Recovered"));
    for (const summary of [false, true]) {
      const recovered = await fake.read("ses_bound", { summary });
      expect(recovered.lastError).toBeNull();
      expect(JSON.stringify(recovered)).not.toContain(SECRET);
    }
    expect(fake.writes()).toEqual([]);
    evidence.recordAssertionEvidence("Latest assistant error is allowlisted and never sticky after success", "An error-only latest assistant surfaced a safe code/message despite an older readable success; raw provider detail and unknown names never escaped in either read mode, and later success cleared lastError without writes.", fake.writes().length === 0);
  });
}

modelCase("lastError reflects the loaded transcript window, not a fabricated full-history assertion", async () => {
  const fake = await witness();
  fake.transcripts.set("ses_bound", [
    message("msg_first", "user", "Start"),
    message("msg_error", "assistant", "", { name: "APIError", data: { message: SECRET } }),
    message("msg_latest", "user", "Retry"),
  ]);
  expect((await fake.read("ses_bound", { count: 1 })).lastError).toBeNull();
  expect((await fake.read("ses_bound", { count: 2 })).lastError).toEqual({ code: "APIError", message: "The provider request failed" });
  const head = await fake.read("ses_bound", { from: "start", count: 1 });
  expect(head.lastError).toEqual({ code: "APIError", message: "The provider request failed" });
  expect(records(head.messages).map((entry) => entry.id)).toEqual(["msg_first"]);
  expect(fake.requests.filter((request) => request.path.endsWith("/message")).map((request) => request.search)).toEqual(["?limit=1", "?limit=2", ""]);
  expect(JSON.stringify(head)).not.toContain(SECRET);
  expect(fake.writes()).toEqual([]);
  evidence.recordAssertionEvidence("Windowed reads do not claim errors outside loaded history", "A one-message tail omitted the earlier error, a two-message tail exposed it, and a from-start read inspected full history despite returning only the first readable message; no raw detail or writes escaped.", fake.writes().length === 0);
});

modelCase("renderer session inventory uses each workspace catalog without changing raw bindings", async () => {
  const state: ListControlSessionsState = {
    workspaces,
    sessionsByWorkspaceId: {
      ws_one: [
        { id: "ses_one", model: { providerID: PROVIDER, id: MODEL, variant: "high" } },
        { id: "ses_stale", model: { providerID: PROVIDER, id: STALE_MODEL, variant: "low" } },
        { id: "ses_unbound" },
      ],
      ws_two: [{ id: "ses_two", model: { providerID: PROVIDER, id: MODEL, variant: "default" } }],
    },
    modelCatalogByWorkspaceId: { ws_one: openworkCatalogModels(catalog()), ws_two: openworkCatalogModels(catalog("Workspace Two Luna")) },
    pinnedIds: [],
    statusFor: () => "idle",
  };
  const before = JSON.stringify(state.sessionsByWorkspaceId);
  const listed = listControlSessions({}, state);
  expect(listed.map((entry) => ({ id: entry.sessionId, model: entry.model }))).toEqual([
    { id: "ses_one", model: { providerId: PROVIDER, modelId: MODEL, variant: "high", displayName: NAME, providerName: "Fixture Managed" } },
    { id: "ses_stale", model: { providerId: PROVIDER, modelId: STALE_MODEL, variant: "low" } },
    { id: "ses_unbound", model: null },
    { id: "ses_two", model: { providerId: PROVIDER, modelId: MODEL, variant: null, displayName: "Workspace Two Luna", providerName: "Fixture Managed" } },
  ]);
  expect(listControlSessions({ workspaceId: "ws_two" }, state)).toEqual([listed[3]]);
  expect(listControlSessions({}, { ...state, modelCatalogByWorkspaceId: {} }).map((entry) => entry.model)).toEqual([
    { providerId: PROVIDER, modelId: MODEL, variant: "high" },
    { providerId: PROVIDER, modelId: STALE_MODEL, variant: "low" },
    null,
    { providerId: PROVIDER, modelId: MODEL, variant: null },
  ]);
  expect(JSON.stringify(state.sessionsByWorkspaceId)).toBe(before);
  evidence.recordAssertionEvidence("Renderer inventory labels are scoped decorations, not model migration", "Identical opaque ids received different workspace labels; scoping excluded other sessions, missing catalogs preserved ids, stale bindings stayed stale, and input records did not mutate.", listed.length === 4 && JSON.stringify(state.sessionsByWorkspaceId) === before);
});

  expect(cases).toHaveLength(33);
  for (const { name, run } of cases) {
    try {
      await run();
    } catch (error) {
      throw new Error(`Case failed: ${name}`, { cause: error });
    } finally {
      await cleanupWitnesses();
    }
  }
});
