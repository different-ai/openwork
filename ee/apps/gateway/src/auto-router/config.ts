// Loads an organization's Auto Router (packages/types/src/den/auto-router.ts)
// and whether the `autoRouter` feature is on for it. Both are cached briefly:
// every Auto request needs them, and an admin's change or the kill switch
// takes effect within the cache lifetime.
import { and, asc, eq } from "@openwork-ee/den-db/drizzle"
import { AutoRouterRouteTable, AutoRouterTable } from "@openwork-ee/den-db"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { AUTO_ROUTER_THINKING_LEVELS, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router"
import { env } from "../env.js"

export type AutoRouterConfigRoute = {
  id: string
  providerId: string
  modelId: string
  prompt: string
  thinkingLevels: AutoRouterThinkingLevel[]
}

export type AutoRouterConfig = { routes: AutoRouterConfigRoute[] }

/** The organization's enabled Auto Router, or null when it is off, unconfigured, or the feature is off. */
export type LoadAutoRouterConfig = (input: { organizationId: string }) => Promise<AutoRouterConfig | null>

const CACHE_MS = 15_000
const cache = new Map<string, { expires: number; value: AutoRouterConfig | null }>()

function isThinkingLevel(value: string): value is AutoRouterThinkingLevel {
  return AUTO_ROUTER_THINKING_LEVELS.some((level) => level === value)
}

async function readConfig(organizationId: string): Promise<AutoRouterConfig | null> {
  if (!isDenTypeId("organization", organizationId)) return null
  const { db } = await import("../db.js")
  const features = await readFeatures(db, organizationId, env.features)
  if (!features.autoRouter) return null
  const [router] = await db.select().from(AutoRouterTable).where(eq(AutoRouterTable.organizationId, organizationId)).limit(1)
  if (!router?.enabled) return null
  const rows = await db.select().from(AutoRouterRouteTable)
    .where(and(eq(AutoRouterRouteTable.autoRouterId, router.id), eq(AutoRouterRouteTable.organizationId, organizationId)))
    .orderBy(asc(AutoRouterRouteTable.position))
  const routes = rows.map((row) => ({
    id: row.id,
    providerId: row.gatewayProviderId,
    modelId: row.modelId,
    prompt: row.prompt,
    thinkingLevels: row.thinkingLevels.filter(isThinkingLevel),
  })).filter((route) => route.thinkingLevels.length > 0)
  return routes.length > 0 ? { routes } : null
}

export const loadAutoRouterConfigFromDb: LoadAutoRouterConfig = async ({ organizationId }) => {
  const now = Date.now()
  const hit = cache.get(organizationId)
  if (hit && hit.expires > now) return hit.value
  const value = await readConfig(organizationId)
  cache.set(organizationId, { expires: now + CACHE_MS, value })
  if (cache.size > 5000) for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key)
  return value
}
