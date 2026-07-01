import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import {
  buildCustomProviderConfig,
  formatConfigWithCustomProvider,
  normalizeCustomProviderInput,
  slugifyProviderId,
  validateCustomProviderInput,
} from "../src/react-app/domains/connections/provider-auth/custom-provider-config";

const input = (overrides: Partial<Parameters<typeof normalizeCustomProviderInput>[0]> = {}) =>
  normalizeCustomProviderInput({
    providerId: "azure-foundry",
    name: "Azure AI Foundry",
    baseURL: "https://my-resource.openai.azure.com/openai/v1",
    apiKey: "sk-test",
    modelIds: ["gpt-5.2", "my-deployment"],
    ...overrides,
  });

describe("slugifyProviderId", () => {
  test("derives a config-safe id from a display name", () => {
    expect(slugifyProviderId("Azure AI Foundry")).toBe("azure-ai-foundry");
    expect(slugifyProviderId("  My_Provider!! ")).toBe("my-provider");
  });
});

describe("normalizeCustomProviderInput", () => {
  test("trims, dedupes models, and strips trailing slash from baseURL", () => {
    const normalized = input({
      baseURL: " https://example.com/v1/ ",
      modelIds: [" a ", "a", "", "b"],
      name: "  ",
    });
    expect(normalized.baseURL).toBe("https://example.com/v1");
    expect(normalized.modelIds).toEqual(["a", "b"]);
    expect(normalized.name).toBe("azure-foundry");
  });
});

describe("validateCustomProviderInput", () => {
  test("accepts a valid input", () => {
    expect(validateCustomProviderInput(input())).toBeNull();
  });

  test("rejects missing or malformed fields", () => {
    expect(validateCustomProviderInput(input({ providerId: "" }))).toContain("Provider ID");
    expect(validateCustomProviderInput(input({ providerId: "bad id!" }))).toContain("Provider ID");
    expect(validateCustomProviderInput(input({ baseURL: "" }))).toContain("Base URL");
    expect(validateCustomProviderInput(input({ baseURL: "ftp://x" }))).toContain("http");
    expect(validateCustomProviderInput(input({ modelIds: [] }))).toContain("model");
  });
});

describe("formatConfigWithCustomProvider", () => {
  test("writes an openai-compatible provider block into an empty config", () => {
    const updated = formatConfigWithCustomProvider("", input());
    const parsed = parse(updated) as Record<string, unknown>;
    const provider = (parsed.provider as Record<string, unknown>)["azure-foundry"];
    expect(provider).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Azure AI Foundry",
      options: { baseURL: "https://my-resource.openai.azure.com/openai/v1" },
      models: {
        "gpt-5.2": { name: "gpt-5.2" },
        "my-deployment": { name: "my-deployment" },
      },
    });
  });

  test("preserves existing config content and comments", () => {
    const raw = [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      "  // keep me",
      '  "provider": {',
      '    "ollama": { "npm": "@ai-sdk/openai-compatible", "name": "Ollama" }',
      "  }",
      "}",
      "",
    ].join("\n");
    const updated = formatConfigWithCustomProvider(raw, input());
    expect(updated).toContain("// keep me");
    const parsed = parse(updated) as Record<string, unknown>;
    const providers = parsed.provider as Record<string, unknown>;
    expect(Object.keys(providers).sort()).toEqual(["azure-foundry", "ollama"]);
  });

  test("is idempotent for the same provider", () => {
    const once = formatConfigWithCustomProvider("", input());
    const twice = formatConfigWithCustomProvider(once, input());
    expect(parse(twice)).toEqual(parse(once));
  });
});

describe("buildCustomProviderConfig", () => {
  test("uses the model id as the display name", () => {
    const config = buildCustomProviderConfig(input({ modelIds: ["m1"] }));
    expect(config.models).toEqual({ m1: { name: "m1" } });
  });
});
