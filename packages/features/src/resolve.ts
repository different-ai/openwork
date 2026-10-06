/**
 * How a feature from ./registry.ts resolves for one subject. One function for
 * every feature and every place it is checked (den-api, Den web, the desktop):
 *
 *   1. not part of this deployment      → off   ("unavailable")
 *   2. kill switch                      → off   ("killed")       the revert, no deploy
 *   3. operator lock (DEN_FEATURE_*)    → as set ("lock")
 *   4. organization override (/admin)   → as set ("override")
 *   5. percentage of the subject        → in or out ("rollout")   0% dark … 100% everyone
 *
 * Pure functions with no I/O, safe in browsers.
 */

import { z } from "zod"
import {
  FEATURES,
  type FeatureDefinition,
  type FeatureDeployment,
  type FeatureKey,
  type FeatureMap,
  type FeatureOverrides,
} from "@openwork/features/registry"

/**
 * Retired keys. Older clients and stored overrides may still send or hold them;
 * inputs accept and ignore them, and they are never stored again.
 */
export const RETIRED_FEATURE_KEYS = ["gatewayDashboard", "workflows", "codemodeScripts", "remoteMcpApps", "appMcpServers", "cloud"] as const

export function isFeatureKey(value: string): value is FeatureKey {
  return Object.hasOwn(FEATURES, value)
}

export const FEATURE_KEYS: readonly FeatureKey[] = Object.keys(FEATURES).filter(isFeatureKey)

export function featureDefinition(key: FeatureKey): FeatureDefinition {
  return FEATURES[key]
}

export function featureAvailableOn(key: FeatureKey, deployment: FeatureDeployment): boolean {
  return featureDefinition(key).deployments.includes(deployment)
}

/** Features that exist on this deployment; the only ones with a Helm key there. */
export function availableFeatureKeys(deployment: FeatureDeployment): FeatureKey[] {
  return FEATURE_KEYS.filter((key) => featureAvailableOn(key, deployment))
}

/**
 * `newThing` → `DEN_FEATURE_NEW_THING`. Must match the Helm chart's
 * `snakecase | upper`; `pnpm features:check` renders the chart to prove it.
 */
export function featureLockEnvName(key: FeatureKey): string {
  return `DEN_FEATURE_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`
}

/** Builds a value for every registry key, so adding an entry never means editing a literal. */
export function mapFeatures<V>(fn: (key: FeatureKey) => V): Record<FeatureKey, V> {
  const result: Partial<Record<FeatureKey, V>> = {}
  for (const key of FEATURE_KEYS) result[key] = fn(key)
  // Every key in FEATURE_KEYS was assigned above; TypeScript cannot follow the loop.
  return result as Record<FeatureKey, V>
}

/** Accepts exactly the registry keys. */
export const featureKeySchema = z.enum(mapFeatures((key) => key))

/** Deployment-wide rollout state, stored per deployment and changed in /admin. */
export type FeatureRollout = { percent: number; killed: boolean }

export type FeatureRollouts = Partial<Record<FeatureKey, FeatureRollout>>

