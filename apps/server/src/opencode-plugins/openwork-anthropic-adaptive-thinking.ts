const LEGACY_HIGH_BUDGET_TOKENS = 16000;

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

export const OpenWorkAnthropicAdaptiveThinking = async () => ({
  "chat.params": async (
    input: { model: { id: string; api?: { id?: string } } },
    output: { options: Record<string, unknown> },
  ) => {
    const apiId = input.model.api?.id ?? input.model.id;
    rewriteLegacyThinkingOptions(apiId, output.options);
  },
});
