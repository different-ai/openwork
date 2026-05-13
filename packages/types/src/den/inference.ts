export const INFERENCE_WINDOW_TYPES = ["five_hour", "weekly", "monthly"] as const
export type InferenceWindowType = (typeof INFERENCE_WINDOW_TYPES)[number]

export const INFERENCE_TIERS = ["tier1", "tier2"] as const
export type InferenceTier = (typeof INFERENCE_TIERS)[number]

export const INFERENCE_TIER_LIMITS: Record<InferenceTier, Record<InferenceWindowType, number>> = {
  tier1: {
    five_hour: 10_000,
    weekly: 50_000,
    monthly: 200_000,
  },
  tier2: {
    five_hour: 12_000,
    weekly: 60_000,
    monthly: 240_000,
  },
} as const

export const INFERENCE_RESET_STRATEGIES = ["anchored", "activity_based"] as const
export type InferenceResetStrategy = (typeof INFERENCE_RESET_STRATEGIES)[number]

export const INFERENCE_RESET_STRATEGY_BY_WINDOW_TYPE: Record<InferenceWindowType, InferenceResetStrategy> = {
  five_hour: "activity_based",
  weekly: "anchored",
  monthly: "anchored",
} as const

export const INFERENCE_WINDOW_DURATIONS_MS: Record<InferenceWindowType, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
} as const

export const INFERENCE_MODEL_ALIASES = {
  model1: {
    upstreamModel: "openai/gpt-4o-mini",
    displayName: "OpenWork Model 1",
  },
  model2: {
    upstreamModel: "anthropic/claude-3.5-sonnet",
    displayName: "OpenWork Model 2",
  },
} as const

export type InferenceModelAlias = keyof typeof INFERENCE_MODEL_ALIASES

export type InferenceOrganizationMetadata = {
  enabled: true
  tier: InferenceTier
}
