import { featureHasOutcomes, type FeatureKey, type OutcomeFeatureKey } from "@openwork/features"
import type { FeatureOutcomeReader } from "./outcomes.js"

export const FEATURE_OUTCOME_READERS: Record<OutcomeFeatureKey, FeatureOutcomeReader> = {}

export function featureOutcomeReader(key: FeatureKey): FeatureOutcomeReader | null {
  return featureHasOutcomes(key) ? FEATURE_OUTCOME_READERS[key] : null
}
