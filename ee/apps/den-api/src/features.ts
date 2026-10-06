import { readFeatures, type FeatureDatabase } from "@openwork-ee/den-db/organization-features"
import { featureDefinition, type FeatureKey, type FeatureMap } from "@openwork/features"
import type { MiddlewareHandler } from "hono"
import { db } from "./db.js"
import { env } from "./env.js"
import type { OrganizationContextVariables } from "./middleware/organization-context.js"

/**
 * The only way den-api asks whether a feature is on.
 *
 * Features are declared in packages/features/src/registry.ts (read
 * .opencode/skills/add-a-feature first). Never read organization metadata or
 * environment variables to decide whether a feature is on.
 */

export type { FeatureKey, FeatureMap }

type ReadOptions = {
  database?: FeatureDatabase
  lock?: "share"
}

/**
 * Effective on/off for every feature, for one organization. Read fresh on
 * every call, so an /admin change applies to the next request. Pass the
 * transaction (and `lock: "share"`) when the answer must stay stable until commit.
 */
export function getOrganizationFeatures(organizationId: string, options: ReadOptions = {}): Promise<FeatureMap> {
  return readFeatures(options.database ?? db, organizationId, env.features, { lock: options.lock })
}

export async function organizationFeatureEnabled(organizationId: string, key: FeatureKey, options: ReadOptions = {}): Promise<boolean> {
  return (await getOrganizationFeatures(organizationId, options))[key]
}

/**
 * Route guard for organization routes: answers 404 `feature_disabled` as if the
 * route did not exist when the feature is off for the caller's organization. Use after
 * orgMemberRoute()/orgRoleRoute().
 */
export function requireFeature(key: FeatureKey): MiddlewareHandler<{ Variables: Partial<OrganizationContextVariables> }> {
  return async (c, next) => {
    const payload = c.get("organizationContext")
    if (!payload) return c.json({ error: "organization_not_found" }, 404)
    const enabled = await organizationFeatureEnabled(payload.organization.id, key)
    if (!enabled) return c.json({ error: "feature_disabled", feature: key }, 404)
    await next()
  }
}

/**
 * For routes of a deprecated feature (registry `deprecated`): every response
 * carries `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers, so clients
 * and their logs see the removal date. Put it first, before auth.
 */
export function announceDeprecation(key: FeatureKey): MiddlewareHandler {
  const deprecated = featureDefinition(key).deprecated
  return async (c, next) => {
    await next()
    if (!deprecated) return
    c.header("Deprecation", `@${Math.floor(Date.parse(`${deprecated.announced}T00:00:00Z`) / 1000)}`)
    c.header("Sunset", new Date(`${deprecated.removeBy}T00:00:00Z`).toUTCString())
  }
}
