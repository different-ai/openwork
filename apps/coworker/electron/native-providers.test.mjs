import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeProviders, customProviderKeyName } from "./native-providers.mjs";

const credential = (id) => ({ type: "credential", id, label: "Fixture connection" });
const oauth = (id) => ({ id, type: "oauth", label: id });

function fixture(overrides = {}) {
  const state = {
    providers: [{ id: "fixture-provider", name: "Fixture", activation: "auto", integrationID: "fixture/integration", settings: { apiKey: "fixture-value-not-real" } }],
    models: [{ providerID: "fixture-provider", id: "enabled-model", enabled: true }, { providerID: "fixture-provider", id: "disabled-model", enabled: false }],
    connectedProviderIds: [],
    integrations: [{ id: "fixture/integration", name: "Fixture integration", methods: [{ type: "key" }, oauth("browser"), oauth("device")], connections: [] }],
    authorization: { attemptID: "con_fixture/attempt", mode: "auto", url: "https://signin.example.test", instructions: "Enter code: ABCD-1234", time: { created: Date.now(), expires: Date.now() + 60_000 } },
    status: "pending",
    calls: [],
  };
  const engineRequest = async (method, route, body) => {
    state.calls.push([method, route, body]);
    if (method === "GET" && route === "/api/integration") return { data: structuredClone(state.integrations) };
    if (method === "POST" && route.endsWith("/connect/key")) {
      state.integrations[0].connections.push(credential("crd_fixture-key"));
      state.connectedProviderIds = ["fixture-provider"];
      return null;
    }
    if (method === "POST" && route.endsWith("/connect/oauth")) return { data: structuredClone(state.authorization) };
    if (method === "POST" && route.endsWith("/complete")) { state.status = "complete"; return null; }
    if (method === "GET" && route.includes("/connect/oauth/")) return { data: { status: state.status, message: "fixture-private-error-not-real" } };
    if (method === "DELETE" && route.startsWith("/api/credential/")) {
      const id = decodeURIComponent(route.slice("/api/credential/".length));
      for (const integration of state.integrations) integration.connections = integration.connections.filter((item) => item.id !== id);
      state.connectedProviderIds = [];
      return null;
    }
    if (method === "DELETE" && route.includes("/connect/oauth/")) return null;
    assert.fail(`Unexpected fixture request: ${method} ${route}`);
  };
  const api = createNativeProviders({
    engineRequest,
    readCatalog: async () => structuredClone({ providers: state.providers, models: state.models, connectedProviderIds: state.connectedProviderIds }),
    ...overrides,
  });
  return { api, state };
}

test("native summaries preserve headless connection evidence and never expose provider settings", async () => {
  const { api, state } = fixture();
  state.integrations[0].connections = [credential("crd_fixture")];
  assert.deepEqual(await api.readConnectedProviders(), [], "integration presence alone must not widen the headless connected set");
  const disconnected = (await api.readEngineProviders())[0];
  assert.equal(disconnected.modelCount, 0);
  assert.equal(disconnected.acceptsKey, true);
  state.connectedProviderIds = ["fixture-provider"];
  const connected = (await api.readConnectedProviders())[0];
  assert.equal(connected.modelCount, 1, "disabled models are not available");
  assert.equal(connected.integrationID, "fixture/integration");
  assert.equal(connected.source, "credential");
  state.integrations[0].connections.push({ type: "env", name: "FIXTURE_KEY" });
  assert.equal((await api.readConnectedProviders())[0].source, "credential", "native credential precedence is not replaced by an env fallback");
  assert.ok(!JSON.stringify(connected).includes("fixture-value-not-real"));
  await assert.rejects(api.waitForProvider("fixture-provider", false, { timeoutMs: 0 }), /still available/);
  await assert.rejects(fixture({ readCatalog: async () => { throw new Error("fixture-private-error-not-real"); } }).api.readConnectedProviders(), /catalog could not be read/);
});

