export const INFERENCE_USAGE_CONVERSION_FACTOR = 100_000_000;

export const INFERENCE_WINDOW_TYPES = [
  "five_hour",
  "weekly",
  "monthly",
] as const;
export type InferenceWindowType = (typeof INFERENCE_WINDOW_TYPES)[number];

export const INFERENCE_TIERS = ["tier1", "tier2"] as const;
export type InferenceTier = (typeof INFERENCE_TIERS)[number];

export const INFERENCE_TIER_LIMITS: Record<
  InferenceTier,
  Record<InferenceWindowType, number>
> = {
  tier1: {
    five_hour: 100_000_000,
    weekly: 500_000_000,
    monthly: 1_000_000_000,
  },
  tier2: {
    five_hour: 150_000_000,
    weekly: 750_000_000,
    monthly: 1_500_000_000,
  },
} as const;

export const INFERENCE_RESET_STRATEGIES = [
  "anchored",
  "activity_based",
] as const;
export type InferenceResetStrategy =
  (typeof INFERENCE_RESET_STRATEGIES)[number];

export const INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE: Record<
  InferenceWindowType,
  InferenceResetStrategy
> = {
  five_hour: "activity_based",
  weekly: "anchored",
  monthly: "anchored",
} as const;

export const INFERENCE_WINDOW_DURATIONS_MS: Record<
  InferenceWindowType,
  number
> = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
} as const;

// For upstreamModel values, please get from models.dev/api.json provider = openrouter.models.id

export const INFERENCE_MODEL_ALIASES = {
  "z-ai/glm-5.2": {
    upstreamModel: "z-ai/glm-5.2",
    displayName: "OpenWork: GLM-5.2",
    enabled: true,
    usageFactor: 1,
  },
  "moonshotai/kimi-k2.7-code": {
    upstreamModel: "moonshotai/kimi-k2.7-code",
    displayName: "OpenWork: Kimi K2.7 Code",
    enabled: true,
    usageFactor: 1,
  },
  "tencent/hy3-preview": {
    upstreamModel: "tencent/hy3-preview",
    displayName: "OpenWork: Hy3 preview",
    enabled: true,
    usageFactor: 1,
  },
  "moonshotai/kimi-k2.6": {
    upstreamModel: "moonshotai/kimi-k2.6",
    displayName: "OpenWork: Kimi K2.6",
    enabled: true,
    usageFactor: 1,
  },
  "deepseek/deepseek-v4-flash": {
    upstreamModel: "deepseek/deepseek-v4-flash",
    displayName: "OpenWork: DeepSeek V4 Flash",
    enabled: true,
    usageFactor: 1,
  },
  "minimax/minimax-m2.7": {
    upstreamModel: "minimax/minimax-m2.7",
    displayName: "OpenWork: MiniMax M2.7",
    enabled: true,
    usageFactor: 1,
  },
  "minimax/minimax-m3": {
    upstreamModel: "minimax/minimax-m3",
    displayName: "OpenWork: MiniMax-M3",
    enabled: true,
    usageFactor: 1,
  },
  "z-ai/glm-5.1": {
    upstreamModel: "z-ai/glm-5.1",
    displayName: "OpenWork: GLM-5.1",
    enabled: true,
    usageFactor: 1,
  },
  "moonshotai/kimi-k3": {
    upstreamModel: "moonshotai/kimi-k3",
    displayName: "OpenWork: Kimi K3",
    enabled: true,
    usageFactor: 1,
  },
  "openai/gpt-5.6-luna": {
    upstreamModel: "openai/gpt-5.6-luna",
    displayName: "OpenWork: GPT-5.6 Luna",
    enabled: true,
    usageFactor: 1,
  },
  "openai/gpt-6-astra": {
    upstreamModel: "openai/gpt-6-astra",
    displayName: "OpenWork: GPT-6 Astra",
    enabled: true,
    usageFactor: 1,
  },
} as const;

export type InferenceModelAlias = keyof typeof INFERENCE_MODEL_ALIASES;

