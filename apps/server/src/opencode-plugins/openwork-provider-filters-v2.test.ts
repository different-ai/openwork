import { expect, test } from "bun:test";
import filters from "./openwork-provider-filters-v2.js";
import { mapRuntimeProvidersToV2Specs } from "../engine-v2-preview.js";
import { renderOpencodeV2Config } from "../managed-opencode-v2.js";

test("v1 allow and deny lists filter built-in models and explicit overrides together", async () => {
  const { specs } = mapRuntimeProvidersToV2Specs({ openai: {
    npm: "@ai-sdk/openai", options: { apiKey: "synthetic-key" },
    whitelist: ["allowed", "denied"], blacklist: ["denied"],
    models: { allowed: {}, denied: {}, excluded: {} },
  } });
  const config = renderOpencodeV2Config({ providers: specs, skills: [], providerFiltersPluginDirectory: "/runtime/filters" });
  expect(config.providers).toMatchObject({ openai: { models: { allowed: { name: "allowed" } } } });
  expect(JSON.stringify(config.providers)).not.toContain("denied");
  expect(JSON.stringify(config.providers)).not.toContain("excluded");
  expect(config.plugins).toEqual([{ package: "file:///runtime/filters", options: {
    providers: { openai: { whitelist: ["allowed", "denied"], blacklist: ["denied"] } },
  } }]);
  const removed: string[] = [];
  let disposed = false;
  const close = await filters.setup({ options: { providers: { openai: specs[0] } }, catalog: {
    async transform(callback) {
      callback({ provider: { list: () => [
        { provider: { id: "openai" }, models: new Map(["allowed", "denied", "new-built-in"].map(id => [id, {}])) },
        { provider: { id: "other" }, models: new Map([["unrelated", {}]]) },
      ] }, model: { remove: (provider, model) => { removed.push(`${provider}/${model}`); } } });
      return { async dispose() { disposed = true; } };
    },
  } });
  expect(removed).toEqual(["openai/denied", "openai/new-built-in"]);
  await close();
  expect(disposed).toBe(true);
});

test("v1 disabled_providers hide built-in and mirrored providers in v2, and re-enabling restores them", async () => {
  const { specs } = mapRuntimeProvidersToV2Specs({ openai: {
    npm: "@ai-sdk/openai", options: { apiKey: "synthetic-key" }, models: { gpt: {} },
  } });
  const disabled = renderOpencodeV2Config({
    providers: specs,
    disabledProviderIds: ["opencode", "openai"],
    skills: [],
    providerFiltersPluginDirectory: "/runtime/filters",
  });
  expect(disabled.providers).toEqual({});
  expect(disabled.plugins).toEqual([{ package: "file:///runtime/filters", options: {
    providers: { opencode: { whitelist: [] }, openai: { whitelist: [] } },
  } }]);
  const removed: string[] = [];
  await filters.setup({ options: { providers: { opencode: { whitelist: [] } } }, catalog: {
    async transform(callback) {
      callback({ provider: { list: () => [
        { provider: { id: "opencode" }, models: new Map([["big-pickle", {}], ["nemotron-free", {}]]) },
        { provider: { id: "ollama" }, models: new Map([["llama", {}]]) },
      ] }, model: { remove: (provider, model) => { removed.push(`${provider}/${model}`); } } });
      return { async dispose() {} };
    },
  } });
  expect(removed).toEqual(["opencode/big-pickle", "opencode/nemotron-free"]);

  const enabled = renderOpencodeV2Config({ providers: specs, disabledProviderIds: [], skills: [], providerFiltersPluginDirectory: "/runtime/filters" });
  expect(enabled.providers).toMatchObject({ openai: { models: { gpt: { name: "gpt" } } } });
  expect(enabled.plugins).toBeUndefined();
});

test("an empty v1 whitelist stays empty rather than becoming unrestricted", () => {
  const { specs } = mapRuntimeProvidersToV2Specs({ openai: { npm: "@ai-sdk/openai", whitelist: [], models: { excluded: {} } } });
  expect(specs[0]?.whitelist).toEqual([]);
  expect(renderOpencodeV2Config({ providers: specs, skills: [] }).providers).toMatchObject({ openai: { models: {} } });
});
