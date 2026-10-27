import assert from "node:assert/strict";
import { test } from "node:test";
import { mapRuntimeProvidersToV2Specs } from "../src/engine-v2-preview.js";

const key = "test-provider-key";

test("maps Azure BYOK to the bundled Responses adapter and normalizes its v1 endpoint", () => {
  const { specs, skippedProviderIds } = mapRuntimeProvidersToV2Specs({
    azure_foundry: {
      npm: "@ai-sdk/azure",
      name: "Azure Foundry",
      api: "https://resource.openai.azure.com/openai/v1",
      env: ["AZURE_FOUNDRY_API_KEY"],
      options: { apiKey: "{env:AZURE_FOUNDRY_API_KEY}", resourceName: "resource", transport: "http" },
      models: { deployment: { name: "Deployment", tool_call: true } },
    },
  }, new Map([["AZURE_FOUNDRY_API_KEY", key]]), new Map(), new Set(["azure_foundry"]));

  assert.deepEqual(skippedProviderIds, []);
  assert.equal(specs[0]?.package, "@opencode/ai/providers/azure/responses");
  assert.equal(specs[0]?.baseUrl, "https://resource.openai.azure.com/openai");
  assert.equal(specs[0]?.apiKey, key);
  assert.deepEqual(specs[0]?.settings, { resourceName: "resource", transport: "http" });
});

test("preserves explicitly deployment-based Azure endpoints", () => {
  const { specs } = mapRuntimeProvidersToV2Specs({
    azure: {
      npm: "@ai-sdk/azure",
      api: "https://resource.openai.azure.com/openai/v1",
      options: { useDeploymentBasedUrls: true },
      models: { deployment: {} },
    },
  }, new Map(), new Map(), new Set(["azure"]));

  assert.equal(specs[0]?.baseUrl, "https://resource.openai.azure.com/openai/v1");
  assert.equal(specs[0]?.settings?.useDeploymentBasedUrls, true);
});

test("leaves non-Azure and non-v1 Azure endpoints unchanged", () => {
  const { specs } = mapRuntimeProvidersToV2Specs({
    custom_azure: {
      npm: "@ai-sdk/azure",
      api: "https://azure-gateway.example.test/openai/v1",
      options: {},
      models: { deployment: {} },
    },
    classic_azure: {
      npm: "@ai-sdk/azure",
      api: "https://resource.openai.azure.com",
      options: {},
      models: { deployment: {} },
    },
  }, new Map(), new Map(), new Set(["custom_azure", "classic_azure"]));

  assert.equal(specs.find(spec => spec.id === "custom_azure")?.baseUrl, "https://azure-gateway.example.test/openai/v1");
  assert.equal(specs.find(spec => spec.id === "classic_azure")?.baseUrl, "https://resource.openai.azure.com");
});

test("allows a custom catalog api only for an explicitly configured provider", () => {
  const definition = {
    npm: "@ai-sdk/openai-compatible",
    api: "https://gateway.example.test/v1",
    options: { apiKey: key },
    models: { model: {} },
  };
  const discovered = mapRuntimeProvidersToV2Specs({ gateway: definition });
  const configured = mapRuntimeProvidersToV2Specs({ gateway: definition }, new Map(), new Map(), new Set(["gateway"]));

  assert.deepEqual(discovered.skippedProviderIds, ["gateway"]);
  assert.equal(configured.specs[0]?.baseUrl, "https://gateway.example.test/v1");
  assert.equal(configured.specs[0]?.package, "@opencode/ai/providers/openai-compatible");
});

test("keeps trusted native catalog origins available without explicit configuration", () => {
  const result = mapRuntimeProvidersToV2Specs({ openai: {
    npm: "@ai-sdk/openai",
    api: "https://api.openai.com/v1",
    models: { "gpt-4.1": {} },
  } });

  assert.deepEqual(result.skippedProviderIds, []);
  assert.equal(result.specs[0]?.baseUrl, "https://api.openai.com/v1");
});

test("keeps explicit options.baseURL precedence over api metadata", () => {
  const result = mapRuntimeProvidersToV2Specs({ gateway: {
    npm: "@ai-sdk/openai-compatible",
    api: "https://untrusted.example.test/v1",
    options: { baseURL: "https://explicit.example.test/v1", apiKey: key },
    models: { model: {} },
  } });

  assert.deepEqual(result.skippedProviderIds, []);
  assert.equal(result.specs[0]?.baseUrl, "https://explicit.example.test/v1");
});

test("rejects unsafe configured api endpoints", () => {
  const result = mapRuntimeProvidersToV2Specs({
    credentials_in_url: {
      npm: "@ai-sdk/openai-compatible",
      api: "https://user:password@gateway.example.test/v1",
      models: { model: {} },
    },
    non_http: {
      npm: "@ai-sdk/openai-compatible",
      api: "file:///tmp/model-api",
      models: { model: {} },
    },
  }, new Map(), new Map(), new Set(["credentials_in_url", "non_http"]));

  assert.deepEqual(result.skippedProviderIds, ["credentials_in_url", "non_http"]);
  assert.deepEqual(result.specs, []);
});

test("rejects unsafe explicit options.baseURL endpoints", () => {
  const result = mapRuntimeProvidersToV2Specs({
    credentials_in_url: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://user:password@gateway.example.test/v1" },
      models: { model: {} },
    },
    non_http: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "file:///tmp/model-api" },
      models: { model: {} },
    },
  });

  assert.deepEqual(result.skippedProviderIds, ["credentials_in_url", "non_http"]);
});

test("does not permit arbitrary provider package installation for configured endpoints", () => {
  const result = mapRuntimeProvidersToV2Specs({ gateway: {
    npm: "attacker/provider-package",
    api: "https://gateway.example.test/v1",
    models: { model: {} },
  } }, new Map(), new Map(), new Set(["gateway"]));

  assert.deepEqual(result.skippedProviderIds, ["gateway"]);
  assert.deepEqual(result.specs, []);
});

test("resolves only the provider's declared stored credential", () => {
  const result = mapRuntimeProvidersToV2Specs({ openai: {
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    options: { apiKey: "{env:OPENAI_API_KEY}" },
    models: { "gpt-4.1": {} },
  } }, new Map([["OPENAI_API_KEY", key], ["UNRELATED_API_KEY", "unrelated-secret"]]));

  assert.equal(result.specs[0]?.apiKey, key);
  assert.ok(!JSON.stringify(result.specs).includes("unrelated-secret"));
});

test("still skips an OpenAI-compatible provider without an endpoint", () => {
  const result = mapRuntimeProvidersToV2Specs({ gateway: {
    npm: "@ai-sdk/openai-compatible",
    options: { apiKey: key },
    models: { model: {} },
  } }, new Map(), new Map(), new Set(["gateway"]));

  assert.deepEqual(result.skippedProviderIds, ["gateway"]);
});