export type ManagedModelRecommendation = {
  modelID: string;
  displayName: string;
  providerName: string;
  summary: string;
  recommended: boolean;
  rank: number;
  capabilities: string[];
};

type ManagedModelMetadata = Omit<ManagedModelRecommendation, "modelID" | "displayName">;

// Task captions describe model capabilities, not benchmark rankings. Capabilities
// follow the checked-in managed models; the four defaults were also checked
// against public OpenRouter discovery on 2026-09-08. Keep this outside the
// generated aliases so catalog refreshes preserve presentation choices.
const MANAGED_MODEL_METADATA = new Map<string, ManagedModelMetadata>([
  ["openai/gpt-5.6-luna", {
    providerName: "OpenAI",
    summary: "Everyday questions, writing, and lightweight tasks",
    recommended: true, rank: 1, capabilities: ["reasoning", "tools", "images", "documents"],
  }],
  ["openai/gpt-6-astra", {
    providerName: "OpenAI",
    summary: "Complex analysis, software engineering, and deep research",
    recommended: true, rank: 2, capabilities: ["reasoning", "tools", "images", "documents"],
  }],
  ["moonshotai/kimi-k2.7-code", {
    providerName: "Moonshot AI",
    summary: "Code changes and end-to-end programming tasks",
    recommended: true, rank: 3, capabilities: ["reasoning", "tools", "images"],
  }],
  ["z-ai/glm-5.2", {
    providerName: "Z.ai",
    summary: "Long-running tasks, reasoning, and project-level coding",
    recommended: true, rank: 4, capabilities: ["reasoning", "tools"],
  }],
  ["moonshotai/kimi-k3", {
    providerName: "Moonshot AI",
    summary: "Visual understanding, coding, and planning",
    recommended: false, rank: 5, capabilities: ["reasoning", "tools", "images"],
  }],
  ["minimax/minimax-m3", {
    providerName: "MiniMax",
    summary: "Reasoning with text, images, and video",
    recommended: false, rank: 6, capabilities: ["reasoning", "tools", "images", "video"],
  }],
  ["deepseek/deepseek-v4-flash", {
    providerName: "DeepSeek",
    summary: "Text reasoning and tool-assisted tasks",
    recommended: false, rank: 7, capabilities: ["reasoning", "tools"],
  }],
  ["moonshotai/kimi-k2.6", {
    providerName: "Moonshot AI",
    summary: "Reasoning over text and images with tools",
    recommended: false, rank: 8, capabilities: ["reasoning", "tools", "images"],
  }],
  ["z-ai/glm-5.1", {
    providerName: "Z.ai",
    summary: "Text reasoning and tool-assisted tasks",
    recommended: false, rank: 9, capabilities: ["reasoning", "tools"],
  }],
  ["minimax/minimax-m2.7", {
    providerName: "MiniMax",
    summary: "Text reasoning and tool-assisted tasks",
    recommended: false, rank: 10, capabilities: ["reasoning", "tools"],
  }],
  ["tencent/hy3-preview", {
    providerName: "Tencent",
    summary: "Preview model for text reasoning and tool use",
    recommended: false, rank: 11, capabilities: ["reasoning", "tools"],
  }],
]);

// Discovery metadata is not an entitlement or a provider configuration. Clients
// must intersect this catalog with their currently available, policy-filtered models.
export function managedModelCatalog(options: { freeModelID?: string } = {}): ManagedModelRecommendation[] {
  return Object.entries(INFERENCE_MODEL_ALIASES).flatMap(([modelID, alias]) => {
    const metadata = MANAGED_MODEL_METADATA.get(modelID);
    if (!alias.enabled || !metadata) return [];
    return [{
      modelID,
      displayName: alias.displayName.replace(/^OpenWork: /, ""),
      ...metadata,
      // Free admission accepts text and function tools, not multimodal inputs.
      capabilities: modelID === options.freeModelID
        ? metadata.capabilities.filter((capability) => capability === "reasoning" || capability === "tools")
        : [...metadata.capabilities],
    }];
  }).sort((left, right) => left.rank - right.rank || left.modelID.localeCompare(right.modelID));
}

