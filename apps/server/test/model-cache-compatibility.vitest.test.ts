// Claude behind an OpenAI-compatible endpoint is prompt-cached only when the
// engine model has `compatibility.cacheFormat: "anthropic"` (#7277).
import { expect, test } from "vitest";
import { buildManagedProviderConfig } from "@openwork/types/managed-provider-config";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.ts";

function renderedModels(models: { id: string; config: Record<string, unknown> }[], providerPackage = "@opencode/ai/providers/openai-compatible") {
  const rendered = renderOpencodeV2Config({
    skills: [],
    providers: [{
      id: "proxy", name: "Proxy", apiKey: "synthetic-key", baseUrl: "https://proxy.example/v1",
      package: providerPackage,
      models: models.map((model) => ({ id: model.id, name: model.id, config: model.config })),
    }],
  });
  return JSON.parse(JSON.stringify(rendered)).providers.proxy.models;
}

test("a Den model's compatibility survives both config builders", () => {
  const provider = buildManagedProviderConfig({
    providerId: "proxy", name: "Proxy", source: "cloud",
    providerConfig: { npm: "@ai-sdk/openai-compatible", env: ["PROXY_API_KEY"], options: { baseURL: "https://proxy.example/v1" } },
    models: [
      { id: "team-claude", name: "Team Claude", config: { compatibility: { cacheFormat: "anthropic", requireReasoning: true } } },
      { id: "gpt-6.1", name: "GPT", config: {} },
    ],
  });
  expect(provider.models?.["team-claude"]?.compatibility).toEqual({ cacheFormat: "anthropic", requireReasoning: true });
  expect(provider.models?.["gpt-6.1"]).not.toHaveProperty("compatibility");

  const models = renderedModels(Object.entries(provider.models ?? {}).map(([id, config]) => ({ id, config })));
  expect(models["team-claude"].compatibility).toEqual({ cacheFormat: "anthropic", requireReasoning: true });
  expect(models["gpt-6.1"]).not.toHaveProperty("compatibility");
});

test("Claude on an OpenAI-compatible provider caches by default; other models do not", () => {
  const models = renderedModels([
    { id: "claude-sonnet-5", config: {} },
    { id: "sonnet", config: { id: "anthropic/claude-sonnet-5" } },
    { id: "claude-opus-5", config: { compatibility: { streamUsage: false } } },
    { id: "gpt-6.1", config: {} },
  ]);
  expect(models["claude-sonnet-5"].compatibility).toEqual({ cacheFormat: "anthropic" });
  expect(models.sonnet.compatibility).toEqual({ cacheFormat: "anthropic" });
  expect(models["claude-opus-5"].compatibility).toEqual({ streamUsage: false, cacheFormat: "anthropic" });
  expect(models["gpt-6.1"]).not.toHaveProperty("compatibility");
});

test("a declared cache format and native provider packages are left to the engine", () => {
  expect(renderedModels([{ id: "claude-sonnet-5", config: { compatibility: { cacheFormat: "alibaba" } } }])["claude-sonnet-5"].compatibility)
    .toEqual({ cacheFormat: "alibaba" });
  expect(renderedModels([{ id: "claude-sonnet-5", config: {} }], "@opencode/ai/providers/anthropic")["claude-sonnet-5"])
    .not.toHaveProperty("compatibility");
});
