import { and, desc, eq, inArray, isNull, or } from "drizzle-orm"
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
import { AuthUserTable } from "./schema/auth"
import { MemberTable, OrganizationTable } from "./schema/org"
import { FeatureChangeTable, FeatureRolloutTable, MemberFeatureTable, OrganizationFeatureTable } from "./schema/organization-features"

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
  options: { lock?: "share"; userId?: string } = {},
): Promise<FeatureMap> {
  // Sequential on purpose: callers may pass a transaction, and a PlanetScale
  // transaction is one session that fails when two queries are in flight.
  const rollouts = await readFeatureRollouts(database)
  const overrides = organizationId ? await readOrganizationFeatureOverrides(database, organizationId, options) : {}
  const memberOverrides = organizationId && options.userId ? await readMemberFeatureOverrides(database, organizationId, options.userId, options) : {}
  return resolveFeatures({ ...environment, rollouts, overrides, memberOverrides })
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
  await database.transaction(async (tx) => {
    const current = (await readFeatureRollouts(tx))[input.key]
    const wasEnabled = current?.enabled ?? input.defaultEnabled
    const wasKilled = current?.killed ?? false
    const enabled = input.enabled ?? wasEnabled
    const killed = input.killed ?? wasKilled
    await tx.insert(FeatureRolloutTable)
      .values({ feature_key: input.key, enabled, killed, updated_by_user_id: updatedByUserId })
      .onDuplicateKeyUpdate({ set: { enabled, killed, updated_by_user_id: updatedByUserId } })
    const changes: FeatureChangeAction[] = []
    if (killed !== wasKilled) changes.push(killed ? "killed" : "restored")
    if (enabled !== wasEnabled) changes.push(enabled ? "on" : "off")
    await recordFeatureChanges(tx, changes.map((action) => ({ key: input.key, scope: "everyone", action, changedByUserId: updatedByUserId })))
  })
  return readFeatureRollouts(database)
}

export type FeatureChangeScope = (typeof FeatureChangeTable.$inferSelect)["scope"]
export type FeatureChangeAction = (typeof FeatureChangeTable.$inferSelect)["action"]

/** The most recent change to one feature, with who made it. */
export type FeatureChange = {
  scope: FeatureChangeScope
  action: FeatureChangeAction
  at: Date
  /** Null when the change was made without a signed-in person (e.g. a deploy-time script) or the user was deleted. */
  by: { id: string; name: string; email: string } | null
}

type FeatureChangeInput = {
  key: FeatureKey
  scope: FeatureChangeScope
  action: FeatureChangeAction
  organizationId?: string | null
  memberId?: string | null
  changedByUserId: string | null
}

/** Appends to the feature history. Call inside the transaction that made the change. */
async function recordFeatureChanges(database: FeatureDatabase, changes: FeatureChangeInput[]): Promise<void> {
  if (changes.length === 0) return
  await database.insert(FeatureChangeTable).values(changes.map((change) => ({
    feature_key: change.key,
    scope: change.scope,
    action: change.action,
    organization_id: change.organizationId ? normalizeDenTypeId("organization", change.organizationId) : null,
    member_id: change.memberId ? normalizeDenTypeId("member", change.memberId) : null,
    changed_by_user_id: change.changedByUserId ? normalizeDenTypeId("user", change.changedByUserId) : null,
  })))
}

/** What a stored override change does to the history: nothing when the value is the same. */
function overrideChangeAction(previous: boolean | undefined, next: boolean | null): FeatureChangeAction | null {
  if (next === null) return previous === undefined ? null : "reset"
  return previous === next ? null : next ? "on" : "off"
}

function latestPerFeature(rows: Array<{
  feature_key: string
  scope: FeatureChangeScope
  action: FeatureChangeAction
  created_at: Date
  user_id: string | null
  user_name: string | null
  user_email: string | null
}>): Partial<Record<FeatureKey, FeatureChange>> {
  const latest: Partial<Record<FeatureKey, FeatureChange>> = {}
  // Rows arrive newest first: the first one per key wins.
  for (const row of rows) {
    if (!isFeatureKey(row.feature_key) || latest[row.feature_key]) continue
    latest[row.feature_key] = {
      scope: row.scope,
      action: row.action,
      at: row.created_at,
      by: row.user_id && row.user_name !== null && row.user_email !== null ? { id: row.user_id, name: row.user_name, email: row.user_email } : null,
    }
  }
  return latest
}

const featureChangeColumns = {
  feature_key: FeatureChangeTable.feature_key,
  scope: FeatureChangeTable.scope,
  action: FeatureChangeTable.action,
  created_at: FeatureChangeTable.created_at,
  user_id: AuthUserTable.id,
  user_name: AuthUserTable.name,
  user_email: AuthUserTable.email,
}

/**
 * The latest change per feature that could have changed what one organization
 * gets (its own override or the deployment-wide state), or, without an
 * organization, the latest deployment-wide change per feature.
 */
