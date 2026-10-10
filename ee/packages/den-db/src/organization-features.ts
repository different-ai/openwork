import { and, eq, inArray } from "drizzle-orm"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  isFeatureKey,
  mapFeatures,
  resolveFeature,
  resolveFeatures,
  type FeatureEnvironment,
  type FeatureKey,
  type FeatureMap,
  type FeatureOverrides,
  type FeatureRollouts,
  type ResolvedFeature,
} from "@openwork/features"
import type { createDenDb } from "./client"
import { OrganizationTable } from "./schema/org"
import { FeatureRolloutTable, OrganizationFeatureTable } from "./schema/organization-features"

/**
 * Storage for feature state (on/off for everyone and kill switch per feature) and
 * per-organization overrides. The registry and resolution rules live in
 * @openwork/features; this module only reads and writes the rows. Read
 * features through here, never from organization metadata.
 */

type Db = ReturnType<typeof createDenDb>["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export type FeatureDatabase = Db | Tx

export type FeatureOverrideChanges = Partial<Record<FeatureKey, boolean | null>>

function toOverrides(rows: Array<{ feature_key: string; enabled: boolean }>): FeatureOverrides {
  const overrides: FeatureOverrides = {}
  for (const row of rows) {
    if (isFeatureKey(row.feature_key)) overrides[row.feature_key] = row.enabled
  }
  return overrides
}

/** Stored overrides for one organization. `lock: "share"` keeps them stable until the transaction commits. */
export async function readOrganizationFeatureOverrides(
  database: FeatureDatabase,
  organizationId: string,
  options: { lock?: "share" } = {},
): Promise<FeatureOverrides> {
  const query = database
    .select({ feature_key: OrganizationFeatureTable.feature_key, enabled: OrganizationFeatureTable.enabled })
    .from(OrganizationFeatureTable)
    .where(eq(OrganizationFeatureTable.organization_id, normalizeDenTypeId("organization", organizationId)))
  return toOverrides(await (options.lock ? query.for(options.lock) : query))
}

/** Stored overrides for many organizations in one query, keyed by organization id. */
export async function readOrganizationFeatureOverridesForMany(
  database: FeatureDatabase,
  organizationIds: string[],
): Promise<Map<string, FeatureOverrides>> {
  const result = new Map<string, FeatureOverrides>()
  if (organizationIds.length === 0) return result
  const rows = await database
    .select({
      organization_id: OrganizationFeatureTable.organization_id,
      feature_key: OrganizationFeatureTable.feature_key,
      enabled: OrganizationFeatureTable.enabled,
    })
    .from(OrganizationFeatureTable)
    .where(inArray(OrganizationFeatureTable.organization_id, organizationIds.map((id) => normalizeDenTypeId("organization", id))))
  for (const row of rows) {
    if (!isFeatureKey(row.feature_key)) continue
    const overrides = result.get(row.organization_id) ?? {}
    overrides[row.feature_key] = row.enabled
    result.set(row.organization_id, overrides)
  }
  return result
}

/** Deployment-wide rollout state for every feature that has a stored row. */
export async function readFeatureRollouts(database: FeatureDatabase): Promise<FeatureRollouts> {
  const rows = await database
    .select({ feature_key: FeatureRolloutTable.feature_key, enabled: FeatureRolloutTable.enabled, killed: FeatureRolloutTable.killed })
    .from(FeatureRolloutTable)
  const rollouts: FeatureRollouts = {}
  for (const row of rows) {
    if (isFeatureKey(row.feature_key)) rollouts[row.feature_key] = { enabled: row.enabled, killed: row.killed }
  }
  return rollouts
}

/**
 * Effective on/off for every feature, for one organization, or for someone
 * without one (pass null: only the deployment-wide state applies).
 */
export async function readFeatures(
  database: FeatureDatabase,
  organizationId: string | null,
  environment: FeatureEnvironment,
  options: { lock?: "share" } = {},
): Promise<FeatureMap> {
  // Sequential on purpose: callers may pass a transaction, and a PlanetScale
  // transaction is one session that fails when two queries are in flight.
  const rollouts = await readFeatureRollouts(database)
  const overrides = organizationId ? await readOrganizationFeatureOverrides(database, organizationId, options) : {}
  return resolveFeatures({ ...environment, rollouts, overrides })
}

/** Effective state with its source, for /admin. */
export function describeFeatures(input: {
  rollouts: FeatureRollouts
  overrides: FeatureOverrides
  environment: FeatureEnvironment
}): Record<FeatureKey, ResolvedFeature> {
  return mapFeatures((key) => resolveFeature(key, { ...input.environment, rollouts: input.rollouts, overrides: input.overrides }))
}

/** Turns one feature on or off for everyone and/or sets its kill switch, for this deployment. */
export async function setFeatureRollout(
  database: Db,
  input: { key: FeatureKey; enabled?: boolean; killed?: boolean; updatedByUserId?: string | null; defaultEnabled: boolean },
): Promise<FeatureRollouts> {
  const updatedByUserId = input.updatedByUserId ? normalizeDenTypeId("user", input.updatedByUserId) : null
  const current = (await readFeatureRollouts(database))[input.key]
  const enabled = input.enabled ?? current?.enabled ?? input.defaultEnabled
  const killed = input.killed ?? current?.killed ?? false
  await database.insert(FeatureRolloutTable)
    .values({ feature_key: input.key, enabled, killed, updated_by_user_id: updatedByUserId })
    .onDuplicateKeyUpdate({ set: { enabled, killed, updated_by_user_id: updatedByUserId } })
  return readFeatureRollouts(database)
}

function parseMetadata(value: unknown): Record<string, unknown> {
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return {}
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {}
}

/**
 * Sets (true/false) or clears (null) overrides. Keys missing from `changes` are
 * left alone. Returns every override stored afterwards.
 *
 * Rollback safety for one release: the result is also copied into
 * `organization.metadata.capabilities`, which the previous release reads.
 * The next release stops copying and a migration removes that key.
 */
export async function setOrganizationFeatureOverrides(
  database: Db,
  input: {
    organizationId: string
    changes: FeatureOverrideChanges
    source: "platform"
    setByUserId?: string | null
  },
): Promise<FeatureOverrides> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const setByUserId = input.setByUserId ? normalizeDenTypeId("user", input.setByUserId) : null
  return database.transaction(async (tx) => {
    const [organization] = await tx
      .select({ metadata: OrganizationTable.metadata })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, organizationId))
      .limit(1)
      .for("update")
    if (!organization) throw new Error("organization_not_found")

    for (const [key, value] of Object.entries(input.changes)) {
      if (!isFeatureKey(key) || value === undefined) continue
      if (value === null) {
        await tx.delete(OrganizationFeatureTable).where(and(
          eq(OrganizationFeatureTable.organization_id, organizationId),
          eq(OrganizationFeatureTable.feature_key, key),
        ))
        continue
      }
      await tx.insert(OrganizationFeatureTable)
        .values({ organization_id: organizationId, feature_key: key, enabled: value, source: input.source, set_by_user_id: setByUserId })
        .onDuplicateKeyUpdate({ set: { enabled: value, source: input.source, set_by_user_id: setByUserId } })
    }

    const overrides = await readOrganizationFeatureOverrides(tx, organizationId)
    const metadata = parseMetadata(organization.metadata)
    // The previous release also honored these flat aliases for Connect.
    delete metadata.connectEnabled
    delete metadata.mcpConnectionsEnabled
    if (Object.keys(overrides).length > 0) metadata.capabilities = { ...overrides }
    else delete metadata.capabilities
    await tx.update(OrganizationTable).set({ metadata }).where(eq(OrganizationTable.id, organizationId))
    return overrides
  })
}