export type InferenceOrganizationMetadata = {
  enabled: true;
  tier: InferenceTier;
};

export const INFERENCE_FREE_MODEL_ID = "openai/gpt-5.6-luna";
export const INFERENCE_FREE_ENV = {
  enabled: "INFERENCE_FREE_ENABLED",
  weeklyBudgetUsd: "INFERENCE_FREE_WEEKLY_BUDGET_USD",
  modelID: "INFERENCE_FREE_MODEL_ID",
  upstreamApiKey: "INFERENCE_FREE_UPSTREAM_API_KEY",
} as const;

export type FreeInferenceConfig = {
  enabled: boolean;
  weeklyBudgetUsd: number;
  weeklyLimitAmount: number;
  modelID: typeof INFERENCE_FREE_MODEL_ID;
};

// Both Den and inference pass their server environment. Never include credentials
// in this return value. New models require a reviewed reservation pricing policy.
export function readFreeInferenceConfig(environment: Record<string, string | undefined>): FreeInferenceConfig {
  const enabled = environment[INFERENCE_FREE_ENV.enabled] ?? "false";
  if (!["true", "false", "1", "0"].includes(enabled)) {
    throw new Error(`${INFERENCE_FREE_ENV.enabled} must be true, false, 1, or 0`);
  }
  const budget = environment[INFERENCE_FREE_ENV.weeklyBudgetUsd] ?? "1";
  const weeklyBudgetUsd = Number(budget);
  const weeklyLimitAmount = Math.floor(weeklyBudgetUsd * INFERENCE_USAGE_CONVERSION_FACTOR);
  if (!budget.trim() || !Number.isFinite(weeklyBudgetUsd) || weeklyBudgetUsd < 0 || !Number.isSafeInteger(weeklyLimitAmount)) {
    throw new Error(`${INFERENCE_FREE_ENV.weeklyBudgetUsd} must be finite, nonnegative, and representable in inference units`);
  }
  const modelID = environment[INFERENCE_FREE_ENV.modelID] ?? INFERENCE_FREE_MODEL_ID;
  if (modelID !== INFERENCE_FREE_MODEL_ID) {
    throw new Error(`${INFERENCE_FREE_ENV.modelID} must be an approved free model alias`);
  }
  return { enabled: enabled === "true" || enabled === "1", weeklyBudgetUsd: weeklyLimitAmount / INFERENCE_USAGE_CONVERSION_FACTOR, weeklyLimitAmount, modelID };
}

// UTC Monday 00:00 inclusive to the next Monday exclusive; no rollover.
export function freeInferenceWindow(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return { start, end: new Date(start.getTime() + INFERENCE_WINDOW_DURATIONS_MS.weekly) };
}

export const INFERENCE_ACCESS_REASONS = [
  "admin_disabled",
  "not_eligible",
  "free_disabled",
  "accounting_unavailable",
  "free_allowance_exhausted",
  "free_request_in_progress",
  "upstream_unavailable",
] as const;
export type InferenceAccessReason = (typeof INFERENCE_ACCESS_REASONS)[number];
export type InferenceAccess = {
  kind: "paid" | "free" | "exhausted" | "unavailable";
  modelID: string | null;
  weeklyLimitUsd: number | null;
  usedUsd: number | null;
  // Estimated pending cost, not settled usage or a guaranteed maximum charge.
  reservedUsd: number | null;
  remainingUsd: number | null;
  resetsAt: string | null;
  reason: InferenceAccessReason | null;
  canUpgrade?: boolean;
  catalog?: ManagedModelRecommendation[];
  // Current paid tier, or the entry paid tier offered on upgrade. A null price
  // means the configured billing SKU's price must be reviewed on the billing page.
  plan?: { name: string; priceLabel: string | null; usageLabel: string };
};

