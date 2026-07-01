import { applyEdits, modify } from "jsonc-parser";

/**
 * Pure helpers for user-defined custom providers (any OpenAI-compatible
 * endpoint such as Azure AI Foundry, LiteLLM, vLLM, Ollama). These write a
 * `provider.<id>` block into the workspace `opencode.jsonc` so users no
 * longer have to hand-edit the file (or paste JSON into Cloud).
 */

export type CustomProviderInput = {
  providerId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  modelIds: string[];
};

export const CUSTOM_PROVIDER_NPM = "@ai-sdk/openai-compatible";

export const slugifyProviderId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const isValidCustomProviderId = (value: string) =>
  /^[a-z0-9][a-z0-9_-]*$/i.test(value);

export type NormalizedCustomProvider = {
  providerId: string;
  name: string;
  baseURL: string;
  apiKey: string;
  modelIds: string[];
};

export const normalizeCustomProviderInput = (
  input: CustomProviderInput,
): NormalizedCustomProvider => {
  const providerId = input.providerId.trim();
  return {
    providerId,
    name: input.name.trim() || providerId,
    baseURL: input.baseURL.trim().replace(/\/+$/, ""),
    apiKey: input.apiKey.trim(),
    modelIds: [
      ...new Set(input.modelIds.map((id) => id.trim()).filter(Boolean)),
    ],
  };
};

export const validateCustomProviderInput = (
  input: NormalizedCustomProvider,
): string | null => {
  if (!input.providerId) return "Provider ID is required.";
  if (!isValidCustomProviderId(input.providerId)) {
    return "Provider ID can only contain letters, numbers, dashes, and underscores.";
  }
  if (!input.baseURL) return "Base URL is required.";
  if (!/^https?:\/\//i.test(input.baseURL)) {
    return "Base URL must start with http:// or https://";
  }
  if (input.modelIds.length === 0) return "At least one model ID is required.";
  return null;
};

export const buildCustomProviderConfig = (input: NormalizedCustomProvider) => ({
  npm: CUSTOM_PROVIDER_NPM,
  name: input.name,
  options: { baseURL: input.baseURL },
  models: Object.fromEntries(
    input.modelIds.map((modelId) => [modelId, { name: modelId }]),
  ),
});

export const formatConfigWithCustomProvider = (
  raw: string,
  input: NormalizedCustomProvider,
) => {
  const base = raw.trim()
    ? raw
    : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const edits = modify(
    base,
    ["provider", input.providerId],
    buildCustomProviderConfig(input),
    { formattingOptions: { insertSpaces: true, tabSize: 2 } },
  );
  const updated = applyEdits(base, edits);
  return updated.endsWith("\n") ? updated : `${updated}\n`;
};
