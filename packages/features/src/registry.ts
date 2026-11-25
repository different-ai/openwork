import * as previews from "@openwork/features/previews"

export * from "@openwork/features/define"

/** Every preview flag, by key, in alphabetical order. */
export const FEATURES = { ...previews }

export type FeatureKey = keyof typeof FEATURES

/** Features whose outcomes /admin › Features reads (`outcomes: true`). */
export type OutcomeFeatureKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { outcomes: true } ? K : never }[FeatureKey]

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
