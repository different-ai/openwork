import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
import type { CoworkerSummary, RuntimeInfo } from "./bridge.ts";
import { configureCoworkerSessionAccess } from "./session-routing.ts";
import { DEFAULT_MODEL_DEFAULTS } from "./model-defaults.ts";
import { resolveDiscussionModel } from "./model-choice.ts";
import {
  coalesceCalls,
  createCoworkerThreads,
  connectedModelCatalog,
  createWorkspaceReadiness,
  createWorkspaceReadinessCache,
  workspacePreparationScope,
  runtimeWorkspaceReadinessKey,
  projectWorkspaceReadiness,
  prepareCurrentWorkspace,
  WORKSPACE_STARTUP_TIMEOUT_MS,
  hasPendingInteractions,
  type CoworkerActivity,
  parseModelPreference,
  recommendModel,
  stalledRetry,
  threadStatusOf,
} from "./threads.ts";
import { fixtureCatalog, fixtureModel, fixtureProvider } from "./provider-catalog.fixture.ts";
import { MODEL_INTELLIGENCE_INDEX, normalizeModelIntelligence } from "./model-intelligence.ts";

test("renderer clients wait for the native server independently of the page origin", async (t) => {
  configureCoworkerSessionAccess({ workspace: () => "ws_team", list: async () => [], binding: async () => { throw new Error("No fixture binding"); }, create: async () => { throw new Error("No fixture writes"); } });
  t.after(() => configureCoworkerSessionAccess(undefined));
  t.mock.method(globalThis, "fetch", () => { throw new Error("Client construction must not send requests"); });
  for (const file of ["threads", "openwork-settings", "model-picker"]) {
    const source = await readFile(new URL(`../ui/${file}.tsx`, import.meta.url), "utf8");
    const start = source.indexOf("  const threads = useMemo(");
    const end = source.indexOf("\n  );", start);
    assert.ok(start > 0 && end > start);
    const script = await transform(`(() => { ${source.slice(start, end + 5)}\nreturn threads; })()`, { loader: "tsx", target: "es2022" });
    const coworker = { workspaceId: "ws_fixture", slug: "fixture", createdAt: "original", model: "", modelVariant: "" };
    for (const href of ["file:///Applications/Fixture.app/Contents/Resources/dist/index.html", "opencoworker://app/index.html", "http://localhost:5173/"]) {
      let dependencies: unknown[] = [];
      let calls = 0;
      const runtime = { serverUrl: "", ownerToken: "fixture", engineManaged: false };
      const context = { runtime, coworker, catalogCoworker: coworker, sharedCatalog: undefined, discussionThreadId: "", discussionThreadIds: [], workerThreadIds: [], window: { location: new URL(href) }, useMemo: (factory: () => unknown, deps: unknown[]) => { dependencies = deps; return factory(); }, createCoworkerThreads: (options: Parameters<typeof createCoworkerThreads>[0]) => { calls++; return createCoworkerThreads(options); } };
      for (const base of ["", "null", "/relative", new URL(href).origin]) {
        runtime.serverUrl = base;
        assert.equal(runInNewContext(script.code, context), null);
      }
      assert.equal(calls, 0);
      runtime.serverUrl = "http://127.0.0.1:8790";
      assert.equal(runInNewContext(script.code, context), null);
      const unavailableDependencies = dependencies;
      runtime.engineManaged = true;
      assert.ok(runInNewContext(script.code, context));
      assert.notDeepEqual(dependencies, unavailableDependencies, "native readiness must invalidate the client memo even with an unchanged URL");
      assert.equal(calls, 1);
      for (const base of ["", "null", "/relative", "file:///fixture", "opencoworker://app", "http://user:secret@localhost", "http://localhost/?token=fixture"]) {
        runtime.serverUrl = base;
        assert.throws(() => runInNewContext(script.code, context));
      }
    }
  }
});

