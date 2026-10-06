/**
 * How a feature from ./registry.ts resolves. One function for
 * every feature and every place it is checked (den-api, Den web, the desktop):
 *
 *   1. not part of this deployment      → off    ("unavailable")
 *   2. kill switch                      → off    ("killed")      the revert, no deploy
 *   3. operator lock (DEN_FEATURE_*)    → as set ("lock")
 *   4. organization override (/admin)   → as set ("override")
 *   5. on or off for everyone (/admin)  → as set ("everyone")
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
export const RETIRED_FEATURE_KEYS = ["gatewayDashboard", "workflows", "codemodeScripts", "remoteMcpApps", "cloud"] as const

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

/** Deployment-wide state of one feature, stored per deployment and changed in /admin. */
export type FeatureRollout = { enabled: boolean; killed: boolean }

export type FeatureRollouts = Partial<Record<FeatureKey, FeatureRollout>>

/** The stored state, or the registry default when nothing is stored. */
export function featureRollout(key: FeatureKey, rollouts: FeatureRollouts): FeatureRollout {
  return rollouts[key] ?? { enabled: featureDefinition(key).default, killed: false }
}

export type FeatureEnvironment = {
  deployment: FeatureDeployment
  /** Operator locks from DEN_FEATURE_* (Helm `config.features`). */
  locks: FeatureOverrides
}

export type FeatureContext = FeatureEnvironment & {
  rollouts: FeatureRollouts
  /** Stored overrides for the organization being resolved; empty when there is none (signed out). */
  overrides: FeatureOverrides
}

export type FeatureSource = "unavailable" | "killed" | "lock" | "override" | "everyone"

export type ResolvedFeature = {
  key: FeatureKey
  enabled: boolean
  source: FeatureSource
  /** The deployment-wide on/off state. */
  everyone: boolean
  killed: boolean
  lock: boolean | null
  override: boolean | null
  /** A per-organization override would take effect (available, not killed, not locked). */
  overrideApplies: boolean
}

export function resolveFeature(key: FeatureKey, context: FeatureContext): ResolvedFeature {
  const { enabled: everyone, killed } = featureRollout(key, context.rollouts)
  const lock = context.locks[key] ?? null
  const override = context.overrides[key] ?? null
  const base = { key, everyone, killed, lock, override }
  if (!featureAvailableOn(key, context.deployment)) {
    return { ...base, enabled: false, source: "unavailable", overrideApplies: false }
  }
  if (killed) return { ...base, enabled: false, source: "killed", overrideApplies: false }
  if (lock !== null) return { ...base, enabled: lock, source: "lock", overrideApplies: false }
  if (override !== null) return { ...base, enabled: override, source: "override", overrideApplies: true }
  return { ...base, enabled: everyone, source: "everyone", overrideApplies: true }
}

export function resolveFeatures(context: FeatureContext): FeatureMap {
  return mapFeatures((key) => resolveFeature(key, context).enabled)
}

export type FeatureEnvironmentProblem = { variable: string; message: string; fatal: boolean }

/**
 * Deployment-wide switches that existed before the registry. Until they are
 * removed (after 2026-11-30), each still works as an operator lock when
 * DEN_FEATURE_<KEY> is not set, but only when its value differs from the
 * registry default, so a chart that renders the old default does not freeze
 * /admin. New code must never add to this list.
 */
export const LEGACY_FEATURE_ENV: Partial<Record<FeatureKey, string>> = {
  dashboard: "DEN_DASHBOARDS_ENABLED",
  automations: "DEN_AUTOMATIONS_ENABLED",
  openworkWeb: "DEN_OPENWORK_WEB_ENABLED",
  appMcpServers: "DEN_APP_MCP_SERVERS_ENABLED",
  generatedArtifactViews: "DEN_GENERATED_ARTIFACT_VIEWS_ENABLED",
}

function parseLegacyBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

/**
 * Reads DEN_DEPLOYMENT and DEN_FEATURE_* from an environment record. Fatal
 * problems (unknown deployment, a value other than "true"/"false") should stop
 * the server at boot; the others are warnings about ignored variables.
 */
export function parseFeatureEnvironment(env: Record<string, string | undefined>): FeatureEnvironment & { problems: FeatureEnvironmentProblem[] } {
  const problems: FeatureEnvironmentProblem[] = []
  const rawDeployment = env.DEN_DEPLOYMENT?.trim() ?? ""
  // Unset: only OpenWork Cloud runs multi-organization, so that means cloud.
  // The Helm chart always sets DEN_DEPLOYMENT, so self-hosted installs are explicit.
  let deployment: FeatureDeployment = env.DEN_ORG_MODE?.trim() === "multi_org" ? "cloud" : "self_hosted"
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

  for (const key of FEATURE_KEYS) {
    const variable = LEGACY_FEATURE_ENV[key]
    const raw = variable ? env[variable]?.trim() ?? "" : ""
    if (!variable || raw === "" || locks[key] !== undefined) continue
    const value = parseLegacyBoolean(raw)
    if (!featureAvailableOn(key, deployment)) {
      if (value) problems.push({ variable, message: `is ignored: ${key} is not part of this deployment.`, fatal: false })
      continue
    }
    if (value === featureDefinition(key).default) continue
    locks[key] = value
    problems.push({ variable, message: `is deprecated; set ${featureLockEnvName(key)} (Helm config.features.${key}) instead.`, fatal: false })
  }

  return { deployment, locks, problems }
}
