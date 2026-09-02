import { describe, expect, test } from "bun:test";

import { createInputSupportResolver, inputSupportFromCatalog, nativePdfLimits, TEXT_ONLY } from "./capabilities.js";

const v1Catalog = {
  data: {
    all: [
      {
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-sonnet": { id: "claude-sonnet", attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] } },
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
    expect(inputSupportFromCatalog(v1Catalog, "anthropic", "claude-sonnet")).toEqual({ pdf: true, image: true, known: true, npm: "@ai-sdk/anthropic" });
    expect(inputSupportFromCatalog(v1Catalog, "ollama", "llama-vision")).toEqual({ pdf: false, image: true, known: true, npm: "@ai-sdk/openai-compatible" });
    expect(inputSupportFromCatalog(v1Catalog, "ollama", "llama-text")).toEqual({ pdf: false, image: false, known: true, npm: "@ai-sdk/openai-compatible" });
  });

  test("reads the capabilities.input shape", () => {
    expect(inputSupportFromCatalog(v2Catalog, "google", "gemini")).toEqual({ pdf: true, image: true, known: true, npm: "@ai-sdk/google" });
    expect(inputSupportFromCatalog(v2Catalog, "google", "gemma-text")).toEqual({ pdf: false, image: false, known: true, npm: "@ai-sdk/google" });
  });

  test("falls back to the attachment flag as image-only, never as PDF support", () => {
    expect(inputSupportFromCatalog(v1Catalog, "ollama", "legacy-attachment-only")).toEqual({ pdf: false, image: true, known: true, npm: "@ai-sdk/openai-compatible" });
  });

  test("treats unknown providers, models, and malformed catalogs as text-only", () => {
    expect(inputSupportFromCatalog(v1Catalog, "anthropic", "missing")).toEqual(TEXT_ONLY);
    expect(inputSupportFromCatalog(v1Catalog, "missing", "claude-sonnet")).toEqual(TEXT_ONLY);
    expect(inputSupportFromCatalog(null, "anthropic", "claude-sonnet")).toEqual(TEXT_ONLY);
    expect(inputSupportFromCatalog({ data: { error: "boom" } }, "anthropic", "claude-sonnet")).toEqual(TEXT_ONLY);
  });

  test("native limits stay conservative except where the provider documents more", () => {
    expect(nativePdfLimits("@ai-sdk/anthropic")).toEqual({ maxBytes: 30 * 1024 * 1024, maxPages: 100 });
    expect(nativePdfLimits(null)).toEqual({ maxBytes: 30 * 1024 * 1024, maxPages: 100 });
    expect(nativePdfLimits("@ai-sdk/google")).toEqual({ maxBytes: 20 * 1024 * 1024, maxPages: 1000 });
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
