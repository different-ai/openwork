import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coalesceCalls,
  connectedModelCatalog,
  hasPendingInteractions,
  parseModelPreference,
  recommendModel,
  stalledRetry,
  threadStatusOf,
} from "./threads.ts";
import { fixtureCatalog, fixtureModel, fixtureProvider } from "./provider-catalog.fixture.ts";
import { MODEL_INTELLIGENCE_INDEX, normalizeModelIntelligence } from "./model-intelligence.ts";

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
