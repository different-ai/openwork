/**
 * Default model recommendation constants.
 *
 * These are hardcoded client-side defaults. If a server-side API is added
 * later, these should be replaced by the server response.
 *
 * To add or remove recommended models, edit this file.
 */

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
 * Check if a model is in the recommended list.
 */
export function isRecommendedModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return RECOMMENDED_MODEL_PATTERNS.some((p) => lower.includes(p));
}
