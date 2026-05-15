/**
 * Default model visibility and recommendation constants.
 *
 * These are hardcoded client-side defaults that can be overridden by the
 * user via the "Available models" tab in the model picker (persisted to
 * localStorage). There is no server-side API for these — if one is added
 * later, these should be replaced by the server response.
 *
 * To add or remove models from the defaults, edit this file.
 */

/**
 * Models visible by default for providers with large model catalogs.
 * Everything else from these providers is hidden on first run.
 *
 * Key: provider ID (lowercase).
 * Value: array of model ID substrings — a model is visible if its ID
 * contains any of these patterns.
 *
 * Providers not listed here show ALL their models by default.
 */
export const DEFAULT_VISIBLE_MODELS: Record<string, string[]> = {
  openai: [
    "gpt-5.5",
    "gpt-5.4",
    "o3",
    "o4-mini",
    "gpt-4o",
  ],
  anthropic: [
    "claude-opus-4-6",
    "claude-sonnet-4-7",
  ],
};

/**
 * Models considered "recommended" and shown with a star icon at the top
 * of each provider's model list in the picker.
 *
 * These are model ID substrings (case-insensitive match).
 */
export const RECOMMENDED_MODEL_PATTERNS: string[] = [
  "claude-opus-4",
  "gpt-5.5",
  "kimi-k2.6",
];

/**
 * Check if a model should be visible by default for its provider.
 * Returns true if the provider has no curated list (show everything)
 * or if the model ID matches one of the curated patterns.
 */
export function isDefaultVisibleModel(providerId: string, modelId: string): boolean {
  const patterns = DEFAULT_VISIBLE_MODELS[providerId.toLowerCase()];
  if (!patterns) return true;
  const lower = modelId.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Check if a model is in the recommended list.
 */
export function isRecommendedModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return RECOMMENDED_MODEL_PATTERNS.some((p) => lower.includes(p));
}
