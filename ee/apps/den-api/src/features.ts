import { readFeatures, type FeatureDatabase } from "@openwork-ee/den-db/organization-features"
import type { FeatureKey, FeatureMap } from "@openwork/features"
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
  /** The signed-in user, so features rolled out to people resolve for them too. */
  userId?: string | null
}

/**
 * Effective on/off for every feature, for one organization (and optionally
 * one of its members). Read fresh on every call, so an /admin change applies
 * to the next request. Pass the transaction (and `lock: "share"`) when the
 * answer must stay stable until commit.
 */
export function getOrganizationFeatures(organizationId: string, options: ReadOptions = {}): Promise<FeatureMap> {
  return readFeatures(options.database ?? db, { organizationId, personId: options.userId ?? null }, env.features, { lock: options.lock })
}

export async function organizationFeatureEnabled(organizationId: string, key: FeatureKey, options: ReadOptions = {}): Promise<boolean> {
  return (await getOrganizationFeatures(organizationId, options))[key]
}

/**
 * Route guard for organization routes: answers 404 `feature_disabled` as if the
 * route did not exist when the feature is off for the caller. Use after
 * orgMemberRoute()/orgRoleRoute().
 */
export function requireFeature(key: FeatureKey): MiddlewareHandler<{ Variables: Partial<OrganizationContextVariables> }> {
  return async (c, next) => {
    const payload = c.get("organizationContext")
    if (!payload) return c.json({ error: "organization_not_found" }, 404)
    const enabled = await organizationFeatureEnabled(payload.organization.id, key, { userId: payload.currentMember.userId })
    if (!enabled) return c.json({ error: "feature_disabled", feature: key }, 404)
    await next()
  }
}
