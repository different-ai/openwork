import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignmentThreads,
  connectedModelCatalog,
  describeInteractions,
  describePermission,
  hasPendingInteractions,
  isCloudManagedProviderId,
  modelSourceLabel,
  parseModelPreference,
  recommendModel,
  threadStatusOf,
} from "./threads.ts";
import { fixtureCatalog, fixtureProvider } from "./provider-catalog.fixture.ts";

test("assignmentThreads excludes the standing discussion without hiding real work", () => {
  const threads = [{ id: "ses_chat", title: "Conversation" }, { id: "ses_work", title: "Launch brief" }];
  assert.deepEqual(assignmentThreads(threads, "ses_chat"), [{ id: "ses_work", title: "Launch brief" }]);
  assert.deepEqual(assignmentThreads(threads, ""), threads);
});

test("describePermission speaks plainly about what the coworker wants", () => {
  assert.equal(describePermission({ action: "bash", resources: [] }), "run a command");
  assert.equal(
    describePermission({ action: "external_directory", resources: ["/Users/me/Projects/site"] }),
    "work outside its home folder: /Users/me/Projects/site",
  );
  assert.equal(
    describePermission({ action: "edit", resources: ["a.md", "b.md", "c.md"] }),
    "change files: a.md (+2 more)",
  );
  assert.equal(describePermission({ action: "tool.webfetch", resources: ["https://example.com"] }), "fetch a web page: https://example.com");
  assert.equal(describePermission({ action: "unusual_thing", resources: [] }), "unusual_thing");
});

test("describeInteractions prefers the first permission, then the first question header", () => {
  const permission = { id: "p1", sessionID: "s1", protocol: "legacy" as const, action: "bash", resources: ["rm -rf build"], canAlways: true };
  const question = {
    id: "q1",
    sessionID: "s1",
    questions: [{ header: "Which repo?", question: "Which repository should I use?", options: [], multiple: false, custom: true }],
  };
  assert.equal(describeInteractions({ permissions: [permission], questions: [question] }), "Wants to run a command: rm -rf build");
  assert.equal(describeInteractions({ permissions: [], questions: [question] }), "Which repo?");
  assert.equal(describeInteractions({ permissions: [], questions: [] }), "");
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
  assert.equal(parseModelPreference(""), undefined);
  assert.equal(parseModelPreference("anthropic/"), undefined);
  assert.equal(parseModelPreference("/model"), undefined);
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
  assert.equal(isCloudManagedProviderId("LPR_abc"), true);
  assert.equal(isCloudManagedProviderId("anthropic"), false);
  assert.equal(modelSourceLabel("cloud"), "OpenWork Cloud");
  assert.equal(modelSourceLabel("local"), "This Mac");
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

test("recommendModel prefers the account, then a subscription or key on this Mac, then a local server, and the free model last", () => {
  const model = (name: string, releaseDate: string) => ({ name, capabilities: { toolcall: true, reasoning: true }, release_date: releaseDate });
  const providers = {
    free: fixtureProvider({ id: "opencode", name: "OpenCode Zen", source: "custom", env: [], options: {}, models: { "big-pickle": model("Big Pickle", "2026-09-01") } }),
    ollama: fixtureProvider({ id: "ollama", name: "Ollama", source: "config", env: [], options: { baseURL: "http://127.0.0.1:11434/v1" }, models: { "llama3.2:latest": model("llama3.2", "2026-08-30") } }),
    lan: fixtureProvider({ id: "custom-office-box", name: "Office box", source: "config", env: [], options: { baseURL: "http://192.168.1.20:8000/v1" }, models: { qwen: model("Qwen", "2026-08-29") } }),
    chatgpt: fixtureProvider({ id: "openai", name: "OpenAI", source: "custom", env: [], options: {}, models: { "gpt-5": model("GPT-5", "2025-08-07") } }),
    remote: fixtureProvider({ id: "custom-remote", name: "Remote", source: "config", env: [], options: { baseURL: "https://ai.example.com/v1" }, models: { big: model("Big", "2025-01-01") } }),
    org: fixtureProvider({ id: "lpr_01org", name: "Org", source: "config", env: [], options: {}, models: { "org-large": model("Org Large", "2024-01-01") } }),
  };
  const catalogOf = (...entries: Array<(typeof providers)[keyof typeof providers]>) =>
    connectedModelCatalog(fixtureCatalog({ connected: entries.map((entry) => entry.id), default: {}, all: entries }));

  const everything = catalogOf(providers.free, providers.ollama, providers.lan, providers.chatgpt, providers.remote, providers.org);
  assert.deepEqual(
    Object.fromEntries(everything.models.map((entry) => [entry.providerId, entry.tier])),
    { opencode: "free", ollama: "local-server", "custom-office-box": "local-server", openai: "key", "custom-remote": "key", lpr_01org: "cloud" },
  );
  assert.equal(recommendModel(everything)?.id, "lpr_01org/org-large", "the account wins even when it is the oldest release");
  assert.equal(recommendModel(catalogOf(providers.free, providers.ollama, providers.chatgpt, providers.remote))?.id, "openai/gpt-5", "a subscription beats a local server and the free model");
  assert.equal(recommendModel(catalogOf(providers.free, providers.ollama, providers.lan))?.id, "ollama/llama3.2:latest", "a local server beats the free model");
  assert.equal(recommendModel(catalogOf(providers.free))?.id, "opencode/big-pickle", "the free model is what is left when nothing is connected");
  assert.equal(recommendModel(catalogOf(providers.free, providers.chatgpt), { exclude: "openai/gpt-5" })?.id, "opencode/big-pickle", "an excluded model hands over to the next tier");
});

test("assignmentThreads excludes every discussion, not just the open one", () => {
  const threads = [{ id: "ses_a", title: "Discussion with Scout" }, { id: "ses_b", title: "Move the car" }, { id: "ses_work", title: "Launch brief" }];
  assert.deepEqual(assignmentThreads(threads, ["ses_a", "ses_b"]), [{ id: "ses_work", title: "Launch brief" }]);
  assert.deepEqual(assignmentThreads(threads, new Set(["ses_a", " "])), threads.slice(1));
  assert.deepEqual(assignmentThreads(threads, []), threads);
});

test("a retry the engine never moved on from reads as idle once its next attempt is long past", () => {
  const now = 1_000_000;
  assert.equal(threadStatusOf(undefined, now), "idle");
  assert.equal(threadStatusOf({ type: "busy" }, now), "busy");
  assert.equal(threadStatusOf({ type: "retry", attempt: 2, message: "Rate limit exceeded", next: now + 5_000 }, now), "retry");
  assert.equal(threadStatusOf({ type: "retry", attempt: 2, message: "Rate limit exceeded", next: now - 30_000 }, now), "retry");
  assert.equal(threadStatusOf({ type: "retry", attempt: 2, message: "Rate limit exceeded", next: now - 90_000 }, now), "idle");
});
