import { featureHasOutcomes, type FeatureKey, type OutcomeFeatureKey } from "@openwork/features"
import { automationRunOutcomes } from "./automations.js"
import type { FeatureOutcomeReader } from "./outcomes.js"

export const FEATURE_OUTCOME_READERS: Record<OutcomeFeatureKey, FeatureOutcomeReader> = {
  personalAgents: automationRunOutcomes("personal_agent", "run"),
}

export function featureOutcomeReader(key: FeatureKey): FeatureOutcomeReader | null {
  return featureHasOutcomes(key) ? FEATURE_OUTCOME_READERS[key] : null
}