/** The stored state, or the registry's starting percentage when nothing is stored. */
export function featureRollout(key: FeatureKey, rollouts: FeatureRollouts): FeatureRollout {
  return rollouts[key] ?? { percent: featureDefinition(key).start, killed: false }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * Stable bucket 0–99 for one subject and feature (FNV-1a). Raising the
 * percentage only adds subjects; the same subject always lands in the same
 * bucket, and buckets differ per feature so the same people are not always first.
 */
export function rolloutBucket(key: FeatureKey, subjectId: string): number {
  let hash = 0x811c9dc5
  for (const char of `${key}:${subjectId}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 100
}

export function inRollout(key: FeatureKey, subjectId: string | null | undefined, percent: number): boolean {
  const clamped = clampPercent(percent)
  if (clamped >= 100) return true
  if (clamped <= 0 || !subjectId) return false
  return rolloutBucket(key, subjectId) < clamped
}

export type FeatureEnvironment = {
  deployment: FeatureDeployment
  /** Operator locks from DEN_FEATURE_* (Helm `config.features`). */
  locks: FeatureOverrides
}

/** Who the feature is being resolved for. Leave one out when it does not apply. */
export type FeatureSubjects = {
  organizationId?: string | null
  /** User id when signed in, install id when signed out. */
  personId?: string | null
}

export type FeatureContext = FeatureEnvironment & {
  rollouts: FeatureRollouts
  /** Stored overrides for the subject's organization, if any. */
  overrides: FeatureOverrides
  subjects: FeatureSubjects
}

export type FeatureSource = "unavailable" | "killed" | "lock" | "override" | "rollout"

export type ResolvedFeature = {
  key: FeatureKey
  enabled: boolean
  source: FeatureSource
  percent: number
  killed: boolean
  lock: boolean | null
  override: boolean | null
  /** A per-organization override would take effect (available, not killed, not locked). */
  overrideApplies: boolean
}

export function resolveFeature(key: FeatureKey, context: FeatureContext): ResolvedFeature {
  const { percent, killed } = featureRollout(key, context.rollouts)
  const lock = context.locks[key] ?? null
  const override = context.overrides[key] ?? null
  const base = { key, percent: clampPercent(percent), killed, lock, override }
  if (!featureAvailableOn(key, context.deployment)) {
    return { ...base, enabled: false, source: "unavailable", overrideApplies: false }
  }
  if (killed) return { ...base, enabled: false, source: "killed", overrideApplies: false }
  if (lock !== null) return { ...base, enabled: lock, source: "lock", overrideApplies: false }
  if (override !== null) return { ...base, enabled: override, source: "override", overrideApplies: true }
  const subjectId = featureDefinition(key).subject === "organization" ? context.subjects.organizationId : context.subjects.personId
  return { ...base, enabled: inRollout(key, subjectId, percent), source: "rollout", overrideApplies: true }
}

export function resolveFeatures(context: FeatureContext): FeatureMap {
  return mapFeatures((key) => resolveFeature(key, context).enabled)
}

export type FeatureEnvironmentProblem = { variable: string; message: string; fatal: boolean }

/**
 * Reads DEN_DEPLOYMENT and DEN_FEATURE_* from an environment record. Fatal
 * problems (unknown deployment, a value other than "true"/"false") should stop
 * the server at boot; the others are warnings about ignored variables.
 */
export function parseFeatureEnvironment(env: Record<string, string | undefined>): FeatureEnvironment & { problems: FeatureEnvironmentProblem[] } {
  const problems: FeatureEnvironmentProblem[] = []
  const rawDeployment = env.DEN_DEPLOYMENT?.trim() ?? ""
  let deployment: FeatureDeployment = "self_hosted"
  if (rawDeployment === "cloud" || rawDeployment === "self_hosted") {
    deployment = rawDeployment
  } else if (rawDeployment !== "") {
    problems.push({ variable: "DEN_DEPLOYMENT", message: `must be "cloud" or "self_hosted", got "${rawDeployment}".`, fatal: true })
  }

  const locks: FeatureOverrides = {}
  const known = new Map<string, FeatureKey>(FEATURE_KEYS.map((key) => [featureLockEnvName(key), key]))
  for (const [variable, rawValue] of Object.entries(env)) {
    if (!variable.startsWith("DEN_FEATURE_")) continue
    const value = rawValue?.trim() ?? ""
    if (value === "") continue
    const key = known.get(variable)
    if (!key) {
      problems.push({ variable, message: "is not a known feature and is ignored.", fatal: false })
      continue
    }
    if (value !== "true" && value !== "false") {
      problems.push({ variable, message: `must be "true", "false" or empty, got "${value}".`, fatal: true })
      continue
    }
    if (!featureAvailableOn(key, deployment)) {
      problems.push({ variable, message: `is ignored: ${key} is not part of this deployment.`, fatal: false })
      continue
    }
    locks[key] = value === "true"
  }

  return { deployment, locks, problems }
}