test("native integration discovery offers cold setup without active providers or invented connections", async () => {
  const { api, state } = fixture();
  state.providers = [];
  state.models = [];
  state.integrations = [{ id: "openai", name: "OpenAI", methods: [
    { type: "key" }, { type: "env", names: ["OPENAI_API_KEY"] }, oauth("chatgpt-browser"), oauth("chatgpt-headless"),
  ], connections: [] }];
  assert.deepEqual(await api.readEngineProviders(), [{
    id: "openai", name: "OpenAI", integrationID: "openai", env: ["OPENAI_API_KEY"],
    source: "", acceptsKey: true, connected: false, modelCount: 0,
  }]);
  const choices = (await api.readEngineSignIns()).openai;
  assert.deepEqual(choices.map(({ integrationID, methodID }) => ({ integrationID, methodID })), [
    { integrationID: "openai", methodID: "chatgpt-browser" }, { integrationID: "openai", methodID: "chatgpt-headless" },
  ]);
  assert.deepEqual(await api.readConnectedProviders(), []);
  state.providers = [{ id: "openai", name: "OpenAI", activation: "auto", integrationID: "openai" }];
  assert.equal((await api.readEngineProviders()).length, 1);
  assert.deepEqual((await api.readEngineSignIns()).openai, choices);
  state.providers[0].id = "configured-openai";
  assert.deepEqual((await api.readEngineProviders()).map((provider) => provider.id), ["configured-openai"]);
  assert.deepEqual(Object.keys(await api.readEngineSignIns()), ["configured-openai"]);
  assert.deepEqual(await api.readConnectedProviders(), []);
  assert.ok(state.calls.every(([method]) => method === "GET"));
});

test("numeric choices remain pinned to exact native integration/method IDs through reorder and removal", async () => {
  const { api, state } = fixture();
  const choices = (await api.readEngineSignIns())["fixture-provider"];
  const device = choices.find((item) => item.methodID === "device");
  state.integrations[0].methods = [oauth("device"), oauth("new-method"), oauth("browser")];
  const refreshed = (await api.readEngineSignIns())["fixture-provider"];
  assert.equal(refreshed.find((item) => item.methodID === "device").index, device.index);
  const start = await api.startSignIn("fixture-provider", device.index);
  assert.equal(start.attemptId, state.authorization.attemptID);
  assert.equal(start.code, "ABCD-1234");
  assert.deepEqual(state.calls.find(([method]) => method === "POST"), ["POST", "/api/integration/fixture%2Fintegration/connect/oauth", { methodID: "device", answer: {} }]);
  assert.ok(!state.calls.some(([, route]) => route.endsWith("/complete")), "auto flow is polled, never completed a second time");
  state.integrations[0].methods = [oauth("browser")];
  const writes = state.calls.filter(([method]) => method !== "GET").length;
  await assert.rejects(api.startSignIn("fixture-provider", device.index), /no longer offered/);
  state.integrations[0].id = "replacement-integration";
  state.providers[0].integrationID = "replacement-integration";
  await assert.rejects(api.startSignIn("fixture-provider", choices[0].index), /no longer offered/);
  assert.equal(state.calls.filter(([method]) => method !== "GET").length, writes);
});

test("keys use native connect/key, reject v1 auth objects, and redact transport failures", async () => {
  const { api, state } = fixture();
  assert.equal(await api.storeCredential("fixture-provider", " fixture-key-not-real "), 1);
  assert.deepEqual(state.calls.find(([method]) => method === "POST"), ["POST", "/api/integration/fixture%2Fintegration/connect/key", { key: "fixture-key-not-real", answer: {} }]);
  await assert.rejects(api.storeCredential("fixture-provider", { type: "oauth", refresh: "fixture-not-real" }), /Paste the key/);
  state.integrations[0].methods = [];
  await assert.rejects(api.storeCredential("fixture-provider", "fixture-key-not-real"), /does not accept a key/);
  const failing = fixture({ engineRequest: async () => { throw new Error("fixture-value-not-real"); } });
  await assert.rejects(failing.api.readEngineSignIns(), (error) => !error.message.includes("fixture-value-not-real"));
});

