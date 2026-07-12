import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { ProviderListItem } from "@/app/types";

import { LMSTUDIO_PROVIDER_CONFIG } from "./openai-image-extension";

export const LMSTUDIO_PROVIDER_ID = LMSTUDIO_PROVIDER_CONFIG.providerId;

/** Base URL for the LM Studio server without the trailing OpenAI "/v1" segment. */
export const LMSTUDIO_BASE_URL = LMSTUDIO_PROVIDER_CONFIG.baseURL.replace(/\/v1\/?$/, "");

/** A model entry surfaced by the LM Studio local server. */
export type LMStudioModel = {
  id: string;
  /** "llm" | "vlm" | "embeddings" from the native /api/v0/models endpoint. */
  type?: string;
  state?: string;
  maxContextLength?: number;
};

export type LMStudioFetchResult = {
  status: "running" | "unreachable";
  models: LMStudioModel[];
};

type FetchLike = typeof fetch;

export function isLikelyEmbeddingModelId(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized.includes("embed") ||
    normalized.includes("embedding") ||
    normalized.includes("nomic-embed")
  );
}

export function parseLMStudioNativeModelsResponse(data: unknown): LMStudioModel[] {
  const entries = Array.isArray((data as { data?: unknown })?.data)
    ? (data as { data: Array<Record<string, unknown>> }).data
    : [];

  return entries
    .map((entry): LMStudioModel => ({
      id: String(entry.id ?? ""),
      type: typeof entry.type === "string" ? entry.type : undefined,
      state: typeof entry.state === "string" ? entry.state : undefined,
      maxContextLength:
        typeof entry.max_context_length === "number" ? entry.max_context_length : undefined,
    }))
    .filter((model) => model.id && model.type !== "embeddings");
}

export function parseLMStudioOpenAIModelsResponse(data: unknown): LMStudioModel[] {
  const entries = Array.isArray((data as { data?: unknown })?.data)
    ? (data as { data: Array<Record<string, unknown>> }).data
    : [];

  return entries
    .map((entry): LMStudioModel => ({ id: String(entry.id ?? "") }))
    .filter((model) => model.id && !isLikelyEmbeddingModelId(model.id));
}

/**
 * Fetch models from the running LM Studio instance.
 *
 * Prefers `/api/v0/models` (type + load state) and falls back to the
 * OpenAI-compatible `/v1/models` endpoint on older builds.
 */
export async function fetchLMStudioModels(
  fetchImpl: FetchLike = fetch,
): Promise<LMStudioFetchResult> {
  try {
    const response = await fetchImpl(`${LMSTUDIO_BASE_URL}/api/v0/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = await response.json();
      const models = parseLMStudioNativeModelsResponse(data);
      return { status: "running", models };
    }
  } catch {
    // Fall through to the OpenAI-compatible endpoint below.
  }

  try {
    const response = await fetchImpl(`${LMSTUDIO_PROVIDER_CONFIG.baseURL}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { status: "unreachable", models: [] };
    }
    const data = await response.json();
    const models = parseLMStudioOpenAIModelsResponse(data);
    return { status: "running", models };
  } catch {
    return { status: "unreachable", models: [] };
  }
}

export function buildLMStudioProviderModelsRecord(
  existingModels: ProviderListItem["models"],
  models: LMStudioModel[],
): ProviderListItem["models"] {
  const template = Object.values(existingModels)[0];
  if (!template) {
    return existingModels;
  }

  const merged: ProviderListItem["models"] = {};
  for (const model of models) {
    const current = existingModels[model.id];
    merged[model.id] = current ?? {
      ...template,
      id: model.id,
      name: model.id,
    };
  }
  return merged;
}

export function reconcileLMStudioSelectedModel(
  selectedModel: string,
  models: LMStudioModel[],
) {
  if (models.length === 0) {
    return "";
  }
  if (selectedModel && models.some((model) => model.id === selectedModel)) {
    return selectedModel;
  }
  return models[0]?.id ?? "";
}

/**
 * Replace the static models.dev catalog for a connected LM Studio provider
 * with the models reported by the local LM Studio server.
 */
export async function enrichProviderListWithLiveLMStudioModels(
  value: ProviderListResponse,
  fetchImpl?: FetchLike,
): Promise<ProviderListResponse> {
  const connected = new Set(value.connected ?? []);
  if (!connected.has(LMSTUDIO_PROVIDER_ID)) {
    return value;
  }

  const live = await fetchLMStudioModels(fetchImpl);
  if (live.status !== "running" || live.models.length === 0) {
    return value;
  }

  return {
    ...value,
    all: (value.all ?? []).map((provider) => {
      if (provider.id !== LMSTUDIO_PROVIDER_ID) {
        return provider;
      }
      return {
        ...provider,
        models: buildLMStudioProviderModelsRecord(provider.models ?? {}, live.models),
      };
    }),
  };
}
