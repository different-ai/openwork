import { describe, expect, test } from "bun:test";

import { createInputSupportResolver, encodedSize, inputSupportFromCatalog, nativePdfPolicy, TEXT_ONLY } from "./capabilities.js";

const v1Catalog = {
  data: {
    all: [
      {
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-sonnet": { id: "claude-sonnet", attachment: true, limit: { context: 200000, output: 8192 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } },
        },
      },
      {
        id: "ollama",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "llama-vision": { id: "llama-vision", attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
          "llama-text": { id: "llama-text", attachment: false, modalities: { input: ["text"], output: ["text"] } },
          "legacy-attachment-only": { id: "legacy-attachment-only", attachment: true },
        },
      },
    ],
    default: {},
    connected: ["anthropic"],
  },
};

const v2Catalog = {
  all: [
    {
      id: "google",
      models: {
        "gemini": {
          id: "gemini",
          api: { id: "gemini", url: "", npm: "@ai-sdk/google" },
          limit: { context: 1048576, output: 65536 },
          capabilities: { attachment: true, input: { text: true, audio: false, image: true, video: false, pdf: true }, output: { text: true, audio: false, image: false, video: false, pdf: false } },
        },
        "gemma-text": {
          id: "gemma-text",
          api: { id: "gemma-text", url: "", npm: "@ai-sdk/google" },
          capabilities: { attachment: false, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false } },
        },
      },
    },
  ],
};

describe("model input support", () => {
  test("reads the modalities list shape", () => {
    expect(inputSupportFromCatalog(v1Catalog, "anthropic", "claude-sonnet")).toEqual({ pdf: true, image: true, known: true, npm: "@ai-sdk/anthropic", contextTokens: 200000 });
    expect(inputSupportFromCatalog(v1Catalog, "ollama", "llama-vision")).toEqual({ pdf: false, image: true, known: true, npm: "@ai-sdk/openai-compatible", contextTokens: null });
    expect(inputSupportFromCatalog(v1Catalog, "ollama", "llama-text")).toEqual({ pdf: false, image: false, known: true, npm: "@ai-sdk/openai-compatible", contextTokens: null });
  });

  test("reads the capabilities.input shape", () => {
    expect(inputSupportFromCatalog(v2Catalog, "google", "gemini")).toEqual({ pdf: true, image: true, known: true, npm: "@ai-sdk/google", contextTokens: 1048576 });
    expect(inputSupportFromCatalog(v2Catalog, "google", "gemma-text")).toEqual({ pdf: false, image: false, known: true, npm: "@ai-sdk/google", contextTokens: null });
  });

  test("falls back to the attachment flag as image-only, never as PDF support", () => {
    expect(inputSupportFromCatalog(v1Catalog, "ollama", "legacy-attachment-only")).toEqual({ pdf: false, image: true, known: true, npm: "@ai-sdk/openai-compatible", contextTokens: null });
  });

  test("treats unknown providers, models, and malformed catalogs as text-only", () => {
    expect(inputSupportFromCatalog(v1Catalog, "anthropic", "missing")).toEqual(TEXT_ONLY);
    expect(inputSupportFromCatalog(v1Catalog, "missing", "claude-sonnet")).toEqual(TEXT_ONLY);
    expect(inputSupportFromCatalog(null, "anthropic", "claude-sonnet")).toEqual(TEXT_ONLY);
    expect(inputSupportFromCatalog({ data: { error: "boom" } }, "anthropic", "claude-sonnet")).toEqual(TEXT_ONLY);
  });

  test("native policy follows documented provider limits and stays conservative elsewhere", () => {
    const base = nativePdfPolicy(null);
    expect(base).toEqual({ requestBytes: 32 * 1024 * 1024, requestHeadroomBytes: 4 * 1024 * 1024, maxPages: 100, maxRawBytes: 10 * 1024 * 1024, contextShare: 0.35, tokensPerPage: 2_000 });
    expect(nativePdfPolicy("@ai-sdk/openai", 400_000)).toEqual(base);
    expect(nativePdfPolicy("@ai-sdk/anthropic", 200_000)).toEqual({ ...base, tokensPerPage: 2_300 });
    expect(nativePdfPolicy("@ai-sdk/anthropic", 1_000_000)).toEqual({ ...base, tokensPerPage: 2_300, maxPages: 600 });
    expect(nativePdfPolicy("@ai-sdk/google")).toEqual({ ...base, requestBytes: 20 * 1024 * 1024, maxPages: 1000, tokensPerPage: 258 });
  });

  test("encoded size accounts for base64 growth", () => {
    expect(encodedSize(3)).toBe(4);
    expect(encodedSize(4)).toBe(8);
    expect(encodedSize(9 * 1024 * 1024)).toBe(12 * 1024 * 1024);
  });
});

describe("input support resolver", () => {
  test("loads the catalog once per TTL and shares one in-flight read", async () => {
    let calls = 0;
    let clock = 1_000;
    const resolver = createInputSupportResolver(async () => {
      calls += 1;
      return v1Catalog;
    }, () => clock);

    const [first, second] = await Promise.all([
      resolver.resolve("anthropic", "claude-sonnet"),
      resolver.resolve("ollama", "llama-text"),
    ]);
    expect(first.pdf).toBe(true);
    expect(second.pdf).toBe(false);
    expect(calls).toBe(1);

    clock += 60_000;
    await resolver.resolve("anthropic", "claude-sonnet");
    expect(calls).toBe(1);

    clock += 5 * 60_000;
    await resolver.resolve("anthropic", "claude-sonnet");
    expect(calls).toBe(2);
  });

  test("a failed catalog read yields text-only and is retried shortly after", async () => {
    let calls = 0;
    let clock = 0;
    const resolver = createInputSupportResolver(async () => {
      calls += 1;
      if (calls === 1) throw new Error("engine not ready");
      return v1Catalog;
    }, () => clock);

    expect(await resolver.resolve("anthropic", "claude-sonnet")).toEqual(TEXT_ONLY);
    expect(await resolver.resolve("anthropic", "claude-sonnet")).toEqual(TEXT_ONLY);
    expect(calls).toBe(1);

    clock += 31_000;
    expect((await resolver.resolve("anthropic", "claude-sonnet")).pdf).toBe(true);
    expect(calls).toBe(2);
  });
});