test("sign-in status requires native completion plus the current catalog; failed status never echoes provider messages", async () => {
  const { api, state } = fixture();
  const start = await api.startSignIn("fixture-provider");
  assert.deepEqual(await api.status(start.attemptId), { state: "waiting", error: "", modelCount: 0 });
  state.status = "complete";
  assert.equal((await api.status(start.attemptId)).state, "failed");
  state.connectedProviderIds = ["fixture-provider"];
  state.integrations[0].connections = [credential("crd_fixture")];
  assert.deepEqual(await api.status(start.attemptId), { state: "connected", error: "", modelCount: 1 });
  state.providers[0].integrationID = "another-integration";
  assert.equal((await api.status(start.attemptId)).state, "failed", "a replacement integration cannot complete the old provider sign-in");
  state.providers[0].integrationID = "fixture/integration";
  state.status = "failed";
  assert.deepEqual(await api.status(start.attemptId), { state: "failed", error: "The sign-in did not finish. Try again.", modelCount: 0 });
  state.status = "expired";
  assert.match((await api.status(start.attemptId)).error, /expired/);
  await api.cancel(start.attemptId);
  assert.equal((await api.status(start.attemptId)).state, "failed");
  assert.deepEqual(state.calls.find(([method, route]) => method === "DELETE" && route.includes("/oauth/")), ["DELETE", "/api/integration/fixture%2Fintegration/connect/oauth/con_fixture%2Fattempt", undefined]);
});

test("code mode fails honestly for the current renderer; a code-capable caller can complete the exact attempt", async () => {
  const { api, state } = fixture();
  state.authorization.mode = "code";
  await assert.rejects(api.startSignIn("fixture-provider"), /returned authorization code/);
  assert.ok(state.calls.some(([method]) => method === "DELETE"));
  const start = await api.startSignIn("fixture-provider", undefined, { supportsCode: true });
  assert.equal(start.code, "", "authorization-code input is not a device display code");
  state.connectedProviderIds = ["fixture-provider"];
  state.integrations[0].connections = [credential("crd_fixture")];
  assert.equal((await api.completeSignIn(start.attemptId, "fixture-code-not-real")).state, "connected");
  assert.deepEqual(state.calls.find(([, route]) => route.endsWith("/complete")), ["POST", "/api/integration/fixture%2Fintegration/connect/oauth/con_fixture%2Fattempt/complete", { code: "fixture-code-not-real" }]);
});

test("native forms use declared answers and the supported public Copilot default, not v1 inputs", async () => {
  const { api, state } = fixture();
  state.providers[0].integrationID = "github-copilot";
  state.integrations[0].id = "github-copilot";
  state.integrations[0].methods = [{ ...oauth("device"), form: [
    { key: "deploymentType", type: "string", required: true, options: [{ value: "github.com", label: "Public" }, { value: "enterprise", label: "Enterprise" }] },
    { key: "enterpriseUrl", type: "string", required: true, when: [{ key: "deploymentType", op: "eq", value: "enterprise" }] },
  ] }];
  await api.startSignIn("fixture-provider");
  assert.deepEqual(state.calls.find(([method]) => method === "POST")[2], { methodID: "device", answer: { deploymentType: "github.com" } });
  await assert.rejects(api.startSignIn("fixture-provider", undefined, { answer: { deploymentType: "enterprise" } }), /additional details/);
  assert.equal(state.calls.filter(([method]) => method === "POST").length, 1);
});

test("uncertain cancellation retains the native attempt and a late status cannot resurrect a cancelled one", async () => {
  let release;
  let cancelFails = true;
  const { api, state } = fixture({ engineRequest: async (method, route) => {
    if (route === "/api/integration") return { data: state.integrations };
    if (method === "POST") return { data: state.authorization };
    if (method === "GET") return new Promise((resolve) => { release = resolve; });
    if (cancelFails) throw new Error("fixture-private-error-not-real");
    return null;
  } });
  const start = await api.startSignIn("fixture-provider");
  await assert.rejects(api.cancel(start.attemptId), /Cancellation could not be confirmed/);
  const pending = api.status(start.attemptId);
  assert.equal(typeof release, "function", "an uncertain cancellation did not discard the attempt");
  cancelFails = false;
  await api.cancel(start.attemptId);
  release({ data: { status: "complete" } });
  assert.deepEqual(await pending, { state: "failed", error: "This sign-in is no longer running.", modelCount: 0 });
});

