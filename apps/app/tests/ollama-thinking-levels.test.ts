import { afterEach, expect, test } from "bun:test";
import { nativeModelVariants } from "@openwork/types/cloud-model-fast";
import {
  buildLocalProviderConfig,
  buildLocalProviderInstallPatch,
  fetchOllamaModelCapabilities,
  parseOllamaThinkingLevels,
} from "../src/react-app/domains/settings/openai-image-extension.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("keeps the thinking levels Ollama reports, in its order", () => {
  expect(parseOllamaThinkingLevels({ thinking: { values: ["none", "low", "high", "max"], default: "high" } }))
    .toEqual(["none", "low", "high", "max"]);
  expect(parseOllamaThinkingLevels({ thinking: { values: ["low", "medium", "high"] } })).toEqual(["low", "medium", "high"]);
});

test("maps boolean thinking controls to the efforts Ollama accepts", () => {
  expect(parseOllamaThinkingLevels({ thinking: { values: [false, true] } })).toEqual(["none", "high"]);
  expect(parseOllamaThinkingLevels({ thinking: { values: [true, "high", false] } })).toEqual(["high", "none"]);
});

test("offers no levels when the model cannot think or reports nothing usable", () => {
  expect(parseOllamaThinkingLevels({ thinking: { values: [false] } })).toEqual([]);
  expect(parseOllamaThinkingLevels({ capabilities: ["completion", "tools"] })).toEqual([]);
  expect(parseOllamaThinkingLevels({ thinking: { values: "high" } })).toEqual([]);
  expect(parseOllamaThinkingLevels({ thinking: { values: [3, "", "__proto__", "a b", "x".repeat(40)] } })).toEqual([]);
  expect(parseOllamaThinkingLevels(null)).toEqual([]);
});

test("writes each level as a variant the engine sends as reasoning_effort", () => {
  const provider = buildLocalProviderConfig({
    providerId: "ollama",
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    modelId: " gemma4 ",
    modelName: "gemma4",
    setDefault: true,
    supportsVision: true,
    thinkingLevels: ["none", "high"],
  });
  const model = provider.models?.gemma4;
  expect(model?.variants).toEqual({ none: { reasoningEffort: "none" }, high: { reasoningEffort: "high" } });
  expect(model?.attachment).toBe(true);
  expect(nativeModelVariants(model?.variants, "@opencode-ai/ai/providers/openai-compatible")).toEqual([
    { id: "none", settings: { providerOptions: { reasoningEffort: "none" } } },
    { id: "high", settings: { providerOptions: { reasoningEffort: "high" } } },
  ]);
});

test("models without thinking levels keep the previous config", () => {
  const provider = buildLocalProviderConfig({
    providerId: "ollama",
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    modelId: "qwen2.5-coder:7b",
    modelName: "qwen2.5-coder:7b",
    setDefault: true,
    supportsVision: false,
  });
  expect(provider.models?.["qwen2.5-coder:7b"]).toEqual({
    name: "qwen2.5-coder:7b",
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
  });
});

test("asks the server to keep the Ollama models added earlier", () => {
  const patch = buildLocalProviderInstallPatch({
    providerId: "ollama",
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    modelId: "gpt-oss:120b",
    modelName: "gpt-oss:120b",
    setDefault: false,
    supportsVision: false,
    thinkingLevels: ["low", "medium", "high"],
  });
  expect(patch.mergeProviderModels).toEqual(["ollama"]);
  expect(Object.keys(patch.opencode.provider.ollama.models ?? {})).toEqual(["gpt-oss:120b"]);
});

test("reads vision and thinking from one /api/show call", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ capabilities: ["completion", "vision", "thinking"], thinking: { values: ["low", "high", "max"] } });
  }, { preconnect: originalFetch.preconnect });

  expect(await fetchOllamaModelCapabilities("glm-5.3", "http://localhost:11434/v1"))
    .toEqual({ supportsVision: true, thinkingLevels: ["low", "high", "max"] });
  expect(requests).toEqual([{ url: "http://localhost:11434/api/show", body: { model: "glm-5.3" } }]);
});

test("an unreachable Ollama adds the model without vision or levels", async () => {
  globalThis.fetch = Object.assign(async () => {
    throw new TypeError("fetch failed");
  }, { preconnect: originalFetch.preconnect });
  expect(await fetchOllamaModelCapabilities("gemma4", "http://localhost:11434/v1"))
    .toEqual({ supportsVision: false, thinkingLevels: [] });
});
