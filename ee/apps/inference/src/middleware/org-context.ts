import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createMiddleware } from "hono/factory"
import type { InferenceAuthVariables } from "./inference-auth.js"

export type OrganizationContext = {
  id: string
  metadata: Record<string, unknown> | null
}

export type OrganizationVariables = {
  organization: OrganizationContext | null
}

export type OrgContextEnv = { Variables: InferenceAuthVariables & OrganizationVariables }

export type LoadOrganization = (organizationId: string) => Promise<OrganizationContext | null>

export type OrgContextDependencies = {
  loadOrganization: LoadOrganization
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

type CacheEntry = { value: OrganizationContext | null; expiresAt: number }

const defaultTtlMs = 60_000
const defaultMaxEntries = 1_000

export const loadOrganizationFromDb: LoadOrganization = async (organizationId) => {
  const { db } = await import("../db.js")
  const [row] = await db
    .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return row ? { id: row.id, metadata: row.metadata ?? null } : null
}

export function orgContext(dependencies: OrgContextDependencies) {
  const ttlMs = dependencies.ttlMs ?? defaultTtlMs
  const maxEntries = dependencies.maxEntries ?? defaultMaxEntries
  const now = dependencies.now ?? Date.now
  const cache = new Map<string, CacheEntry>()

  async function load(organizationId: string) {
    const current = now()
    const cached = cache.get(organizationId)
    if (cached && cached.expiresAt > current) return cached.value

    const value = await dependencies.loadOrganization(organizationId)
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(organizationId, { value, expiresAt: current + ttlMs })
    return value
  }

  return createMiddleware<OrgContextEnv>(async (c, next) => {
    c.set("organization", await load(c.get("inference").organizationId))
    await next()
  })
}
