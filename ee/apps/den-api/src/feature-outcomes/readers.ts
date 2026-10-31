import { featureHasOutcomes, type FeatureKey, type OutcomeFeatureKey } from "@openwork/features"
import type { FeatureOutcomeReader } from "./outcomes.js"
import { readAgentOutcomes } from "./workbot-proactive.js"

/**
 * One outcome reader per feature that declares `outcomes: true` in packages/features/src/registry.ts, registered
 * once. `satisfies` makes the typecheck fail when a feature declares outcomes without a reader here, or a reader
 * names a feature that does not declare them; test/feature-outcomes.test.ts checks the same at runtime. A reader
 * aggregates the store that already owns the outcomes, with indexed queries, and copies nothing. Features without a
 * reader show adoption only (feature_usage).
 */
export const FEATURE_OUTCOME_READERS = {
  workbotProactive: readAgentOutcomes,
} satisfies Record<OutcomeFeatureKey, FeatureOutcomeReader>

export function featureOutcomeReader(key: FeatureKey): FeatureOutcomeReader | null {
  return featureHasOutcomes(key) ? FEATURE_OUTCOME_READERS[key] : null
}
