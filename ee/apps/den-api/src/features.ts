import {
  readFeatures,
  readOrganizationFeatureOverridesForMany,
  setFeatureRollout,
  setMemberFeatureOverrides,
  setOrganizationFeatureOverrides,
  type FeatureDatabase,
} from "@openwork-ee/den-db/organization-features"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { resolveFeatures, type FeatureKey, type FeatureMap } from "@openwork/features"
import type { MiddlewareHandler } from "hono"
import { cache } from "./cache.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { markFeaturesUsed } from "./feature-usage.js"
import type { OrganizationContextVariables } from "./middleware/organization-context.js"

/**
 * The only way den-api asks whether a feature is on, and the only way it
 * changes one.
 *
 * Features are declared in packages/features/src/registry.ts (read
 * .opencode/skills/add-a-feature first). Never read organization metadata or
 * environment variables to decide whether a feature is on.
 *
 * Writes use updateFeatureRollout / updateOrganizationFeatureOverrides /
 * updateMemberFeatureOverrides below, which invalidate the shared cache. Never
 * call den-db's setFeatureRollout, setOrganizationFeatureOverrides or
 * setMemberFeatureOverrides directly from den-api.
 */

export type { FeatureKey, FeatureMap }

type ReadOptions = {
  /** Authenticated user: overrides apply only to their active membership in this organization. */
  userId?: string
  /** A transaction: always read from it, never from the cache. */
  database?: FeatureDatabase
  /** Locks the override rows until the transaction commits; never cached. */
  lock?: "share"
}

/** The organization row read directly from the database for authorization. */
export async function readOrganizationForAuthorization(organizationId: string) {
  const [organization] = await db.select().from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return organization ? { organization } : null
}

/**
 * Effective on/off for every feature, for one organization. Pass the
 * transaction (and `lock: "share"`) when the answer must be read from the
 * database and stay stable until commit.
 */
export async function getOrganizationFeatures(organizationId: string, options: ReadOptions = {}): Promise<FeatureMap> {
  if (options.database || options.lock) {
    return readFeatures(options.database ?? db, organizationId, env.features, { lock: options.lock, userId: options.userId })
  }
  const id = normalizeDenTypeId("organization", organizationId)
  const userId = options.userId ? normalizeDenTypeId("user", options.userId) : undefined
  const { rollouts, overrides, memberOverrides } = await cache.features.state(id, userId)
  return resolveFeatures({ ...env.features, rollouts, overrides, memberOverrides })
}

export async function organizationFeatureEnabled(organizationId: string, key: FeatureKey, options: ReadOptions = {}): Promise<boolean> {
  return (await getOrganizationFeatures(organizationId, options))[key]
}

/**
 * Effective features for several organizations: cached rollouts and batched
 * override reads, keyed by the ids as given.
 */
export async function getFeaturesForOrganizations(organizationIds: readonly string[]): Promise<Map<string, FeatureMap>> {
  const result = new Map<string, FeatureMap>()
  if (organizationIds.length === 0) return result
  const [rollouts, overrides] = await Promise.all([
    cache.features.rollouts(),
    readOrganizationFeatureOverridesForMany(db, [...organizationIds]),
  ])
  for (const organizationId of organizationIds) {
    result.set(organizationId, resolveFeatures({ ...env.features, rollouts, overrides: overrides.get(organizationId) ?? {} }))
  }
  return result
}

/**
 * Deployment-wide on/off for a feature that no organization owns: the state
 * for everyone after the kill switch and operator locks, with no organization
 * override. Flags are cached.
 */
export async function deploymentFeatureEnabled(key: FeatureKey): Promise<boolean> {
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

/** Changes one member's feature overrides, then clears the feature cache on every replica. */
export async function updateMemberFeatureOverrides(input: Parameters<typeof setMemberFeatureOverrides>[1]) {
  try {
    return await setMemberFeatureOverrides(db, input)
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
    // A request through a gated route is a use of the feature, for /admin.
    markFeaturesUsed({ organizationId: payload.organization.id, memberId: payload.currentMember.id, keys: [key] })
    await next()
  }
}
