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
} from "./threads.ts";

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
  const catalog = connectedModelCatalog({
    connected: ["anthropic", "custom-empty"],
    default: { anthropic: "claude-haiku-4-5" },
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        source: "env",
        env: [],
        options: {},
        models: {
          "claude-haiku-4-5": { name: "Claude Haiku 4.5", variants: { high: {}, low: {} } },
          "claude-sonnet-4-5": { name: "Claude Sonnet 4.5" },
        },
      },
      { id: "openai", name: "OpenAI", source: "config", env: [], options: {}, models: { "gpt-5": { name: "GPT-5" } } },
      { id: "custom-empty", name: "Custom", source: "custom", env: [], options: {}, models: {} },
    ],
  } as unknown as Parameters<typeof connectedModelCatalog>[0]);
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
  const providerList = {
    connected: ["anthropic", "lpr_01org", "openwork", "opencode"],
    default: {},
    all: [
      { id: "anthropic", name: "Anthropic", source: "env", env: [], options: {}, models: { "claude-haiku-4-5": { name: "Claude Haiku 4.5" } } },
      { id: "lpr_01org", name: "Acme LiteLLM", source: "config", env: [], options: {}, models: { "acme-router": { name: "Acme Router" } } },
      { id: "openwork", name: "OpenWork", source: "config", env: [], options: {}, models: { fable: { name: "Fable" } } },
      { id: "opencode", name: "OpenCode Zen", source: "config", env: [], options: {}, models: { "big-pickle": { name: "Big Pickle" } } },
    ],
  } as unknown as Parameters<typeof connectedModelCatalog>[0];

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