test("disconnect confirms the exact credential set and deletes credential IDs, never provider IDs", async () => {
  const { api, state } = fixture();
  state.connectedProviderIds = ["fixture-provider"];
  state.integrations[0].connections = [credential("crd_fixture/one"), credential("crd_fixture-two")];
  state.integrations.push({ id: "unrelated", name: "Other", methods: [], connections: [credential("crd_unrelated")] });
  assert.equal((await api.disconnect("fixture-provider")).needsConfirmation, true);
  assert.equal(state.calls.filter(([method]) => method === "DELETE").length, 0);
  state.integrations[0].connections.push(credential("crd_new"));
  assert.equal((await api.disconnect("fixture-provider", true)).needsConfirmation, true, "changed accounts require fresh confirmation");
  assert.equal((await api.disconnect("fixture-provider", true)).removed, true);
  assert.deepEqual(state.calls.filter(([method]) => method === "DELETE").map(([, route]) => route).sort(), ["/api/credential/crd_fixture%2Fone", "/api/credential/crd_fixture-two", "/api/credential/crd_new"].sort());
  assert.deepEqual(state.integrations[1].connections, [credential("crd_unrelated")]);
  state.integrations[0].connections = [{ type: "env", name: "FIXTURE_KEY" }, credential("crd_preserve")];
  assert.equal((await api.disconnect("fixture-provider", true)).removed, false);
  assert.equal(state.integrations[0].connections.length, 2);
});

test("custom keys go to the injected host store while config carries only an opaque env name", async () => {
  const stored = [];
  const patches = [];
  let runtimeIds = [];
  let failRemoval = true;
  const { api, state } = fixture({
    listModels: async () => ({ address: "https://models.example.test/v1", models: ["fixture-model"] }),
    storeCustomKey: async (name, key) => { stored.push([name, key]); },
    removeCustomKey: async (name) => {
      if (failRemoval) throw new Error("fixture-private-error-not-real");
      stored.push([name, null]);
    },
    readRuntimeProviderIds: async () => runtimeIds,
    patchRuntimeProviders: async (patch) => {
      patches.push(patch);
      runtimeIds = Object.entries(patch).filter(([, config]) => config !== null).map(([id]) => id);
      state.connectedProviderIds = runtimeIds;
      state.providers = runtimeIds.map((id) => ({ id, name: "Fixture server", activation: "enabled" }));
      state.models = runtimeIds.map((providerID) => ({ providerID, id: "fixture-model", enabled: true }));
    },
  });
  const result = await api.addCustomProvider({ name: "Fixture server", address: "https://models.example.test/v1", key: "fixture-key-not-real" });
  const name = customProviderKeyName(result.providerId);
  assert.deepEqual(stored, [[name, "fixture-key-not-real"]]);
  assert.deepEqual(patches[0][result.providerId].env, [name]);
  assert.ok(!JSON.stringify(patches).includes("fixture-key-not-real"));
  assert.ok(!JSON.stringify(result).includes("fixture-key-not-real"));
  assert.ok(!state.calls.some(([method]) => method !== "GET"), "custom credentials never use native or v1 auth endpoints");
  await assert.rejects(api.disconnect(result.providerId), /saved key could not be removed/);
  failRemoval = false;
  assert.equal((await api.disconnect(result.providerId)).removed, true, "cleanup can be retried after the runtime row was already removed");
  assert.deepEqual(stored.at(-1), [name, null]);
});

test("detected external credentials return a direct sign-in fallback without importing or writing", async () => {
  const finding = { id: "fixture-external", kind: "codex", how: "unavailable", providerId: "fixture-provider", label: "External sign-in", reason: "Credentials cannot be imported here. Sign in directly." };
  const { api, state } = fixture({ detect: async () => ({ found: [finding] }) });
  assert.deepEqual(await api.connectLocalProvider(finding.id), { status: "failed", providerId: finding.providerId, label: finding.label, error: finding.reason, fallback: "sign-in" });
  assert.ok(state.calls.every(([method]) => method === "GET"));
});
