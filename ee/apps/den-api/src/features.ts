import {
  readFeatures,
  lockFeatureForMutation,
  readOrganizationFeatureOverridesForMany,
  readOrganizationMemberFeatureOverrides,
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

export type { FeatureKey, FeatureMap }

type ReadOptions = {
  userId?: string
  database?: FeatureDatabase
  lock?: "share"
}

export async function readOrganizationForAuthorization(organizationId: string) {
  const [organization] = await db.select().from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return organization ? { organization } : null
}

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

export async function lockOrganizationFeatureForMutation(database: Parameters<typeof lockFeatureForMutation>[0], organizationId: string, userId: string, key: FeatureKey): Promise<boolean> {
  return lockFeatureForMutation(database, organizationId, userId, key, env.features)
}

export async function getOrganizationFeaturesByMember(organizationId: string): Promise<{ organization: FeatureMap; forMember(memberId: string): FeatureMap }> {
  const id = normalizeDenTypeId("organization", organizationId)
  const [{ rollouts, overrides }, memberOverrides] = await Promise.all([
    cache.features.state(id),
    readOrganizationMemberFeatureOverrides(db, id),
  ])
  const organization = resolveFeatures({ ...env.features, rollouts, overrides })
  return {
    organization,
    forMember(memberId) {
      const own = memberOverrides.get(normalizeDenTypeId("member", memberId))
      return own ? resolveFeatures({ ...env.features, rollouts, overrides, memberOverrides: own }) : organization
    },
  }
}

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

export async function deploymentFeatureEnabled(key: FeatureKey): Promise<boolean> {
  return resolveFeatures({ ...env.features, rollouts: await cache.features.rollouts(), overrides: {} })[key]
}

export async function updateFeatureRollout(input: Parameters<typeof setFeatureRollout>[1]) {
  try {
    return await setFeatureRollout(db, input)
  } finally {
    await cache.features.invalidate()
  }
}

export async function updateOrganizationFeatureOverrides(input: Parameters<typeof setOrganizationFeatureOverrides>[1]) {
  try {
    return await setOrganizationFeatureOverrides(db, input)
  } finally {
    await cache.features.invalidate()
  }
}

export async function updateMemberFeatureOverrides(input: Parameters<typeof setMemberFeatureOverrides>[1]) {
  try {
    return await setMemberFeatureOverrides(db, input)
  } finally {
    await cache.features.invalidate()
  }
}

export function requireFeature(key: FeatureKey, message?: string): MiddlewareHandler<{ Variables: Partial<OrganizationContextVariables> }> {
  return async (c, next) => {
    const payload = c.get("organizationContext")
    if (!payload) return c.json({ error: "organization_not_found" }, 404)
    if (!payload.features[key]) return c.json({ error: "feature_disabled", feature: key, ...(message ? { message } : {}) }, 404)
    markFeaturesUsed({ organizationId: payload.organization.id, memberId: payload.currentMember.id, keys: [key] })
    await next()
  }
}

export function requireAnyFeature(keys: readonly [FeatureKey, ...FeatureKey[]]): MiddlewareHandler<{ Variables: Partial<OrganizationContextVariables> }> {
  return async (c, next) => {
    const payload = c.get("organizationContext")
    if (!payload) return c.json({ error: "organization_not_found" }, 404)
    const used = keys.filter((key) => payload.features[key])
    if (used.length === 0) return c.json({ error: "feature_disabled", feature: keys[0] }, 404)
    markFeaturesUsed({ organizationId: payload.organization.id, memberId: payload.currentMember.id, keys: used })
    await next()
  }
}
