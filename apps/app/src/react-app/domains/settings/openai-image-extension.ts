import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

export type LocalProviderInstallInput = {
  providerId: string;
  name: string;
  baseURL: string;
  modelId: string;
  modelName: string;
  setDefault: boolean;
  supportsVision: boolean;
  thinkingLevels?: string[];
};

type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[string];

export const OLLAMA_PROVIDER_CONFIG = {
  providerId: "ollama",
  name: "Ollama (local)",
  baseURL: "http://localhost:11434/v1",
  defaultModelId: "qwen2.5-coder:7b",
};

export type OllamaModelCapabilities = {
  supportsVision: boolean;
  thinkingLevels: string[];
};

const NO_OLLAMA_CAPABILITIES: OllamaModelCapabilities = { supportsVision: false, thinkingLevels: [] };

const THINKING_LEVEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function readProperty(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function parseOllamaVisionCapability(payload: unknown) {
  const capabilities = readProperty(payload, "capabilities");
  if (!Array.isArray(capabilities)) return false;
  return capabilities.some((capability) => typeof capability === "string" && capability.toLowerCase() === "vision");
}

export function parseOllamaThinkingLevels(payload: unknown): string[] {
  const values = readProperty(readProperty(payload, "thinking"), "values");
  if (!Array.isArray(values)) return [];
  const levels: string[] = [];
  for (const value of values) {
    const level = value === true ? "high" : value === false ? "none" : typeof value === "string" ? value.trim() : "";
    if (THINKING_LEVEL_PATTERN.test(level) && !levels.includes(level)) levels.push(level);
  }
  return levels.some((level) => level !== "none") ? levels : [];
}

export function parseOllamaModelCapabilities(payload: unknown): OllamaModelCapabilities {
  return {
    supportsVision: parseOllamaVisionCapability(payload),
    thinkingLevels: parseOllamaThinkingLevels(payload),
  };
}

export async function fetchOllamaModelCapabilities(modelId: string, baseURL: string): Promise<OllamaModelCapabilities> {
  try {
    const response = await fetch(`${baseURL.replace(/\/v1\/?$/, "")}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return NO_OLLAMA_CAPABILITIES;
    const payload: unknown = await response.json();
    return parseOllamaModelCapabilities(payload);
  } catch {
    return NO_OLLAMA_CAPABILITIES;
  }
}

export type LocalProviderModelInput = Pick<LocalProviderInstallInput, "modelId" | "modelName" | "supportsVision" | "thinkingLevels">;

export type LocalProviderSyncInput = Pick<LocalProviderInstallInput, "providerId" | "name" | "baseURL"> & {
  models: LocalProviderModelInput[];
};

export function buildLocalProviderModelConfig(input: LocalProviderModelInput): ProviderModelConfig {
  const thinkingLevels = input.thinkingLevels ?? [];
  return {
    name: input.modelName.trim() || input.modelId,
    attachment: input.supportsVision,
    modalities: {
      input: input.supportsVision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    ...(thinkingLevels.length > 0
      ? { variants: Object.fromEntries(thinkingLevels.map((level) => [level, { reasoningEffort: level }])) }
      : {}),
  };
}

function buildLocalProviderConfigWithModels(input: LocalProviderSyncInput): ProviderConfig {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: input.name,
    options: { baseURL: input.baseURL },
    models: Object.fromEntries(input.models.flatMap((model) => {
      const modelId = model.modelId.trim();
      return modelId ? [[modelId, buildLocalProviderModelConfig({ ...model, modelId })]] : [];
    })),
  };
}

export function buildLocalProviderConfig(input: LocalProviderInstallInput): ProviderConfig {
  return buildLocalProviderConfigWithModels({ ...input, models: [input] });
}

export function buildLocalProviderInstallPatch(input: LocalProviderInstallInput) {
  return {
    opencode: { provider: { [input.providerId]: buildLocalProviderConfig(input) } },
    mergeProviderModels: [input.providerId],
  };
}

export function buildLocalProviderSyncPatch(input: LocalProviderSyncInput) {
  return {
    opencode: { provider: { [input.providerId]: buildLocalProviderConfigWithModels(input) } },
  };
}

export async function fetchOllamaSyncInput(baseURL: string = OLLAMA_PROVIDER_CONFIG.baseURL): Promise<LocalProviderSyncInput | null> {
  let names: string[];
  try {
    const response = await fetch(`${baseURL.replace(/\/v1\/?$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    const models = readProperty(payload, "models");
    if (!Array.isArray(models)) return null;
    names = [...new Set(models.flatMap((model) => {
      const name = readProperty(model, "name");
      return typeof name === "string" && name.trim() ? [name.trim()] : [];
    }))];
  } catch {
    return null;
  }
  const models = await Promise.all(names.map(async (name) => ({
    modelId: name,
    modelName: name,
    ...await fetchOllamaModelCapabilities(name, baseURL),
  })));
  return { providerId: OLLAMA_PROVIDER_CONFIG.providerId, name: OLLAMA_PROVIDER_CONFIG.name, baseURL, models };
}
