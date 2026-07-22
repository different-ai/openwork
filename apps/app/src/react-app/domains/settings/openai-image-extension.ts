import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

export type LocalProviderInstallInput = {
  providerId: string;
  name: string;
  baseURL: string;
  modelId: string;
  modelName: string;
  setDefault: boolean;
  supportsVision: boolean;
};

type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[string];

export const OLLAMA_PROVIDER_CONFIG = {
  providerId: "ollama",
  name: "Ollama (local)",
  baseURL: "http://localhost:11434/v1",
  defaultModelId: "qwen2.5-coder:7b",
};

export const OPENAI_IMAGE_EXTENSION_ID = "openai-image-generation";
export const OPENAI_IMAGE_MODEL = "gpt-image-2";

function readProperty(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

export function parseOllamaVisionCapability(payload: unknown) {
  const capabilities = readProperty(payload, "capabilities");
  if (!Array.isArray(capabilities)) return false;
  return capabilities.some((capability) => typeof capability === "string" && capability.toLowerCase() === "vision");
}

export async function fetchOllamaModelSupportsVision(modelId: string, baseURL: string) {
  try {
    const response = await fetch(`${baseURL.replace(/\/v1\/?$/, "")}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return parseOllamaVisionCapability(payload);
  } catch {
    return false;
  }
}

export function buildLocalProviderModelConfig(input: Pick<LocalProviderInstallInput, "modelId" | "modelName" | "supportsVision">): ProviderModelConfig {
  return {
    name: input.modelName.trim() || input.modelId,
    attachment: input.supportsVision,
    modalities: {
      input: input.supportsVision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

export function buildLocalProviderConfig(input: LocalProviderInstallInput): ProviderConfig {
  const modelId = input.modelId.trim();
  return {
    npm: "@ai-sdk/openai-compatible",
    name: input.name,
    options: { baseURL: input.baseURL },
    models: { [modelId]: buildLocalProviderModelConfig({ ...input, modelId }) },
  };
}
