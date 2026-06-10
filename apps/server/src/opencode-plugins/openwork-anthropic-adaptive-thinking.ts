/**
 * OpenWork Anthropic Adaptive Thinking Plugin
 *
 * Newer Anthropic models (Claude 5 family, e.g. "claude-fable-5") reject the
 * legacy extended-thinking payload `thinking: { type: "enabled", budgetTokens }`
 * with:
 *
 *   "thinking.type.enabled" is not supported for this model. Use
 *   "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
 *
 * The bundled OpenCode sidecar only emits the adaptive shape for model ids it
 * recognizes (Opus 4.6/4.7+, Sonnet 4.6). For newer ids it falls back to the
 * legacy shape, which fails. This plugin rewrites the legacy payload to
 * `thinking: { type: "adaptive" }` plus an `effort` level for models that
 * require it, just before the request is sent.
 */

const LEGACY_HIGH_BUDGET_TOKENS = 16000;

/**
 * Claude ids with a bare major version of 5 or higher (e.g. "claude-fable-5",
 * "claude-opus-5") require adaptive thinking. Versioned 4.x ids
 * ("claude-sonnet-4-5", "claude-opus-4-6") never match major >= 5 here;
 * the ones that support adaptive already get it from the sidecar.
 */
function requiresAdaptiveThinking(apiId: string): boolean {
  const match = /claude-[a-z]+-(\d+)(?:[.@-]|$)/i.exec(apiId);
  if (!match) return false;
  return Number(match[1]) >= 5;
}

function readBudgetTokens(thinking: Record<string, unknown>): number | null {
  const budget = thinking.budgetTokens;
  return typeof budget === "number" ? budget : null;
}

function rewriteLegacyThinkingOptions(apiId: string, options: Record<string, unknown>): void {
  const thinking = options.thinking;
  if (typeof thinking !== "object" || thinking === null || Array.isArray(thinking)) return;
  const record: Record<string, unknown> = { ...thinking };
  if (record.type !== "enabled") return;
  if (!requiresAdaptiveThinking(apiId)) return;
  const budget = readBudgetTokens(record);
  options.thinking = { type: "adaptive" };
  if (options.effort === undefined) {
    options.effort = budget !== null && budget > LEGACY_HIGH_BUDGET_TOKENS ? "max" : "high";
  }
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkAnthropicAdaptiveThinking = async () => ({
  "chat.params": async (
    input: { model: { id: string; api?: { id?: string } } },
    output: { options: Record<string, unknown> },
  ) => {
    const apiId = input.model.api?.id ?? input.model.id;
    rewriteLegacyThinkingOptions(apiId, output.options);
  },
});
