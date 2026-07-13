import { describe, expect, test } from "bun:test";

import {
  buildLocalProviderConfig,
  fetchOllamaModelSupportsVision,
  parseOllamaVisionCapability,
  type LocalProviderInstallInput,
} from "../src/react-app/domains/settings/openai-image-extension";

function providerInput(supportsVision: boolean): LocalProviderInstallInput {
  return {
    providerId: "ollama",
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    modelId: "llava:latest",
    modelName: "llava:latest",
    setDefault: true,
    supportsVision,
  };
}

describe("Ollama local provider config", () => {
  test("parses vision capabilities from /api/show payloads", () => {
    expect(parseOllamaVisionCapability({ capabilities: ["completion", "vision"] })).toBe(true);
    expect(parseOllamaVisionCapability({ capabilities: ["completion"] })).toBe(false);
    expect(parseOllamaVisionCapability({ capabilities: ["completion", "pdf"] })).toBe(false);
  });

  test("treats /api/show failures as non-vision", async () => {
    const originalFetch = globalThis.fetch;
    const failingFetch: typeof fetch = () => Promise.reject(new Error("offline"));
    globalThis.fetch = failingFetch;
    try {
      expect(await fetchOllamaModelSupportsVision("llava:latest", "http://localhost:11434/v1")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("vision models declare text and image input without PDF support", () => {
    const config = buildLocalProviderConfig(providerInput(true));
    const model = config.models?.["llava:latest"];
    const inputModalities = model?.modalities?.input ?? [];

    expect(model?.attachment).toBe(true);
    expect(inputModalities).toEqual(["text", "image"]);
    expect(inputModalities).not.toContain("pdf");
  });

  test("non-vision models stay text-only without PDF support", () => {
    const config = buildLocalProviderConfig(providerInput(false));
    const model = config.models?.["llava:latest"];
    const inputModalities = model?.modalities?.input ?? [];

    expect(model?.attachment).toBe(false);
    expect(inputModalities).toEqual(["text"]);
    expect(inputModalities).not.toContain("pdf");
  });
});
