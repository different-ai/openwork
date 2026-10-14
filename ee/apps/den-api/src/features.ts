import {
  readFeatureRollouts,
  readFeatures,
  readOrganizationFeatureOverridesForMany,
  setFeatureRollout,
  setOrganizationFeatureOverrides,
  type FeatureDatabase,
} from "@openwork-ee/den-db/organization-features"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { FeatureRolloutTable, OrganizationFeatureTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { resolveFeature, resolveFeatures, type FeatureKey, type FeatureMap, type ResolvedFeature } from "@openwork/features"
import type { MiddlewareHandler } from "hono"
import { cache } from "./cache.js"
import { db } from "./db.js"
import { env } from "./env.js"
import type { OrganizationContextVariables } from "./middleware/organization-context.js"

/**
 * The only way den-api asks whether a feature is on, and the only way it
 * changes one.
 *
 * Features are declared in packages/features/src/registry.ts (read
 * .opencode/skills/add-a-feature first). Never read organization metadata or
 * environment variables to decide whether a feature is on.
 *
 * Ordinary flags use the shared Redis cache (cache.features). The permissions
 * flag is authority: read its rollout, kill switch and org override from the
 * database on every resolution. Failed Redis invalidation or snapshot rollback
 * must never keep database-configured permission grants active.
 * Writes use updateFeatureRollout / updateOrganizationFeatureOverrides below,
 * which invalidate the shared cache. Never call den-db's setFeatureRollout or
 * setOrganizationFeatureOverrides directly from den-api.
 */

export type { FeatureKey, FeatureMap }

type ReadOptions = {
  /** A database pool or transaction: always read from it, never from the cache. */
  database?: FeatureDatabase
  /** Locks the override rows until the transaction commits; never cached. */
  lock?: "share"
  /**
   * The permissions flag this request already read live with the organization
   * row (readOrganizationWithPermissions), so it is not read again. Ignored
   * with `database` or `lock`, which read every flag fresh.
   */
  permissions?: boolean
}

type PermissionFeatureRow = { rolloutEnabled: boolean | null; killed: boolean | null; overrideEnabled: boolean | null }

const permissionFeatureColumns = {
  rolloutEnabled: FeatureRolloutTable.enabled,
  killed: FeatureRolloutTable.killed,
  overrideEnabled: OrganizationFeatureTable.enabled,
}
const permissionRolloutJoin = eq(FeatureRolloutTable.feature_key, "permissions")
const permissionOverrideJoin = and(
  eq(OrganizationFeatureTable.organization_id, OrganizationTable.id),
  eq(OrganizationFeatureTable.feature_key, "permissions"),
)

function resolvePermissionFeature(row: PermissionFeatureRow): boolean {
  return resolveFeature("permissions", {
    ...env.features,
    rollouts: row.rolloutEnabled === null ? {} : { permissions: { enabled: row.rolloutEnabled, killed: row.killed ?? false } },
    overrides: row.overrideEnabled === null ? {} : { permissions: row.overrideEnabled },
  }).enabled
}

/** One indexed read for authorization state, independent of Redis availability. */
async function readPermissionFeatures(organizationIds: readonly string[]): Promise<Map<string, boolean>> {
  const ids = organizationIds.map((id) => normalizeDenTypeId("organization", id))
  const rows = await db.select({ organizationId: OrganizationTable.id, ...permissionFeatureColumns })
    .from(OrganizationTable)
    .leftJoin(FeatureRolloutTable, permissionRolloutJoin)
    .leftJoin(OrganizationFeatureTable, permissionOverrideJoin)
    .where(inArray(OrganizationTable.id, ids))
  return new Map(rows.map((row) => [row.organizationId, resolvePermissionFeature(row)]))
}

/**
 * The organization row and its live permissions flag in the same indexed read
 * as readPermissionFeatures. The organization context passes the flag to
 * getOrganizationFeatures, so authorization still comes from the database
 * without a second query.
 */
export async function readOrganizationWithPermissions(organizationId: string) {
  const [row] = await db.select({ organization: OrganizationTable, ...permissionFeatureColumns })
    .from(OrganizationTable)
    .leftJoin(FeatureRolloutTable, permissionRolloutJoin)
    .leftJoin(OrganizationFeatureTable, permissionOverrideJoin)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return row ? { organization: row.organization, permissions: resolvePermissionFeature(row) } : null
}

async function readDeploymentPermissionsFeature(): Promise<boolean> {
  const [row] = await db.select({ enabled: FeatureRolloutTable.enabled, killed: FeatureRolloutTable.killed })
    .from(FeatureRolloutTable).where(eq(FeatureRolloutTable.feature_key, "permissions"))
  return resolveFeature("permissions", {
    ...env.features,
    rollouts: row ? { permissions: row } : {},
    overrides: {},
  }).enabled
}

/**
 * Effective on/off for every feature, for one organization. Permissions is
 * database-authoritative; other flags are cached. Pass the
 * transaction (and `lock: "share"`) when the answer must be read from the
 * database and stay stable until commit.
 */
export async function getOrganizationFeatures(organizationId: string, options: ReadOptions = {}): Promise<FeatureMap> {
  if (options.database || options.lock) {
    return readFeatures(options.database ?? db, organizationId, env.features, { lock: options.lock })
  }
  const id = normalizeDenTypeId("organization", organizationId)
  const [{ rollouts, overrides }, permissions] = await Promise.all([
    cache.features.state(id),
    options.permissions === undefined ? readPermissionFeatures([id]) : null,
  ])
  return {
    ...resolveFeatures({ ...env.features, rollouts, overrides }),
    permissions: options.permissions ?? permissions?.get(id) ?? resolveFeature("permissions", { ...env.features, rollouts: {}, overrides: {} }).enabled,
  }
}

export async function organizationFeatureEnabled(organizationId: string, key: FeatureKey, options: ReadOptions = {}): Promise<boolean> {
  if (options.database || options.lock) return (await getOrganizationFeatures(organizationId, options))[key]
  const id = normalizeDenTypeId("organization", organizationId)
  if (key === "permissions") {
    return (await readPermissionFeatures([id])).get(id) ?? resolveFeature("permissions", { ...env.features, rollouts: {}, overrides: {} }).enabled
  }
  const { rollouts, overrides } = await cache.features.state(id)
  return resolveFeature(key, { ...env.features, rollouts, overrides }).enabled
}

/**
 * Deployment constraints for app-level plumbing that has no organization.
 * This excludes organization overrides and is never organization authorization.
 */
export async function getDeploymentFeatureState(key: FeatureKey, options: ReadOptions = {}): Promise<ResolvedFeature> {
  return resolveFeature(key, {
    ...env.features,
    rollouts: await readFeatureRollouts(options.database ?? db),
    overrides: {},
  })
}

/**
 * Effective features for several organizations: cached ordinary rollouts,
 * batched override and live permission-state reads, keyed by the ids as given.
 */
export async function getFeaturesForOrganizations(organizationIds: readonly string[]): Promise<Map<string, FeatureMap>> {
  const result = new Map<string, FeatureMap>()
  if (organizationIds.length === 0) return result
  const [rollouts, overrides, permissions] = await Promise.all([
    cache.features.rollouts(),
    readOrganizationFeatureOverridesForMany(db, [...organizationIds]),
    readPermissionFeatures(organizationIds),
  ])
  for (const organizationId of organizationIds) {
    const id = normalizeDenTypeId("organization", organizationId)
    result.set(organizationId, {
      ...resolveFeatures({ ...env.features, rollouts, overrides: overrides.get(organizationId) ?? {} }),
      permissions: permissions.get(id) ?? resolveFeature("permissions", { ...env.features, rollouts: {}, overrides: {} }).enabled,
    })
  }
  return result
}

/**
 * Deployment-wide on/off for a feature that no organization owns: the state
 * for everyone after the kill switch and operator locks, with no organization
 * override. Ordinary flags are cached; permissions always reads the database.
 */
export async function deploymentFeatureEnabled(key: FeatureKey): Promise<boolean> {
  if (key === "permissions") return readDeploymentPermissionsFeature()
  return resolveFeatures({ ...env.features, rollouts: await cache.features.rollouts(), overrides: {} })[key]
}

/** Changes a feature for the whole deployment, then clears the feature cache on every replica. */
export async function updateFeatureRollout(input: Parameters<typeof setFeatureRollout>[1]) {
  try {
    return await setFeatureRollout(db, input)
  } finally {
    // Also on failure: the write may have landed before the error surfaced.
    await cache.features.invalidate()
  }
}

/** Changes one organization's feature overrides, then clears the feature cache on every replica. */
export async function updateOrganizationFeatureOverrides(input: Parameters<typeof setOrganizationFeatureOverrides>[1]) {
  try {
    return await setOrganizationFeatureOverrides(db, input)
  } finally {
    // After the commit (or a failure that may have committed).
    await cache.features.invalidate()
  }
}

/**
 * Route guard for organization routes: answers 404 `feature_disabled` as if the
 * route did not exist when the feature is off for the caller's organization. Use after
 * orgMemberRoute()/orgRoleRoute()/orgPermissionRoute(). Uses the features the
 * organization context already read for this request.
 */
export function requireFeature(key: FeatureKey): MiddlewareHandler<{ Variables: Partial<OrganizationContextVariables> }> {
  return async (c, next) => {
    const payload = c.get("organizationContext")
    if (!payload) return c.json({ error: "organization_not_found" }, 404)
    // Reuse the feature snapshot already resolved for this request.
    if (!payload.features[key]) return c.json({ error: "feature_disabled", feature: key }, 404)
    await next()
  }
}