export function inferencePlanPresentation(tier: InferenceTier = "tier1"): NonNullable<InferenceAccess["plan"]> {
  const limits = INFERENCE_TIER_LIMITS[tier];
  const usd = (amount: number) => `$${amount / INFERENCE_USAGE_CONVERSION_FACTOR}`;
  return {
    name: "OpenWork Models",
    priceLabel: null,
    usageLabel: `Shared workspace usage allowances: ${usd(limits.five_hour)} per member / 5 hours, ${usd(limits.weekly)} per member / week, and ${usd(limits.monthly)} per member / month.`,
  };
}

// Den writes inferenceFree.offerAllowed explicitly, including false on admin
// disable. Missing paid metadata alone never authorizes the free upstream key.
export function inferenceAccessMode(metadata: Record<string, unknown> | null): "paid" | "free" | "admin_disabled" | "not_eligible" {
  const inference = metadata?.inference;
  const offer = metadata?.inferenceFree;
  if (typeof inference === "object" && inference !== null && "enabled" in inference && inference.enabled === false) return "admin_disabled";
  if (typeof inference === "object" && inference !== null && "tier" in inference) {
    if (inference.tier === "tier1" || inference.tier === "tier2") return "paid";
    return "not_eligible";
  }
  if (typeof offer === "object" && offer !== null && "offerAllowed" in offer) {
    if (offer.offerAllowed === false) return "admin_disabled";
    if (offer.offerAllowed === true) return "free";
  }
  return "not_eligible";
}

// Structural projection of InferenceFreeUsageBucketTable. Den reads the row for
// the authenticated person's user_id and this week's window_start_at.
export type FreeInferenceBucketState = {
  window_start_at: Date;
  window_end_at: Date;
  limit_amount: number;
  used_amount: number;
  reserved_amount: number;
  blocked: boolean;
};

export function freeInferenceAccess(input: {
  config: FreeInferenceConfig;
  mode: ReturnType<typeof inferenceAccessMode>;
  bucket?: FreeInferenceBucketState | null;
  now?: Date;
}): InferenceAccess {
  if (input.mode === "paid") return { kind: "paid", modelID: null, weeklyLimitUsd: null, usedUsd: null, reservedUsd: null, remainingUsd: null, resetsAt: null, reason: null };
  const window = freeInferenceWindow(input.now);
  const bucket = input.bucket;
  const limit = bucket?.limit_amount ?? input.config.weeklyLimitAmount;
  const used = bucket?.used_amount ?? 0;
  const reserved = bucket?.reserved_amount ?? 0;
  const valid = [limit, used, reserved].every((value) => Number.isSafeInteger(value) && value >= 0)
    && (!bucket || bucket.window_start_at.getTime() === window.start.getTime() && bucket.window_end_at.getTime() === window.end.getTime());
  const remaining = valid ? Math.max(0, limit - used) : 0;
  const reason = input.mode !== "free" ? input.mode : !input.config.enabled ? "free_disabled" : !valid || bucket?.blocked ? "accounting_unavailable" : remaining === 0 ? "free_allowance_exhausted" : reserved > 0 ? "free_request_in_progress" : null;
  return {
    // A busy account retains its provider/entitlement; it is not an upgrade or
    // provisioning failure. Admission checks the reason as well as the kind.
    kind: reason === null || reason === "free_request_in_progress" ? "free" : reason === "free_allowance_exhausted" ? "exhausted" : "unavailable",
    modelID: input.config.modelID,
    weeklyLimitUsd: valid ? limit / INFERENCE_USAGE_CONVERSION_FACTOR : null,
    usedUsd: valid ? used / INFERENCE_USAGE_CONVERSION_FACTOR : null,
    reservedUsd: valid ? reserved / INFERENCE_USAGE_CONVERSION_FACTOR : null,
    remainingUsd: remaining / INFERENCE_USAGE_CONVERSION_FACTOR,
    resetsAt: window.end.toISOString(),
    reason,
  };
}
