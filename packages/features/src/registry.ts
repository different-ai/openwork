import * as flags from "@openwork/features/all-flags"

export * from "@openwork/features/define"

/** Every feature, by key, in alphabetical order. */
export const FEATURES = { ...flags }

export type FeatureKey = keyof typeof FEATURES

/** Features whose outcomes /admin › Features reads (`outcomes: true`). */
export type OutcomeFeatureKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { outcomes: true } ? K : never }[FeatureKey]

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
