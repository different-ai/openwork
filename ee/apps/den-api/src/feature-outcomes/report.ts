import { count, inArray } from "@openwork-ee/den-db/drizzle"
import {
  readFeatureOverrideOrganizations,
  readFeatureRollouts,
  readFeatureUsageSince,
  readOrganizationFeatureOverrideCounts,
  type FeatureUsageSince,
} from "@openwork-ee/den-db/organization-features"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { availableFeatureKeys, resolveFeature, type FeatureEnvironment, type FeatureKey, type FeatureRollouts } from "@openwork/features"
import { db } from "../db.js"
import { env } from "../env.js"
import {
  emptyFeatureOutcomeTotals,
  featureHealth,
  featureOutcomeRange,
  summarizeFeatureOutcomes,
  type FeatureHealth,
  type FeatureOutcomeRange,
  type FeatureOutcomeSummary,
  type FeatureOutcomeTotals,
} from "./outcomes.js"
import { featureOutcomeReader } from "./readers.js"

/**
 * /admin › Features, organized by feature across every organization: who has it on and uses it (feature_usage and
 * the feature state), what it did (its outcome reader, when it has one) and one health state.
 */

export type FeatureOutcomeRangeKey = "7d" | "30d"
export const FEATURE_OUTCOME_RANGES: Record<FeatureOutcomeRangeKey, number> = { "7d": 7, "30d": 30 }

/** By-organization rows in one feature's detail; the busiest first. */
const ORGANIZATION_ROWS_MAX = 200

export type FeatureAdoption = { organizationsOn: number; membersUsing: number; lastUsedAt: Date | null }

export type FeatureReport = FeatureAdoption & {
  key: FeatureKey
  health: FeatureHealth
  outcomes: FeatureOutcomeSummary | null
}

/**
 * Organizations the feature is on for, without reading each one: off everywhere or locked decides it for all, else
 * the deployment-wide state minus the organizations that override it.
 */
export function organizationsWithFeatureOn(input: {
  key: FeatureKey
  environment: FeatureEnvironment
  rollouts: FeatureRollouts
  overrides: { on: number; off: number } | undefined
  organizations: number
}): number {
  const base = resolveFeature(input.key, { ...input.environment, rollouts: input.rollouts, overrides: {} })
  if (!base.overrideApplies) return base.enabled ? input.organizations : 0
  return base.enabled ? Math.max(0, input.organizations - (input.overrides?.off ?? 0)) : input.overrides?.on ?? 0
}

function adoptionOf(rows: readonly FeatureUsageSince[]): Pick<FeatureAdoption, "membersUsing" | "lastUsedAt"> {
  let membersUsing = 0
  let lastUsedAt: Date | null = null
  for (const row of rows) {
    membersUsing += row.members
    if (!lastUsedAt || row.lastUsedAt > lastUsedAt) lastUsedAt = row.lastUsedAt
  }
  return { membersUsing, lastUsedAt }
}

async function organizationCount() {
  const [row] = await db.select({ organizations: count() }).from(OrganizationTable)
  return Number(row?.organizations ?? 0)
}

async function readOutcomes(key: FeatureKey, range: FeatureOutcomeRange): Promise<FeatureOutcomeSummary | null> {
  const reader = featureOutcomeReader(key)
  return reader ? summarizeFeatureOutcomes(await reader(range), range) : null
}

/** Every feature on this deployment, in registry order. */
export async function readFeatureReports(rangeKey: FeatureOutcomeRangeKey, now = new Date()) {
  const range = featureOutcomeRange(FEATURE_OUTCOME_RANGES[rangeKey], now)
  const keys = availableFeatureKeys(env.features.deployment)
  const [organizations, rollouts, overrideCounts, usage] = await Promise.all([
    organizationCount(),
    readFeatureRollouts(db),
    readOrganizationFeatureOverrideCounts(db),
    readFeatureUsageSince(db, { since: range.from }),
  ])
  const outcomes = new Map<FeatureKey, FeatureOutcomeSummary | null>()
  for (const key of keys) outcomes.set(key, await readOutcomes(key, range))
  const features: FeatureReport[] = keys.map((key) => {
    const adoption = adoptionOf(usage.filter((row) => row.featureKey === key))
    const summary = outcomes.get(key) ?? null
    return {
      key,
      organizationsOn: organizationsWithFeatureOn({ key, environment: env.features, rollouts, overrides: overrideCounts[key], organizations }),
      ...adoption,
      outcomes: summary,
      health: featureHealth({ membersUsing: adoption.membersUsing, outcomes: summary }),
    }
  })
  return { range, organizations, features }
}

export type FeatureOrganizationReport = {
  organizationId: string
  name: string
  enabled: boolean
  membersUsing: number
  lastUsedAt: Date | null
  outcomes: FeatureOutcomeTotals | null
}

/** One feature with its by-organization breakdown: every organization that used it, has outcomes or overrides it. */
export async function readFeatureReport(key: FeatureKey, rangeKey: FeatureOutcomeRangeKey, now = new Date()) {
  const range = featureOutcomeRange(FEATURE_OUTCOME_RANGES[rangeKey], now)
  const [organizations, rollouts, overrides, usage, outcomes] = await Promise.all([
    organizationCount(),
    readFeatureRollouts(db),
    readFeatureOverrideOrganizations(db, key),
    readFeatureUsageSince(db, { since: range.from, featureKey: key }),
    readOutcomes(key, range),
  ])
  const counts = { on: 0, off: 0 }
  for (const enabled of overrides.values()) counts[enabled ? "on" : "off"] += 1
  const adoption = adoptionOf(usage)
  const ids = [...new Set<string>([...usage.map((row) => row.organizationId), ...outcomes?.byOrganization.keys() ?? [], ...overrides.keys()])]
    .filter((id): id is DenTypeId<"organization"> => isDenTypeId("organization", id))
  const names = new Map<string, string>()
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500)
    const rows = await db.select({ id: OrganizationTable.id, name: OrganizationTable.name }).from(OrganizationTable).where(inArray(OrganizationTable.id, chunk))
    for (const row of rows) names.set(row.id, row.name)
  }
  const byOrganization: FeatureOrganizationReport[] = ids.flatMap((organizationId) => {
    const name = names.get(organizationId)
    // Usage and outcomes of a deleted organization are deleted with it; a leftover row is not shown.
    if (name === undefined) return []
    const override = overrides.get(organizationId)
    const used = adoptionOf(usage.filter((row) => row.organizationId === organizationId))
    return [{
      organizationId,
      name,
      enabled: resolveFeature(key, { ...env.features, rollouts, overrides: override === undefined ? {} : { [key]: override } }).enabled,
      ...used,
      outcomes: outcomes?.byOrganization.get(organizationId) ?? (outcomes ? emptyFeatureOutcomeTotals(outcomes.limited !== null) : null),
    }]
  })
    .sort((a, b) => (b.outcomes?.runs ?? 0) - (a.outcomes?.runs ?? 0) || b.membersUsing - a.membersUsing || a.name.localeCompare(b.name))
    .slice(0, ORGANIZATION_ROWS_MAX)
  return {
    range,
    organizations,
    feature: {
      key,
      organizationsOn: organizationsWithFeatureOn({ key, environment: env.features, rollouts, overrides: counts, organizations }),
      ...adoption,
      outcomes,
      health: featureHealth({ membersUsing: adoption.membersUsing, outcomes }),
      byOrganization,
    },
  }
}
