/**
 * OpenWork feature registry: the one place a feature is declared.
 *
 * Read .opencode/skills/add-a-feature/SKILL.md before adding or changing an
 * entry. Every new user-visible feature, or a change existing users would
 * notice, starts here — set to "off" in both deployments — before any feature
 * code is written.
 *
 * Each entry decides, separately for OpenWork Cloud and for self-hosted
 * installs, whether the feature exists there and who controls it:
 *
 *   "unavailable"                         not part of this deployment, by design
 *   "off"                                 built, but dark for now
 *   "on"                                  on for every organization
 *   { control: "platform", default }      platform admins turn it on or off per
 *                                         organization in /admin (on self-hosted,
 *                                         that is the customer's operator)
 *
 * Only `platform` features get a Helm key (`config.features.<key>`), an
 * `/admin` toggle, and a stored per-organization override. After editing this
 * file, run `pnpm features:sync` to regenerate the Helm chart files.
 *
 * Keys are permanent: the same name is the Helm values key, the
 * DEN_FEATURE_<KEY> environment variable, the API field, and the stored row.
 * Use lowerCamelCase with no consecutive capitals.
 */

import { z } from "zod"

export type FeatureDeployment = "cloud" | "self_hosted"

export type FeatureAvailability =
  | "unavailable"
  | "off"
  | "on"
  | { control: "platform"; default: boolean }

export type FeatureDefinition = {
  /** Short name shown to platform admins and operators. */
  label: string
  /** One sentence: what a person gets, in words they see in the product. */
  description: string
  /** Year and month the entry was added or last changed state, e.g. "2026-10". */
  since: `${number}-${number}`
  cloud: FeatureAvailability
  selfHosted: FeatureAvailability
}

function defineFeatures<const T extends Record<string, FeatureDefinition>>(features: T): T {
  return features
}

const platformDefaultOn = { control: "platform", default: true } as const
const platformDefaultOff = { control: "platform", default: false } as const

export const FEATURES = defineFeatures({
  installLinks: {
    label: "Install links",
    description: "Workspace admins can create desktop install links for their organization.",
    since: "2026-10",
    cloud: platformDefaultOn,
    selfHosted: platformDefaultOn,
  },
  mcpConnections: {
    label: "OpenWork Connect",
    description: "Members see the organization's connections, marketplace capabilities on the agent rail, and the desktop Connect tab.",
    since: "2026-10",
    cloud: platformDefaultOn,
    selfHosted: platformDefaultOn,
  },
  modelsAnalytics: {
    label: "OpenWork Models task analytics",
    description: "Organization admins can opt in to task analytics for OpenWork Models.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  auditLogs: {
    label: "Audit logs",
    description: "Organization admins can read and configure audit logs. Capture still needs an audit entitlement.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  orgManagedDashboards: {
    label: "Dashboards",
    description: "Organization admins publish dashboards to members in Den and the desktop app.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  slackAssistant: {
    label: "Slack Assistant",
    description: "Answers Slack mentions and DMs for the organization after the Slack connector is set up.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  slackAssistantHeadless: {
    label: "Slack Assistant: headless runtime",
    description: "Answers Slack on the shared headless runner instead of each member's OpenWork Web computer. Needs the deployment's headless runner.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  headlessAutomations: {
    label: "Cloud Automations: headless runtime",
    description: "Runs the organization's cloud Automations on the shared headless runner. Needs the deployment's headless runner and a plan that includes it.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
  workbot: {
    label: "Workbot",
    description: "Members can use Workbot. Needs the deployment's Workbot app.",
    since: "2026-10",
    cloud: platformDefaultOff,
    selfHosted: platformDefaultOff,
  },
})

export type FeatureKey = keyof typeof FEATURES

export type FeatureMap = Record<FeatureKey, boolean>

export type FeatureOverrides = Partial<FeatureMap>

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

export function resolveFeature(key: FeatureKey, input: FeatureEnvironment & { overrides: FeatureOverrides }): ResolvedFeature {
  const availability = featureAvailability(key, input.deployment)
  const override = input.overrides[key] ?? null
  if (availability === "unavailable" || availability === "off") {
    return { key, enabled: false, source: availability, adminCanChange: false, override, default: null }
  }
  if (availability === "on") {
    return { key, enabled: true, source: "on", adminCanChange: false, override, default: null }
  }
  const lock = input.locks[key]
  if (lock !== undefined) {
    return { key, enabled: lock, source: "lock", adminCanChange: false, override, default: availability.default }
  }
  if (override !== null) {
    return { key, enabled: override, source: "override", adminCanChange: true, override, default: availability.default }
  }
  return { key, enabled: availability.default, source: "default", adminCanChange: true, override, default: availability.default }
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