test("startup readiness is bounded, cancellation-safe and cannot publish a stale ready result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const mode of ["timeout", "cancel", "unavailable"]) {
    let resolve = () => {};
    let reject = (_cause: Error) => {};
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const deferred = { promise, resolve, reject };
    let calls = 0;
    const ready = createWorkspaceReadiness(async () => { if (++calls === 1) await deferred.promise; });
    const release = ready.retain();
    release();
    const retained = ready.retain();
    const first = ready.wait();
    const second = ready.wait();
    const outcomes = Promise.allSettled([first, second]);
    await Promise.resolve();
    assert.equal(calls, 1);
    if (mode === "timeout") t.mock.timers.tick(WORKSPACE_STARTUP_TIMEOUT_MS);
    else if (mode === "cancel") ready.dispose();
    else deferred.reject(new Error("The selected model is unavailable"));
    assert.ok((await outcomes).every((result) => result.status === "rejected"));
    assert.equal(ready.snapshot().state, "error");
    deferred.resolve();
    await Promise.resolve();
    assert.equal(ready.snapshot().state, "error");
    if (mode === "cancel") await assert.rejects(ready.wait());
    else {
      await ready.wait();
      assert.equal(ready.snapshot().state, "ready");
      assert.equal(calls, 2, "a settled failure is not cached as a permanently rejected promise");
    }
    retained();
  }
  let releaseOld = () => {};
  let reachedOld = () => {};
  const oldRead = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldReached = new Promise<void>((resolve) => { reachedOld = resolve; });
  const old = createWorkspaceReadiness(async () => {});
  let scope = { readiness: old, expected: { workspaceId: "fixture", createdAt: "original", readinessKey: "old" } };
  const draft = "Original request";
  const writes: string[] = [];
  const pending = prepareCurrentWorkspace(() => scope, async (signal) => {
    const key = scope.expected.readinessKey;
    if (key === "old") { reachedOld(); await oldRead; }
    signal.throwIfAborted();
    return { key, draft };
  }, new AbortController().signal);
  await oldReached;
  scope = { ...scope, readiness: createWorkspaceReadiness(async () => {}), expected: { ...scope.expected, readinessKey: "replacement" } };
  old.dispose();
  const prepared = await pending;
  assert.equal(writes.length, 0);
  assert.equal(prepared.value.draft, draft);
  assert.equal(prepared.expected.readinessKey, "replacement");
  prepared.assertCurrent();
  writes.push(prepared.value.draft);
  releaseOld();
  await Promise.resolve();
  assert.deepEqual(writes, [draft]);
  scope.readiness.dispose();
  assert.throws(prepared.assertCurrent);
});

