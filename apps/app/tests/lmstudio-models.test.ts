import { describe, expect, test } from "bun:test";

import {
  enrichProviderListWithLiveLMStudioModels,
  isLikelyEmbeddingModelId,
  parseLMStudioNativeModelsResponse,
  parseLMStudioOpenAIModelsResponse,
  reconcileLMStudioSelectedModel,
} from "../src/react-app/domains/settings/lmstudio-models";

describe("lmstudio model parsing", () => {
  test("parses native models and drops embeddings", () => {
    const models = parseLMStudioNativeModelsResponse({
      data: [
        { id: "google/gemma-4-12b", type: "llm", max_context_length: 8192 },
        { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings" },
      ],
    });

    expect(models).toEqual([
      {
        id: "google/gemma-4-12b",
        type: "llm",
        state: undefined,
        maxContextLength: 8192,
      },
    ]);
  });

  test("filters likely embedding models from the OpenAI-compatible fallback", () => {
    const models = parseLMStudioOpenAIModelsResponse({
      data: [
        { id: "liquid/lfm2.5-1.2b" },
        { id: "text-embedding-nomic-embed-text-v1.5" },
      ],
    });

    expect(models).toEqual([{ id: "liquid/lfm2.5-1.2b" }]);
  });

  test("detects embedding-like model ids", () => {
    expect(isLikelyEmbeddingModelId("text-embedding-nomic-embed-text-v1.5")).toBe(true);
    expect(isLikelyEmbeddingModelId("google/gemma-4-12b")).toBe(false);
  });

  test("reselects the first live model when the previous selection disappears", () => {
    expect(
      reconcileLMStudioSelectedModel("qwen/qwen3-coder-30b", [
        { id: "google/gemma-4-12b" },
        { id: "liquid/lfm2.5-1.2b" },
      ]),
    ).toBe("google/gemma-4-12b");
  });
});

describe("lmstudio provider list enrichment", () => {
  test("replaces static catalog models with live LM Studio models", async () => {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "google/gemma-4-12b", type: "llm" },
              { id: "liquid/lfm2.5-1.2b", type: "llm" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const enriched = await enrichProviderListWithLiveLMStudioModels(
      {
        connected: ["lmstudio"],
        default: {},
        all: [
          {
            id: "lmstudio",
            name: "LMStudio",
            source: "builtin",
            models: {
              "openai/gpt-oss-20b": { name: "GPT OSS 20B" },
              "qwen/qwen3-30b-a3b-2507": { name: "Qwen3 30B A3B 2507" },
            },
          },
        ],
      },
      fetchImpl,
    );

    expect(Object.keys(enriched.all[0]?.models ?? {})).toEqual([
      "google/gemma-4-12b",
      "liquid/lfm2.5-1.2b",
    ]);
  });
});
