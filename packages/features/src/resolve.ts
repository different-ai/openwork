/**
 * Resolution rules for the registry in ./registry.ts: which features exist on
 * this deployment, how a deployment lock (DEN_FEATURE_*) and a stored
 * per-organization override combine with the registry default, and how the
 * environment is parsed. Pure functions with no I/O, safe in browsers.
 */

import { z } from "zod"
import {
  FEATURES,
  type FeatureAvailability,
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

export function featureAvailability(key: FeatureKey, deployment: FeatureDeployment): FeatureAvailability {
  const definition: FeatureDefinition = FEATURES[key]
  return deployment === "cloud" ? definition.cloud : definition.selfHosted
}

/** Platform admins (or the operator, through a lock) can change it in this deployment. */
export function featureIsAdjustable(key: FeatureKey, deployment: FeatureDeployment): boolean {
  return typeof featureAvailability(key, deployment) === "object"
}

/** Keys an operator can set in Helm or through DEN_FEATURE_* on self-hosted installs. */
export function adjustableFeatureKeys(deployment: FeatureDeployment): FeatureKey[] {
  return FEATURE_KEYS.filter((key) => featureIsAdjustable(key, deployment))
}

/**
 * `newThing` → `DEN_FEATURE_NEW_THING`. Must match the Helm chart's
 * `snakecase | upper`; `pnpm features:sync --check` renders the chart to prove it.
 */
export function featureLockEnvName(key: FeatureKey): string {
  return `DEN_FEATURE_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`
}

export type FeatureSource = "unavailable" | "off" | "on" | "lock" | "override" | "default"

export type ResolvedFeature = {
  key: FeatureKey
  enabled: boolean
  source: FeatureSource
  /** Platform admins can change it in /admin (adjustable and not locked by the deployment). */
  adminCanChange: boolean
  /** The stored per-organization override, if any. */
  override: boolean | null
  /** The registry default when the feature is platform-controlled. */
  default: boolean | null
}

export type FeatureEnvironment = {
  deployment: FeatureDeployment
  /** Deployment locks from DEN_FEATURE_* (Helm `config.features`); they outrank overrides. */
  locks: FeatureOverrides
}

/**
 * The precedence rule for one entry, given its availability on this deployment:
 * fixed values (unavailable / off / on) ignore locks and overrides; otherwise a
 * deployment lock wins, then a stored override, then the registry default.
 */
export function resolveAvailability(
  availability: FeatureAvailability,
  input: { lock: boolean | undefined; override: boolean | null },
): Omit<ResolvedFeature, "key"> {
  const { lock, override } = input
  if (availability === "unavailable" || availability === "off") {
    return { enabled: false, source: availability, adminCanChange: false, override, default: null }
  }
  if (availability === "on") {
    return { enabled: true, source: "on", adminCanChange: false, override, default: null }
  }
  if (lock !== undefined) {
    return { enabled: lock, source: "lock", adminCanChange: false, override, default: availability.default }
  }
  if (override !== null) {
    return { enabled: override, source: "override", adminCanChange: true, override, default: availability.default }
  }
  return { enabled: availability.default, source: "default", adminCanChange: true, override, default: availability.default }
}

export function resolveFeature(key: FeatureKey, input: FeatureEnvironment & { overrides: FeatureOverrides }): ResolvedFeature {
  return {
    key,
    ...resolveAvailability(featureAvailability(key, input.deployment), {
      lock: input.locks[key],
      override: input.overrides[key] ?? null,
    }),
  }
}

/** Builds a value for every registry key, so adding an entry never means editing a literal. */
export function mapFeatures<V>(fn: (key: FeatureKey) => V): Record<FeatureKey, V> {
  const result: Partial<Record<FeatureKey, V>> = {}
  for (const key of FEATURE_KEYS) result[key] = fn(key)
  // Every key in FEATURE_KEYS was assigned above; TypeScript cannot follow the loop.
  return result as Record<FeatureKey, V>
}

export function resolveFeatures(input: FeatureEnvironment & { overrides: FeatureOverrides }): FeatureMap {
  return mapFeatures((key) => resolveFeature(key, input).enabled)
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
    if (!featureIsAdjustable(key, deployment)) {
      problems.push({ variable, message: `is ignored: ${key} is not adjustable on this deployment.`, fatal: false })
      continue
    }
    locks[key] = value === "true"
  }

  return { deployment, locks, problems }
}

/** Accepts exactly the registry keys. */
export const featureKeySchema = z.enum(mapFeatures((key) => key))