test("prepared workspaces survive navigation, isolate coworker changes and dispose bounded stale scopes", async () => {
  const runtime: RuntimeInfo = { appName: "Fixture", version: "test", serverUrl: "http://127.0.0.1:8790", ownerToken: "fixture", coworkersDir: "/fixture", denBaseUrl: "https://example.invalid", deepLinkScheme: "fixture", deepLinksRegistered: false, engineManaged: true, engineError: "", readinessKey: "pid:1", workspaceReadinessRevisions: {} };
  const coworker: CoworkerSummary = { slug: "first", path: "/fixture/first", name: "First", role: "", mission: "", avatarColor: "blue", avatarGlasses: "round", personality: "neutral", roleId: "", suggestedBy: null, workspaceId: "ws_first", conversationThreadId: "", model: "fixture/model", modelVariant: "", modelChosenBy: "app", modelMode: "auto", useAppModelDefaults: true, effortPreference: "balanced", automations: [], createdAt: "original" };
  const other = { ...coworker, slug: "second", path: "/fixture/second", workspaceId: "ws_second" };
  const firstScope = workspacePreparationScope(runtime, coworker, null);
  const secondScope = workspacePreparationScope(runtime, other, null);
  const cache = createWorkspaceReadinessCache(2);
  let calls = 0;
  const prepare = async () => { calls++; };
  try {
    const first = cache.get(firstScope, prepare);
    const release = first.retain();
    await first.wait();
    release();
    await Promise.resolve();
    const second = cache.get(secondScope, prepare);
    await second.wait();
    const returned = cache.get(firstScope, prepare);
    assert.equal(returned, first);
    await returned.wait();
    assert.equal(calls, 2, "view navigation does not re-prepare a successful exact scope");
    const changed = { ...runtime, workspaceReadinessRevisions: { ws_first: 1 } };
    assert.equal(runtimeWorkspaceReadinessKey(runtime, other.workspaceId), runtimeWorkspaceReadinessKey(changed, other.workspaceId));
    assert.notEqual(runtimeWorkspaceReadinessKey(runtime, coworker.workspaceId), runtimeWorkspaceReadinessKey(changed, coworker.workspaceId));
    assert.notEqual(runtimeWorkspaceReadinessKey(runtime, coworker.workspaceId), runtimeWorkspaceReadinessKey({ ...runtime, engineError: "OpenCode exited during startup." }, coworker.workspaceId));
    const replacement = cache.get(workspacePreparationScope(changed, coworker, null), prepare);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, false);
    assert.equal(cache.peek(secondScope)?.state, "ready");
    await replacement.wait();
    for (const owner of [{ ...coworker, effortPreference: "light" }, { ...coworker, useAppModelDefaults: false }, { ...coworker, modelVariant: "high" }, { ...coworker, modelSelectionPreferences: { priority: "balanced", preferred: { quick: [], deep: [] }, avoided: ["fixture/model"] } }] satisfies CoworkerSummary[]) {
      assert.notEqual(workspacePreparationScope(changed, owner, null).configurationKey, workspacePreparationScope(changed, coworker, null).configurationKey);
    }
    const replacedIdentity = { ...coworker, createdAt: "replacement" };
    cache.get(workspacePreparationScope(changed, replacedIdentity, null), prepare);
    assert.equal(second.signal.aborted, true, "the least recently used scope is disposed at the entry bound");
    assert.equal(cache.peek(secondScope), undefined);
    const signedIn = { baseUrl: "https://example.invalid", orgId: "org_fixture", token: "account_fixture" };
    cache.get(workspacePreparationScope(changed, coworker, signedIn), prepare);
    assert.equal(replacement.signal.aborted, true, "an account change invalidates the earlier runtime cache");
    assert.equal(cache.peek(firstScope), undefined);
    const idle = { state: "idle", label: "Idle", detail: "", updatedAt: 0 } satisfies Parameters<typeof projectWorkspaceReadiness>[0];
    assert.equal(projectWorkspaceReadiness(idle).label, "Idle");
    assert.equal(projectWorkspaceReadiness(idle, { state: "ready", error: "" }).label, "Ready");
    assert.equal(projectWorkspaceReadiness({ ...idle, state: "starting", label: "Starting AI" }).state, "idle");
    for (const state of ["working", "attention", "retrying"] satisfies CoworkerActivity["state"][]) {
      const activity = { ...idle, state };
      assert.equal(projectWorkspaceReadiness(activity, { state: "starting", error: "" }), activity);
    }
  } finally { cache.dispose(); }
});

