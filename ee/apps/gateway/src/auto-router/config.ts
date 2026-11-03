// Loads one Smart Router (packages/types/src/den/auto-router.ts) for a member:
// only when the `autoRouter` feature is on for the organization and the
// router is assigned to the member (everyone, one of their teams, or them).
// Routers and team memberships are cached briefly: every Smart request needs
// them, and an admin's change or the kill switch takes effect within the
// cache lifetime.
import { and, asc, eq } from "@openwork-ee/den-db/drizzle"
import {
  AutoRouterAccessTable,
  AutoRouterModelTable,
  AutoRouterModelTaskTable,
  AutoRouterTable,
  AutoRouterTaskTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { autoRouterAssignmentIncludes, type AutoRouterAssignment } from "@openwork/types/den/auto-router"
import { env } from "../env.js"

export type AutoRouterConfigModel = {
  id: string
  providerId: string
  modelId: string
  tasks: string[]
}

/** One router; models in the admin's order (the first wins ties and is the fallback). */
export type AutoRouterConfig = { id: string; name: string; models: AutoRouterConfigModel[] }

type StoredRouter = AutoRouterConfig & { assignment: AutoRouterAssignment }

/**
 * The router the member asked for, or null when the feature is off, the
 * router does not exist in the organization, or it is not assigned to them.
 */
export type LoadAutoRouterConfig = (input: { organizationId: string; routerId: string; memberId: string }) => Promise<AutoRouterConfig | null>

const CACHE_MS = 15_000
const routerCache = new Map<string, { expires: number; value: StoredRouter[] }>()
const teamCache = new Map<string, { expires: number; value: string[] }>()

function prune<T>(cache: Map<string, { expires: number; value: T }>, now: number) {
  if (cache.size > 5000) for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key)
}

async function readRouters(organizationId: string): Promise<StoredRouter[]> {
  if (!isDenTypeId("organization", organizationId)) return []
  const { db } = await import("../db.js")
  const features = await readFeatures(db, organizationId, env.features)
  if (!features.autoRouter) return []
  const routers = await db.select().from(AutoRouterTable).where(eq(AutoRouterTable.organizationId, organizationId))
  if (routers.length === 0) return []
  const [access, models, links] = await Promise.all([
    db.select().from(AutoRouterAccessTable).where(eq(AutoRouterAccessTable.organizationId, organizationId)),
    db.select().from(AutoRouterModelTable).where(eq(AutoRouterModelTable.organizationId, organizationId)).orderBy(asc(AutoRouterModelTable.position)),
    db.select({ modelId: AutoRouterModelTaskTable.autoRouterModelId, name: AutoRouterTaskTable.name })
      .from(AutoRouterModelTaskTable)
      .innerJoin(AutoRouterTaskTable, eq(AutoRouterTaskTable.id, AutoRouterModelTaskTable.taskId))
      .where(eq(AutoRouterModelTaskTable.organizationId, organizationId))
      .orderBy(asc(AutoRouterModelTaskTable.position)),
  ])
  return routers.map((router) => {
    const grants = access.filter((grant) => grant.autoRouterId === router.id)
    return {
      id: router.id,
      name: router.name,
      assignment: {
        everyone: grants.some((grant) => grant.orgWide),
        teamIds: grants.flatMap((grant) => grant.teamId ? [grant.teamId] : []),
        memberIds: grants.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : []),
      },
      models: models.filter((model) => model.autoRouterId === router.id).map((model) => ({
        id: model.id,
        providerId: model.gatewayProviderId,
        modelId: model.modelId,
        tasks: links.filter((link) => link.modelId === model.id).map((link) => link.name),
      })),
    }
  })
}

async function readMemberTeams(organizationId: string, memberId: string): Promise<string[]> {
  if (!isDenTypeId("organization", organizationId) || !isDenTypeId("member", memberId)) return []
  const { db } = await import("../db.js")
  const rows = await db.select({ id: TeamMemberTable.teamId }).from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamTable.id, TeamMemberTable.teamId))
    .where(and(eq(TeamMemberTable.orgMembershipId, memberId), eq(TeamTable.organizationId, organizationId)))
  return rows.map((row) => row.id)
}

async function cached<T>(cache: Map<string, { expires: number; value: T }>, key: string, read: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.value
  const value = await read()
  cache.set(key, { expires: now + CACHE_MS, value })
  prune(cache, now)
  return value
}

export const loadAutoRouterConfigFromDb: LoadAutoRouterConfig = async ({ organizationId, routerId, memberId }) => {
  const routers = await cached(routerCache, organizationId, () => readRouters(organizationId))
  const router = routers.find((entry) => entry.id === routerId)
  if (!router || router.models.length === 0) return null
  const teamIds = await cached(teamCache, `${organizationId}:${memberId}`, () => readMemberTeams(organizationId, memberId))
  if (!autoRouterAssignmentIncludes(router.assignment, memberId, teamIds)) return null
  return { id: router.id, name: router.name, models: router.models }
}
