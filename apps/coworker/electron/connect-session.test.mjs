import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { transformSync } from "esbuild";

const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const account = (id) => ({ baseUrl: "https://example.invalid", token: `synthetic-${id}`, orgId: id });
function host() {
  const state = { gateway: null, writes: [], removeFailure: false, registration: null, startup: null };
  const handle = { url: "http://127.0.0.1:1" };
  const context = vm.createContext({
    denSession: null, denAccountReady: false, denAccountGeneration: 0,
    denAccountHandoff: Promise.resolve(), denSessionHandoff: Promise.resolve(),
    appliedSkillSession: null, storedSkillSession: null, serverHandle: handle,
    ownerToken: "synthetic-owner", AbortSignal, voice: { reset() {} },
    parseDenSessionPayload: (value) => value,
    ensurePlatformServer: async () => { if (state.startup) await state.startup; return handle; },
    loadOrCreateTokens: async () => ({ hostToken: "synthetic-host" }),
    fetch: async (_url, init) => {
      state.writes.push(init.method);
      if (init.method === "DELETE") {
        if (state.removeFailure) return { ok: false, status: 503 };
        state.gateway = null;
      }
      return { ok: true };
    },
    fetchJson: async (url, init) => {
      if (url.endsWith("/reconcile")) {
        state.writes.push("register");
        if (state.registration) await state.registration;
        state.gateway = JSON.parse(init.body).credential;
        return { usable: true };
      }
      return { status: "applied" };
    },
  });
  vm.runInContext(main.slice(main.indexOf("function queueDenSessionHandoff("), main.indexOf("function parseDenSessionPayload(")), context);
  const start = main.indexOf('  "den.session.set":');
  const end = main.indexOf('  "voice.status":', start);
  vm.runInContext(`globalThis.handlers = {${main.slice(start, end)}}`, context);
  return { state, context, handlers: context.handlers };
}
async function tick() { await new Promise((resolve) => setImmediate(resolve)); }

test("main serializes delayed Connect registration before signout and rejects stale queued work", async () => {
  const { state, context, handlers } = host();
  const first = await handlers["den.session.set"](account("first"));
  assert.ok(context.appliedSkillSession);
  const release = Promise.withResolvers();
  state.registration = release.promise;
  const input = { accountGeneration: first.accountGeneration, workspaceId: "team", config: { credential: "first" } };
  const registering = assert.rejects(handlers["den.connect.reconcile"](input), /account changed/);
  await tick();
  const queued = assert.rejects(handlers["den.connect.reconcile"](input), /account changed/);
  let signedOut = false;
  const clearing = handlers["den.session.clear"]().then(() => { signedOut = true; });
  assert.equal(context.appliedSkillSession, null, "skill admission closes synchronously");
  await tick();
  assert.equal(signedOut, false);
  release.resolve();
  await Promise.all([registering, queued, clearing]);
  assert.equal(state.gateway, null);
  assert.deepEqual(state.writes, ["DELETE", "PUT", "register", "DELETE"]);
  await assert.rejects(handlers["den.connect.reconcile"](input), /account changed/);
});

test("main account switch isolates late credentials and same-account retries by generation", async () => {
  const { state, handlers } = host();
  const first = await handlers["den.session.set"](account("first"));
  const release = Promise.withResolvers();
  state.registration = release.promise;
  const old = { accountGeneration: first.accountGeneration, workspaceId: "team", config: { credential: "first" } };
  const registering = assert.rejects(handlers["den.connect.reconcile"](old), /account changed/);
  await tick();
  const switching = handlers["den.session.set"](account("second"));
  release.resolve();
  await registering;
  const second = await switching;
  assert.equal(state.gateway, null, "old gateway removed before the replacement session is ready");
  await handlers["den.connect.reconcile"]({ ...old, accountGeneration: second.accountGeneration, config: { credential: "second" } });
  await assert.rejects(handlers["den.connect.reconcile"](old), /account changed/);
  assert.equal(state.gateway, "second");
  const reminted = await handlers["den.session.set"](account("second"));
  assert.notEqual(reminted.accountGeneration, second.accountGeneration);
  await assert.rejects(handlers["den.connect.reconcile"]({ ...old, accountGeneration: second.accountGeneration }), /account changed/);
});

test("main rejects cleanup failure, blocks reconnect, and confirms only a successful retry", async () => {
  const { state, context, handlers } = host();
  const first = await handlers["den.session.set"](account("first"));
  const input = { accountGeneration: first.accountGeneration, workspaceId: "team", config: { credential: "first" } };
  await handlers["den.connect.reconcile"](input);
  state.removeFailure = true;
  await assert.rejects(handlers["den.session.clear"](), /Clearing.*503/);
  assert.equal(state.gateway, "first");
  assert.equal(context.appliedSkillSession, null);
  await assert.rejects(handlers["den.connect.reconcile"](input), /account changed/);
  await assert.rejects(handlers["den.session.set"](account("second")), /Clearing.*503/);
  state.removeFailure = false;
  assert.equal((await handlers["den.session.clear"]()).ok, true);
  assert.equal(state.gateway, null);
});