test("workspace preparation validates the effective conversation default and effort with the send resolver", async () => {
  const source = await readFile(new URL("./threads.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async function prepare(signal:");
  const end = source.indexOf("  async function listAllThreads(", start);
  assert.ok(start > 0 && end > start);
  const script = await transform(`${source.slice(start, end)}\nprepare`, { loader: "ts", target: "es2022" });
  const catalog = connectedModelCatalog(fixtureCatalog({ connected: ["fixture"], all: [fixtureProvider({ id: "fixture", name: "Fixture", models: { model: { name: "Model", variants: { low: {}, high: {} } } } })] }));
  const defaults = { ...DEFAULT_MODEL_DEFAULTS, conversation: { model: "fixture/model", modelVariant: "low" } };
  const owner = { model: "stale/missing", modelVariant: "unavailable", useAppModelDefaults: true, effortPreference: "balanced" };
  const native = { getAgent: async () => ({ id: "build" }), defaultModel: async () => assert.fail("The saved engine default must not override the effective role default") };
  const prepare = runInNewContext(script.code, { createNativeV2Client: () => native, nativeOptions: {}, options: {}, agentId: "build", parsedModel: parseModelPreference(owner.model), WORKSPACE_STARTUP_TIMEOUT_MS, listModelCatalog: async () => catalog, resolveDiscussionModel, Error, Promise });
  await prepare(new AbortController().signal, { coworker: owner, defaults });
  assert.equal(resolveDiscussionModel(catalog, owner, "", defaults).variant, "low");
  await assert.rejects(prepare(new AbortController().signal, { coworker: { ...owner, useAppModelDefaults: false }, defaults }), /not available/);
  await assert.rejects(prepare(new AbortController().signal, { coworker: owner, defaults: { ...defaults, conversation: { model: "fixture/model", modelVariant: "missing" } } }), /no longer offers/);
});

test("permissions and questions keep the thread waiting for the person", () => {
  const permission = { id: "p1", sessionID: "s1", protocol: "legacy" as const, action: "bash", resources: ["rm -rf build"], canAlways: true };
  const question = {
    id: "q1",
    sessionID: "s1",
    questions: [{ header: "Which repo?", question: "Which repository should I use?", options: [], multiple: false, custom: true }],
  };
  assert.equal(hasPendingInteractions({ permissions: [permission], questions: [] }), true);
  assert.equal(hasPendingInteractions({ permissions: [], questions: [question] }), true);
  assert.equal(hasPendingInteractions({ permissions: [], questions: [] }), false);
});

test("connectedModelCatalog only lists connected providers and marks provider defaults", () => {
  const catalog = connectedModelCatalog(fixtureCatalog({
    connected: ["anthropic", "custom-empty"],
    default: { anthropic: "claude-haiku-4-5" },
    all: [
      fixtureProvider({
        id: "anthropic",
        name: "Anthropic",
        source: "env",
        env: [],
        options: {},
        models: {
          "claude-haiku-4-5": { name: "Claude Haiku 4.5", variants: { high: {}, low: {} } },
          "claude-sonnet-4-5": { name: "Claude Sonnet 4.5" },
        },
      }),
      fixtureProvider({ id: "openai", name: "OpenAI", source: "config", env: [], options: {}, models: { "gpt-5": { name: "GPT-5" } } }),
      fixtureProvider({ id: "custom-empty", name: "Custom", source: "custom", env: [], options: {}, models: {} }),
    ],
  }));
  assert.deepEqual(catalog.connectedProviderIds, ["anthropic"]);
  assert.deepEqual(
    catalog.models.map((model) => [model.id, model.isProviderDefault, model.variants]),
    [
      ["anthropic/claude-haiku-4-5", true, ["low", "high"]],
      ["anthropic/claude-sonnet-4-5", false, []],
    ],
  );
});

test("parseModelPreference accepts provider/model and rejects malformed values", () => {
  assert.deepEqual(parseModelPreference("anthropic/claude-haiku-4-5"), { providerId: "anthropic", modelId: "claude-haiku-4-5" });
  assert.deepEqual(parseModelPreference("openrouter/vendor/model:free"), { providerId: "openrouter", modelId: "vendor/model:free" });
  assert.equal(parseModelPreference(""), undefined);
  assert.equal(parseModelPreference("anthropic/"), undefined);
  assert.equal(parseModelPreference("/model"), undefined);
});

test("catalog prices distinguish explicit free from missing, partial or invalid prices", () => {
  for (const missing of ["none", "cost", "input", "output", "invalid"]) {
    const model = fixtureModel("openai", "model", { name: "Model" });
    if (missing === "cost") Reflect.deleteProperty(model, "cost");
    if (missing === "input" || missing === "output") Reflect.deleteProperty(model.cost, missing);
    if (missing === "invalid") model.cost.output = Number.NaN;
    const provider = fixtureProvider({ id: "openai", name: "OpenAI", models: {} });
    provider.models.model = model;
    const [option] = connectedModelCatalog(fixtureCatalog({ all: [provider], connected: [provider.id] })).models;
    assert.ok(option);
    assert.equal(option.knownPrice, missing === "none", missing);
    assert.equal(option.progressEligibility?.knownPrice, option.knownPrice, "summary pricing remains a separate eligibility check");
  }
});

test("intelligence projects raw tri-state facts before display defaults and refreshes without claiming upstream freshness", () => {
  const raw = fixtureModel("openrouter", "vendor/model:free", { name: "Model" });
  const provider = fixtureProvider({ id: "openrouter", name: "Router", models: {} });
  provider.models[raw.id] = raw;
  const source = fixtureCatalog({ all: [provider], connected: [provider.id] });
  Reflect.deleteProperty(raw.capabilities, "reasoning");
  Reflect.deleteProperty(raw.capabilities, "toolcall");
  Reflect.deleteProperty(raw.capabilities.input, "image");
  Reflect.deleteProperty(raw, "status");
  const [first] = connectedModelCatalog(source, null, 100).models;
  assert.ok(first?.intelligence);
  assert.equal(first.id, "openrouter/vendor/model:free");
  assert.equal(first.toolCall, true, "legacy display stays permissive");
  assert.equal(first.reasoning, false);
  assert.equal(first.status, "active");
  assert.equal(first.intelligence.tools, null);
  assert.equal(first.intelligence.reasoning, null);
  assert.equal(first.intelligence.status, null);
  assert.equal(first.intelligence.input.image, null);
  assert.equal(first.intelligence.output.image, false, "explicit false differs from unknown");
  assert.equal(first.intelligence.observedAt, 100);
  assert.equal(first.intelligence.provenance, "engine-catalog");
  assert.equal("fetchedAt" in first.intelligence, false);
  raw.capabilities.toolcall = true;
  raw.capabilities.reasoning = false;
  raw.status = "active";
  raw.cost.input = 0.25;
  raw.limit.context = 256_000;
  const [second] = connectedModelCatalog(source, null, 200).models;
  assert.ok(second?.intelligence);
  assert.equal(second.intelligence.reasoning, false);
  assert.equal(second.intelligence.tools, true);
  assert.equal(second.intelligence.cost.input, 0.25, "engine per-million price is not converted again");
  assert.equal(second.intelligence.limits.context, 256_000);
  assert.equal(second.intelligence.observedAt, 200);
  assert.equal(first.intelligence.reasoning, null, "previous observation remains independent");
});

test("service registry evidence is exact and separate from adapters, authentication, names and private provider options", () => {
  const raw = {
    name: "OpenAI Claude Gemini", api: { npm: "@ai-sdk/openai", id: "vendor/model" },
    get options(): never { throw new Error("must not read options"); },
    get headers(): never { throw new Error("must not read headers"); },
  };
  const custom = normalizeModelIntelligence(raw, "custom-gateway", 123);
  assert.equal(custom.serviceFamily, null);
  assert.equal(custom.serviceEvidence, null);
  assert.equal(custom.adapterNpm, "@ai-sdk/openai");
  assert.equal(custom.apiModelId, "vendor/model");
  for (const key of ["options", "headers", "auth", "credentialKind", "url", "baseURL"]) assert.equal(key in custom, false);
  for (const service of MODEL_INTELLIGENCE_INDEX.services) {
    assert.ok(service.sourceKeys.length > 0);
    for (const key of service.sourceKeys) assert.match(MODEL_INTELLIGENCE_INDEX.sources[key], /^https:\/\//);
    for (const id of service.providerIds) {
      const observed = normalizeModelIntelligence(raw, id, 123);
      assert.equal(observed.serviceFamily, service.family);
      assert.equal(observed.serviceEvidence, "provider-registry-default");
      assert.equal(normalizeModelIntelligence(raw, `${id}-custom`, 123).serviceFamily, null);
    }
  }
  assert.equal(MODEL_INTELLIGENCE_INDEX.reviewedAt, "2026-09-09");
  assert.equal(MODEL_INTELLIGENCE_INDEX.adapters.find((adapter) => adapter.npm === "@ai-sdk/openai-compatible")?.family, null);
});

test("numeric intelligence facts reject invalid and raw per-token strings while preserving explicit zero", () => {
  for (const value of [undefined, null, -1, Infinity, NaN, "0.000001", 0, 2]) {
    const facts = normalizeModelIntelligence({ cost: { input: value, output: value }, limit: { context: value } }, "openrouter", 1);
    const expected = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    assert.equal(facts.cost.input, expected);
    assert.equal(facts.cost.output, expected);
    assert.equal(facts.limits.context, expected);
    assert.equal(facts.cost.unit, "per-million-tokens");
  }
});

test("connectedModelCatalog tells account (OpenWork Cloud) providers from this Mac's and lists account models first", () => {
  const providerList = fixtureCatalog({
    connected: ["anthropic", "lpr_01org", "openwork", "opencode"],
    default: {},
    all: [
      fixtureProvider({ id: "anthropic", name: "Anthropic", source: "env", env: [], options: {}, models: { "claude-haiku-4-5": { name: "Claude Haiku 4.5" } } }),
      fixtureProvider({ id: "lpr_01org", name: "Acme LiteLLM", source: "config", env: [], options: {}, models: { "acme-router": { name: "Acme Router" } } }),
      fixtureProvider({ id: "openwork", name: "OpenWork", source: "config", env: [], options: {}, models: { fable: { name: "Fable" } } }),
      fixtureProvider({ id: "opencode", name: "OpenCode Zen", source: "config", env: [], options: {}, models: { "big-pickle": { name: "Big Pickle" } } }),
    ],
  });

  // With the embedded server's sync status, its provider ids decide the source.
  const withStatus = connectedModelCatalog(providerList, {
    hasSession: true,
    lastRun: { at: "2026-09-01T00:00:00.000Z", status: "applied" },
    providers: [{ providerId: "lpr_01org", name: "Acme LiteLLM", source: "custom", modelIds: ["acme-router"] }],
    reloadPending: false,
    skippedProviders: [{ providerId: "lpr_02", name: "Personal OpenAI", reason: "needs_key" }],
  });
  assert.deepEqual(
    withStatus.models.map((model) => [model.id, model.source]),
    [
      ["lpr_01org/acme-router", "cloud"],
      ["openwork/fable", "cloud"],
      ["anthropic/claude-haiku-4-5", "local"],
      ["opencode/big-pickle", "local"],
    ],
  );
  assert.equal(withStatus.cloud?.skippedProviders[0]?.reason, "needs_key");
  const gateway: Parameters<typeof connectedModelCatalog>[0] = {
    connected: ["ipr_openai", "ipr_anthropic"], default: {}, all: [
      { id: "ipr_openai", name: "OW OpenAI", models: {
        gwm_luna: { name: "GPT-5.6 Luna", upstreamModelId: "gpt-5.6-luna", modelGroupId: "group", credentialSetId: "set" },
        gwm_astra: { name: "GPT-6 Astra", variants: { medium: {} } },
        gwm_gpt: { name: "GPT-5.6" },
      } },
      { id: "ipr_anthropic", name: "OW Anthropic", models: { gwm_fable: { name: "Fable" } } },
      { id: "ipr_unconnected", name: "Unconnected", models: { gwm_gpt6: { name: "GPT-6" } } },
    ],
  };
  const assigned = connectedModelCatalog(gateway);
  assert.deepEqual(assigned.models.map((model) => model.label), ["OW Anthropic · Fable", "OW OpenAI · GPT-5.6", "OW OpenAI · GPT-5.6 Luna", "OW OpenAI · GPT-6 Astra"]);
  assert.ok(assigned.models.every((model) => model.source === "cloud"));
  assert.equal(assigned.models.find((model) => model.modelId === "gwm_luna")?.upstreamModelId, "gpt-5.6-luna");
  assert.deepEqual(assigned.models.find((model) => model.modelId === "gwm_astra")?.variants, ["medium"]);
  assert.deepEqual(connectedModelCatalog(gateway, { hasSession: false, lastRun: null, providers: [], reloadPending: true, skippedProviders: [] }).models, []);

  // Without status, the cloud-owned key shapes still identify account providers.
  const withoutStatus = connectedModelCatalog(providerList);
  assert.equal(withoutStatus.cloud, null);
  assert.deepEqual(
    withoutStatus.models.filter((model) => model.source === "cloud").map((model) => model.providerId),
    ["lpr_01org", "openwork"],
  );

  // A definitive signed-out status wins over a provider list that the engine
  // has not finished refreshing yet, so account models cannot be selected or
  // invoked with stale routing state.
  const signedOut = connectedModelCatalog(providerList, {
    hasSession: false,
    lastRun: null,
    providers: [],
    reloadPending: true,
    skippedProviders: [],
  });
  assert.deepEqual(
    signedOut.models.map((model) => model.providerId),
    ["anthropic", "opencode"],
  );
});

test("recommendModel picks a connected, tool-capable model — the account's first, the provider default first, newest first", () => {
  const catalog = connectedModelCatalog(fixtureCatalog({
    connected: ["openrouter", "anthropic", "lpr_org"],
    default: { openrouter: "free-chat", anthropic: "claude-haiku-4-5", lpr_org: "org-large" },
    all: [
      fixtureProvider({
        id: "openrouter",
        name: "OpenRouter",
        source: "env",
        env: [],
        options: {},
        models: {
          "free-chat": { name: "Free Chat", capabilities: { toolcall: false, reasoning: false }, status: "active", release_date: "2026-08-01" },
          "old-tools": { name: "Old Tools", capabilities: { toolcall: true, reasoning: false }, status: "deprecated", release_date: "2024-01-01" },
        },
      }),
      fixtureProvider({
        id: "anthropic",
        name: "Anthropic",
        source: "env",
        env: [],
        options: {},
        models: {
          "claude-haiku-4-5": { name: "Claude Haiku 4.5", capabilities: { toolcall: true, reasoning: true }, status: "active", release_date: "2025-10-01" },
          "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", capabilities: { toolcall: true, reasoning: true }, status: "active", release_date: "2025-09-01" },
        },
      }),
      fixtureProvider({
        id: "lpr_org",
        name: "Org Provider",
        source: "custom",
        env: [],
        options: {},
        models: {
          "org-large": { name: "Org Large", capabilities: { toolcall: true, reasoning: false }, status: "active", release_date: "2026-01-01" },
          "org-chat": { name: "Org Chat", capabilities: { toolcall: false, reasoning: false }, status: "active", release_date: "2026-05-01" },
        },
      }),
    ],
  }));
  assert.equal(recommendModel(catalog)?.id, "lpr_org/org-large", "the account's tool-capable default wins while signed in");
  const withChatDefault = connectedModelCatalog(fixtureCatalog({
    connected: ["openai", "anthropic"],
    default: { openai: "gpt-chat-latest", anthropic: "claude-sonnet" },
    all: [
      fixtureProvider({
        id: "openai", name: "OpenAI", source: "env", env: [], options: {},
        models: { "gpt-chat-latest": { name: "GPT Chat", capabilities: { toolcall: true, reasoning: false }, status: "active", release_date: "2026-08-01" } },
      }),
      fixtureProvider({
        id: "anthropic", name: "Anthropic", source: "env", env: [], options: {},
        models: { "claude-sonnet": { name: "Claude Sonnet", capabilities: { toolcall: true, reasoning: true }, status: "active", release_date: "2026-02-01" } },
      }),
    ],
  }));
  assert.equal(recommendModel(withChatDefault)?.id, "anthropic/claude-sonnet", "a reasoning default beats a newer chat alias");
  assert.equal(recommendModel(withChatDefault, { exclude: ["anthropic/claude-sonnet"] })?.id, "openai/gpt-chat-latest");
  assert.equal(recommendModel(withChatDefault, { exclude: ["anthropic/claude-sonnet", "openai/gpt-chat-latest"] }), null);
  const local = { models: catalog.models.filter((model) => model.source === "local") };
  assert.equal(recommendModel(local)?.id, "anthropic/claude-haiku-4-5", "the provider default wins on this Mac");
  assert.equal(recommendModel(local, { exclude: "anthropic/claude-haiku-4-5" })?.id, "anthropic/claude-sonnet-4-5");
  const chatOnly = { models: catalog.models.filter((model) => !model.toolCall) };
  assert.equal(recommendModel(chatOnly), null, "nothing is recommended when no connected model can use tools");
  assert.equal(recommendModel({ models: catalog.models.filter((model) => model.providerId === "openrouter") }), null, "a deprecated model is never recommended");

  // OpenCode's own catalog is selectable but never recommended; OpenWork's free
  // model is, once the engine reports its provider, and a key on this Mac beats it.
  const withoutAccount = connectedModelCatalog(fixtureCatalog({
    connected: ["opencode", "openwork-free"],
    default: { opencode: "big-pickle" },
    all: [
      fixtureProvider({ id: "opencode", name: "OpenCode Zen", source: "custom", env: [], options: {}, models: { "big-pickle": { name: "Big Pickle", capabilities: { toolcall: true, reasoning: true } } } }),
      fixtureProvider({ id: "openwork-free", name: "OpenWork", source: "custom", env: [], options: {}, models: { "openai/gpt-5.6-luna": { name: "Luna", capabilities: { toolcall: true, reasoning: true } } } }),
    ],
  }));
  assert.deepEqual(withoutAccount.models.map((model) => [model.id, model.tier]), [["openwork-free/openai/gpt-5.6-luna", "free"], ["opencode/big-pickle", "opencode"]], "OpenCode's catalog sorts last");
  assert.equal(recommendModel(withoutAccount)?.id, "openwork-free/openai/gpt-5.6-luna", "OpenWork's free model fills a blank when nothing of the person's own is connected");
  assert.equal(recommendModel({ models: withoutAccount.models.filter((model) => model.providerId === "opencode") }), null, "OpenCode's catalog alone recommends nothing: it stays a deliberate choice");
  assert.equal(recommendModel({ models: [...withoutAccount.models, ...local.models] })?.id, "anthropic/claude-haiku-4-5", "a key on this Mac still comes before the free model");
});

test("a retry the engine never moved on from reads as idle once its next attempt is long past", () => {
  const now = 1_000_000;
  assert.equal(threadStatusOf(undefined, now), "idle");
  assert.equal(threadStatusOf({ type: "busy" }, now), "busy");
  assert.equal(threadStatusOf({ type: "retry", attempt: 2, message: "Rate limit exceeded", next: now + 5_000 }, now), "retry");
  assert.equal(threadStatusOf({ type: "retry", attempt: 2, message: "Rate limit exceeded", next: now - 30_000 }, now), "retry");
  assert.equal(threadStatusOf({ type: "retry", attempt: 2, message: "Rate limit exceeded", next: now - 90_000 }, now), "idle");
});

test("a retry pushed far into the future is a stall with the provider's reason in plain words", () => {
  const now = 1_000_000;
  assert.equal(stalledRetry(undefined, now), null);
  assert.equal(stalledRetry({ next: now + 30_000, message: "Rate limit exceeded." }, now), null);
  assert.equal(stalledRetry({ next: now + 9 * 3_600_000, message: "Free usage exceeded, subscribe to Go. " }, now), "Free usage exceeded, subscribe to Go");
  assert.equal(stalledRetry({ next: now + 3_600_000, message: "   " }, now), "The AI provider is not answering");
});

test("coalesceCalls runs the first call at once and folds a burst into one trailing call", async () => {
  let clock = 1_000;
  let runs = 0;
  const coalesced = coalesceCalls(() => { runs += 1; }, 250, () => clock);
  coalesced.call();
  assert.equal(runs, 1, "the first call in a quiet period runs immediately");
  clock += 10;
  coalesced.call();
  clock += 10;
  coalesced.call();
  assert.equal(runs, 1, "calls inside the window wait");
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(runs, 2, "one trailing call answers the whole burst");
  clock += 1_000;
  coalesced.call();
  assert.equal(runs, 3, "after a quiet period the next call runs at once again");
  clock += 5;
  coalesced.call();
  coalesced.cancel();
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(runs, 3, "cancel drops a pending trailing call");
});
