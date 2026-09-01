import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectedModelCatalog,
  describeInteractions,
  describePermission,
  hasPendingInteractions,
  parseModelPreference,
} from "./threads.ts";

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
