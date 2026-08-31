import { expect, test } from "bun:test";

import { mapRuntimeProvidersToV2Specs } from "./engine-v2-preview.js";

test("maps runtime provider fields and models to an OpenCode v2 spec", () => {
  expect(mapRuntimeProvidersToV2Specs({
    example: {
      name: "Example Provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.test/v1", apiKey: "secret" },
      models: {
        "model-b": {},
        "model-a": { name: "Model A" },
      },
    },
  })).toEqual({
    specs: [{
      id: "example",
      name: "Example Provider",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      models: [
        { id: "model-a", name: "Model A" },
        { id: "model-b", name: "model-b" },
      ],
    }],
    skippedProviderIds: [],
  });
});

test("skips providers without a non-empty base URL", () => {
  const result = mapRuntimeProvidersToV2Specs({ missing: { options: { apiKey: "secret" } } });
  expect(result.skippedProviderIds).toEqual(["missing"]);
  expect(result.specs).toEqual([]);
});

test("maps providers without an API key using the preview sentinel", () => {
  expect(mapRuntimeProvidersToV2Specs({
    noKey: { options: { baseURL: "https://example.test/v1" } },
  }).specs).toEqual([{
    id: "noKey",
    name: "noKey",
    baseUrl: "https://example.test/v1",
    apiKey: "openwork-engine-v2-preview-unset",
    models: [],
  }]);
});

test("skips non-record provider values without throwing", () => {
  expect(mapRuntimeProvidersToV2Specs({ array: [], nil: null, number: 42, text: "provider" })).toEqual({
    specs: [],
    skippedProviderIds: ["array", "nil", "number", "text"],
  });
});

test("sorts mapped and skipped provider IDs deterministically", () => {
  const result = mapRuntimeProvidersToV2Specs({
    zebra: { options: { baseURL: "https://zebra.test/v1" } },
    yak: {},
    alpha: { options: { baseURL: "https://alpha.test/v1" } },
    beta: null,
  });
  expect(result.specs.map((spec) => spec.id)).toEqual(["alpha", "zebra"]);
  expect(result.skippedProviderIds).toEqual(["beta", "yak"]);
});
