/**
 * OpenWork feature registry: the one place features are declared.
 *
 * Each feature is its own file, src/flags/<key-in-kebab-case>.ts, so two
 * branches that each add a feature never touch the same lines. To add one,
 * create the file and run `pnpm features:sync`. Read
 * .opencode/skills/add-a-feature/SKILL.md first. Every new user-visible
 * feature, or a change existing users would notice, starts there, off, before
 * any feature code is written.
 *
 * A feature is rolled out, and reverted, along several dimensions:
 *
 *   deployments   which products it exists on (OpenWork Cloud, self-hosted)
 *   everyone      on or off for everyone on the deployment, changed in /admin
 *                 without a deploy
 *   organization  platform admins turn it on or off for one organization in /admin
 *   operator      a self-hosted operator locks it on or off for the whole install (Helm)
 *   kill switch   turns it off everywhere at once, outranking everything above
 *
 * Features are for what people in organizations get. Controls that only
 * platform admins see in /admin (the deployment's own management) are not
 * features: ship them without a flag.
 *
 * Every entry names its author and, for new features, links an internal doc
 * under docs/ with a screenshot when the feature is visual.
 *
 * The entry only declares what is fixed in code. The on/off state, kill
 * switches and per-organization overrides live in the database of each
 * deployment, and start from `default`.
 *
 * Keys are permanent: the same name is the Helm values key, the
 * DEN_FEATURE_<KEY> environment variable, the API field, and the stored rows.
 * Use lowerCamelCase with no consecutive capitals.
 */

import * as flags from "@openwork/features/all-flags"

export * from "@openwork/features/define"

/** Every feature, by key, in alphabetical order. */
export const FEATURES = { ...flags }

export type FeatureKey = keyof typeof FEATURES

/** Features whose outcomes /admin › Features reads (`outcomes: true`). */
export type OutcomeFeatureKey = { [K in FeatureKey]: (typeof FEATURES)[K] extends { outcomes: true } ? K : never }[FeatureKey]

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>