test("main signout fences a session handoff delayed by server startup", async () => {
  const { state, context, handlers } = host();
  const release = Promise.withResolvers();
  state.startup = release.promise;
  const setting = assert.rejects(handlers["den.session.set"](account("first")), /account changed/);
  await tick();
  const clearing = handlers["den.session.clear"]();
  release.resolve();
  await Promise.all([setting, clearing]);
  assert.equal(context.denSession, null);
  assert.equal(state.writes.includes("PUT"), false);
});

function rendererCallback(name, marker, context) {
  const start = app.indexOf(`  const ${name} = useCallback(`);
  const end = app.indexOf(marker, start);
  assert.ok(start >= 0 && end > start);
  const js = transformSync(`${app.slice(start, end)}\nglobalThis.result = ${name};`, { loader: "tsx", target: "node24" }).code;
  return vm.runInNewContext(js, { ...context, useCallback: (fn) => fn });
}
function renderer() {
  const current = account("first");
  const state = { persisted: current, updates: 0, retries: 0, registrations: 0 };
  const context = {
    session: current, sessionRef: { current }, sessionKey: (value) => value.orgId,
    runtime: { engineManaged: true, teamWorkspaceId: "team", version: "fixture" },
    coworkers: [{ slug: "fixture", workspaceId: "team" }],
    accountEpochRef: { current: 0 }, accountTransitionRef: { current: false },
    connectGenerationRef: { current: { key: "first", generation: 1 } },
    connectTokenRef: { current: null }, connectedWorkspacesRef: { current: new Set() }, connectRetryRef: { current: {} },
    pushedSessionKeyRef: { current: "first" }, onboardingDraftRef: { current: {} },
    setConnectBySlug: () => { state.updates++; }, clearAccountPresentation() {}, updateOnboardingDraft() {},
    onboardingDraftForContext: (value) => value, writeDenSession: (value) => { state.persisted = value; },
    setSession() {}, refreshRuntime: async () => {},
    coworkerBridge: { den: { clearSession: async () => {}, reconcileConnect: async () => { state.registrations++; return {}; } } },
    window: { clearTimeout() {}, setTimeout() { state.retries++; return 1; } },
    connectReconcilePayload: () => ({}), parseConnectHealth: (value) => value, connectStateFromHealth: () => ({ status: "connected" }),
  };
  return { state, context };
}

test("renderer retains the account on signout failure and clears persistence only after retry", async () => {
  const { state, context } = renderer();
  context.coworkerBridge.den.clearSession = async () => { throw new Error("fixture cleanup failure"); };
  const signOut = rendererCallback("signOut", "  const syncProviders", context);
  await assert.rejects(signOut(), /cleanup failure/);
  assert.equal(state.persisted.orgId, "first");
  assert.equal(context.sessionRef.current.orgId, "first");
  assert.equal(context.connectGenerationRef.current, null);
  context.coworkerBridge.den.clearSession = async () => {};
  await signOut();
  assert.equal(state.persisted, null);
  assert.equal(context.sessionRef.current, null);
});

test("renderer ignores a token minted after signout and schedules no stale retry", async () => {
  const { state, context } = renderer();
  const release = Promise.withResolvers();
  context.createDenAutomationsClient = () => ({ mintMcpToken: () => release.promise });
  const sync = rendererCallback("syncConnect", "  useEffect(() => {", context);
  const pending = sync();
  await rendererCallback("signOut", "  const syncProviders", context)();
  release.resolve({ expiresAt: "2099-01-01T00:00:00Z" });
  await pending;
  assert.equal(state.registrations, 0);
  assert.equal(state.retries, 0);
  assert.equal(context.connectTokenRef.current, null);
});

test("renderer ignores a delayed registration result after signout without restoring state or retrying", async () => {
  const { state, context } = renderer();
  const release = Promise.withResolvers();
  context.connectTokenRef.current = { sessionKey: "first", token: { expiresAt: "2099-01-01T00:00:00Z" } };
  context.coworkerBridge.den.reconcileConnect = () => release.promise;
  context.connectStateFromHealth = () => ({ status: "unavailable", message: "fixture late failure" });
  const pending = rendererCallback("syncConnect", "  useEffect(() => {", context)();
  await rendererCallback("signOut", "  const syncProviders", context)();
  const updates = state.updates;
  release.resolve({});
  await pending;
  assert.equal(state.updates, updates);
  assert.equal(state.retries, 0);
  assert.equal(context.connectedWorkspacesRef.current.size, 0);
});