export async function readLatestFeatureChanges(
  database: FeatureDatabase,
  input: { organizationId?: string | null; memberId?: string | null } = {},
): Promise<Partial<Record<FeatureKey, FeatureChange>>> {
  const scopes = [eq(FeatureChangeTable.scope, "everyone")]
  if (input.organizationId) {
    const organizationId = normalizeDenTypeId("organization", input.organizationId)
    scopes.push(and(eq(FeatureChangeTable.scope, "organization"), eq(FeatureChangeTable.organization_id, organizationId))!)
    if (input.memberId) {
      scopes.push(and(
        eq(FeatureChangeTable.scope, "member"),
        eq(FeatureChangeTable.organization_id, organizationId),
        eq(FeatureChangeTable.member_id, normalizeDenTypeId("member", input.memberId)),
      )!)
    }
  }
  const rows = await database.select(featureChangeColumns)
    .from(FeatureChangeTable)
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, FeatureChangeTable.changed_by_user_id))
    .where(or(...scopes))
    .orderBy(desc(FeatureChangeTable.created_at), desc(FeatureChangeTable.id))
  return latestPerFeature(rows)
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

    const previous = await readOrganizationFeatureOverrides(tx, organizationId)
    const history: FeatureChangeInput[] = []
    for (const [key, value] of Object.entries(input.changes)) {
      if (!isFeatureKey(key) || value === undefined) continue
      const action = overrideChangeAction(previous[key], value)
      if (action) history.push({ key, scope: "organization", action, organizationId, changedByUserId: setByUserId })
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
    await recordFeatureChanges(tx, history)

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

/**
 * Active members that have at least one override, as `organizationId:userId`.
 * Member overrides are rare, so den-api caches this list for the whole
 * deployment and reads overrides, always fresh, only for these members.
 */
export async function readMembersWithFeatureOverrides(database: FeatureDatabase): Promise<string[]> {
  const rows = await database.select({ organization_id: MemberTable.organizationId, user_id: MemberTable.userId })
    .from(MemberFeatureTable)
    .innerJoin(MemberTable, eq(MemberTable.id, MemberFeatureTable.member_id))
    .where(and(isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false)))
  return [...new Set(rows.flatMap((row) => row.user_id ? [`${row.organization_id}:${row.user_id}`] : []))]
}

/** Fresh, tenant-scoped member state: the values never enter the cache, so a replaced membership cannot inherit them. */
export async function readMemberFeatureOverrides(
  database: FeatureDatabase,
  organizationId: string,
  userId: string,
  options: { lock?: "share" } = {},
): Promise<FeatureOverrides> {
  const query = database.select({ feature_key: MemberFeatureTable.feature_key, enabled: MemberFeatureTable.enabled })
    .from(MemberFeatureTable)
    .innerJoin(MemberTable, eq(MemberTable.id, MemberFeatureTable.member_id))
    .where(and(
      eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)),
      eq(MemberTable.userId, normalizeDenTypeId("user", userId)),
      isNull(MemberTable.removedAt),
      eq(MemberTable.isSetupAgent, false),
    ))
  return toOverrides(await (options.lock ? query.for(options.lock) : query))
}

/** Lock and revalidate the membership in the same transaction as the write. */
export async function setMemberFeatureOverrides(database: Db, input: {
  organizationId: string
  memberId: string
  changes: FeatureOverrideChanges
  setByUserId: string
}): Promise<boolean> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const memberId = normalizeDenTypeId("member", input.memberId)
  const setByUserId = normalizeDenTypeId("user", input.setByUserId)
  return database.transaction(async (tx) => {
    const [member] = await tx.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
      eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false),
    )).limit(1).for("update")
    if (!member?.userId) return false
    const previous = toOverrides(await tx.select({ feature_key: MemberFeatureTable.feature_key, enabled: MemberFeatureTable.enabled })
      .from(MemberFeatureTable).where(eq(MemberFeatureTable.member_id, memberId)))
    const history: FeatureChangeInput[] = []
    for (const [key, value] of Object.entries(input.changes)) {
      if (!isFeatureKey(key) || value === undefined) continue
      const action = overrideChangeAction(previous[key], value)
      if (action) history.push({ key, scope: "member", action, organizationId, memberId, changedByUserId: setByUserId })
      if (value === null) {
        await tx.delete(MemberFeatureTable).where(and(eq(MemberFeatureTable.member_id, memberId), eq(MemberFeatureTable.feature_key, key)))
      } else {
        await tx.insert(MemberFeatureTable).values({ member_id: memberId, feature_key: key, enabled: value, set_by_user_id: setByUserId })
          .onDuplicateKeyUpdate({ set: { enabled: value, set_by_user_id: setByUserId } })
      }
    }
    await recordFeatureChanges(tx, history)
    return true
  })
}
