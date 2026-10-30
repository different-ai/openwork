import { and, asc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AutoRouterAccessTable,
  AutoRouterModelTable,
  AutoRouterModelTaskTable,
  AutoRouterTable,
  AutoRouterTaskTable,
  GatewayCredentialSetTable,
  GatewayModelGroupModelTable,
  GatewayModelGroupTable,
  GatewayProviderAccessTable,
  GatewayProviderModelTable,
  GatewayProviderTable,
  MemberTable,
  OrganizationTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  AUTO_ROUTER_SUPPORTED_NPM,
  autoRouterAssignmentIncludes,
  autoRouterTaskKey,
  normalizeAutoRouterTaskName,
  type AutoRouter,
  type AutoRouterAssignment,
  type AutoRouterModelAccess,
  type AutoRouterModelOption,
  type AutoRouterRoutingState,
  type AutoRouterWrite,
} from "@openwork/types/den/auto-router"
import { db } from "./db.js"
import { env } from "./env.js"
import { gatewayManagementUnavailable } from "./gateway-deployment.js"
import { gatewayModelConfigurationError, readProviderConfigNpm } from "./llm/inference-provider-config.js"
import { effectiveGatewayGrants, memberGatewayTeams } from "./llm/inference-provider-lifecycle.js"

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">
type TeamId = DenTypeId<"team">
type AutoRouterId = DenTypeId<"autoRouter">
type Database = typeof db | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The SDK a model is called with: its own override, else its provider's. */
function modelNpm(providerConfig: Record<string, unknown>, modelConfig: Record<string, unknown>) {
  const override = isRecord(modelConfig.provider) && typeof modelConfig.provider.npm === "string" ? modelConfig.provider.npm : null
  return override ?? readProviderConfigNpm(providerConfig)
}

function supportedNpm(npm: string | null) {
  return npm !== null && AUTO_ROUTER_SUPPORTED_NPM.some((supported) => supported === npm)
}

function modelKey(providerId: string, modelId: string) {
  return `${providerId}\u0000${modelId}`
}

/**
 * Who can use each AI Gateway model through its access grants, keyed by
 * provider and catalog model id: grants on an active model group containing
 * the model, with an active credential set.
 */
async function readModelAccess(providerIds: string[]): Promise<Map<string, AutoRouterModelAccess>> {
  const access = new Map<string, AutoRouterModelAccess>()
  if (providerIds.length === 0) return access
  const rows = await db.select({ grant: GatewayProviderAccessTable, modelId: GatewayProviderModelTable.model_id })
    .from(GatewayProviderAccessTable)
    .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.status, "active")))
    .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.status, "active")))
    .innerJoin(GatewayModelGroupModelTable, eq(GatewayModelGroupModelTable.model_group_id, GatewayModelGroupTable.id))
    .innerJoin(GatewayProviderModelTable, eq(GatewayProviderModelTable.id, GatewayModelGroupModelTable.gateway_provider_model_id))
    .where(inArray(GatewayProviderAccessTable.gateway_provider_id, providerIds.map((id) => normalizeDenTypeId("inferenceProvider", id))))
  for (const row of rows) {
    const key = modelKey(row.grant.gateway_provider_id, row.modelId)
    const entry = access.get(key) ?? { everyone: false, teamIds: [], memberIds: [] }
    if (row.grant.org_membership_id) {
      if (!entry.memberIds.includes(row.grant.org_membership_id)) entry.memberIds.push(row.grant.org_membership_id)
    } else if (row.grant.team_id) {
      if (!entry.teamIds.includes(row.grant.team_id)) entry.teamIds.push(row.grant.team_id)
    } else {
      entry.everyone = true
    }
    access.set(key, entry)
  }
  return access
}

/**
 * Every AI Gateway model a Smart Router can send prompts to: each active
 * provider's catalog models that sit in at least one active model group and
 * whose protocol the gateway can translate a Smart request to, with who can
 * use each through the gateway's grants.
 */
export async function listAutoRouterOptions(organizationId: OrganizationId): Promise<AutoRouterModelOption[]> {
  if (gatewayManagementUnavailable()) return []
  const providers = await db.select().from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
  if (providers.length === 0) return []
  const providerIds = providers.map((provider) => provider.id)
  const [groups, models, access] = await Promise.all([
    db.select({ id: GatewayModelGroupTable.id }).from(GatewayModelGroupTable)
      .where(and(inArray(GatewayModelGroupTable.gateway_provider_id, providerIds), eq(GatewayModelGroupTable.status, "active"))),
    db.select().from(GatewayProviderModelTable).where(inArray(GatewayProviderModelTable.gateway_provider_id, providerIds)),
    readModelAccess(providerIds),
  ])
  const links = groups.length === 0 ? [] : await db
    .select({ modelRowId: GatewayModelGroupModelTable.gateway_provider_model_id })
    .from(GatewayModelGroupModelTable)
    .where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id)))
  const linked = new Set(links.map((link) => link.modelRowId))
  const options: AutoRouterModelOption[] = []
  for (const provider of providers) {
    const seen = new Set<string>()
    for (const model of models) {
      if (model.gateway_provider_id !== provider.id || !linked.has(model.id) || seen.has(model.model_id)) continue
      if (provider.model_ids.length > 0 && !provider.model_ids.includes(model.model_id)) continue
      if (gatewayModelConfigurationError(provider.provider_config, [model.model_config])) continue
      if (!supportedNpm(modelNpm(provider.provider_config, model.model_config))) continue
      seen.add(model.model_id)
      options.push({
        providerId: provider.id,
        modelId: model.model_id,
        providerName: provider.name,
        modelName: model.name,
        logoProviderId: provider.provider_id,
        access: access.get(modelKey(provider.id, model.model_id)) ?? { everyone: false, teamIds: [], memberIds: [] },
      })
    }
  }
  return options.sort((left, right) => left.providerName.localeCompare(right.providerName) || left.modelName.localeCompare(right.modelName))
}

async function readRouters(database: Database, organizationId: OrganizationId): Promise<AutoRouter[]> {
  // Sequential on purpose: callers may run inside a transaction, and a
  // PlanetScale transaction runs one query at a time.
  const routers = await database.select().from(AutoRouterTable).where(eq(AutoRouterTable.organizationId, organizationId))
  if (routers.length === 0) return []
  const access = await database.select().from(AutoRouterAccessTable).where(eq(AutoRouterAccessTable.organizationId, organizationId))
  const models = await database.select().from(AutoRouterModelTable)
    .where(eq(AutoRouterModelTable.organizationId, organizationId))
    .orderBy(asc(AutoRouterModelTable.position))
  const links = await database.select({ modelId: AutoRouterModelTaskTable.autoRouterModelId, name: AutoRouterTaskTable.name, position: AutoRouterModelTaskTable.position })
    .from(AutoRouterModelTaskTable)
    .innerJoin(AutoRouterTaskTable, eq(AutoRouterTaskTable.id, AutoRouterModelTaskTable.taskId))
    .where(eq(AutoRouterModelTaskTable.organizationId, organizationId))
    .orderBy(asc(AutoRouterModelTaskTable.position))
  return routers
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
    .map((router) => {
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
        updatedAt: router.updatedAt.toISOString(),
      }
    })
}

/** Every Smart Router of the organization, oldest first, and every task by name. */
export async function listAutoRouters(organizationId: OrganizationId): Promise<{ routers: AutoRouter[]; tasks: string[] }> {
  const routers = await readRouters(db, organizationId)
  const tasks = await db.select({ name: AutoRouterTaskTable.name }).from(AutoRouterTaskTable)
    .where(eq(AutoRouterTaskTable.organizationId, organizationId))
    .orderBy(asc(AutoRouterTaskTable.name))
  return { routers, tasks: tasks.map((task) => task.name) }
}

export async function readAutoRouter(organizationId: OrganizationId, routerId: string): Promise<AutoRouter | null> {
  if (!isDenTypeId("autoRouter", routerId)) return null
  return (await readRouters(db, organizationId)).find((router) => router.id === routerId) ?? null
}

export type AutoRouterWriteProblem = {
  error: "unknown_model" | "unknown_team" | "unknown_member"
  message: string
  /** The model's index in `models`, for unknown_model. */
  model?: number
}

/** Checks every model against the organization's options. */
export function checkAutoRouterWrite(input: AutoRouterWrite, options: AutoRouterModelOption[]): AutoRouterWriteProblem | null {
  for (const [index, model] of input.models.entries()) {
    if (!options.some((option) => option.providerId === model.providerId && option.modelId === model.modelId)) {
      return { error: "unknown_model", model: index, message: "That model isn't one your AI Gateway offers. Choose one from the list." }
    }
  }
  return null
}

/** Checks every assignee against the organization's teams and members. */
export async function checkAutoRouterAssignment(organizationId: OrganizationId, assignment: AutoRouterAssignment): Promise<AutoRouterWriteProblem | null> {
  const teamIds = [...new Set(assignment.teamIds)]
  if (teamIds.length > 0) {
    if (!teamIds.every((id) => isDenTypeId("team", id))) return { error: "unknown_team", message: "One of the teams no longer exists." }
    const teams = await db.select({ id: TeamTable.id }).from(TeamTable)
      .where(and(eq(TeamTable.organizationId, organizationId), inArray(TeamTable.id, teamIds.map((id) => normalizeDenTypeId("team", id)))))
    if (teams.length !== teamIds.length) return { error: "unknown_team", message: "One of the teams no longer exists." }
  }
  const memberIds = [...new Set(assignment.memberIds)]
  if (memberIds.length > 0) {
    if (!memberIds.every((id) => isDenTypeId("member", id))) return { error: "unknown_member", message: "One of the people is no longer in the organization." }
    const members = await db.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), inArray(MemberTable.id, memberIds.map((id) => normalizeDenTypeId("member", id)))))
    if (members.length !== memberIds.length) return { error: "unknown_member", message: "One of the people is no longer in the organization." }
  }
  return null
}

/** Serializes Smart Router writes of one organization, so shared tasks are created and removed consistently. */
async function lockOrganization(tx: Database, organizationId: OrganizationId) {
  await tx.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).for("update")
}

/** Removes tasks no router model uses anymore. */
async function deleteUnusedTasks(tx: Database, organizationId: OrganizationId) {
  const tasks = await tx.select({ id: AutoRouterTaskTable.id }).from(AutoRouterTaskTable).where(eq(AutoRouterTaskTable.organizationId, organizationId))
  if (tasks.length === 0) return
  const used = await tx.select({ taskId: AutoRouterModelTaskTable.taskId }).from(AutoRouterModelTaskTable)
    .where(eq(AutoRouterModelTaskTable.organizationId, organizationId))
  const keep = new Set(used.map((row) => row.taskId))
  const unused = tasks.map((task) => task.id).filter((id) => !keep.has(id))
  if (unused.length > 0) await tx.delete(AutoRouterTaskTable).where(inArray(AutoRouterTaskTable.id, unused))
}

async function deleteRouterModels(tx: Database, routerId: AutoRouterId) {
  const models = await tx.select({ id: AutoRouterModelTable.id }).from(AutoRouterModelTable).where(eq(AutoRouterModelTable.autoRouterId, routerId))
  if (models.length > 0) await tx.delete(AutoRouterModelTaskTable).where(inArray(AutoRouterModelTaskTable.autoRouterModelId, models.map((model) => model.id)))
  await tx.delete(AutoRouterModelTable).where(eq(AutoRouterModelTable.autoRouterId, routerId))
}

async function deleteRouterContents(tx: Database, routerId: AutoRouterId) {
  await deleteRouterModels(tx, routerId)
  await tx.delete(AutoRouterAccessTable).where(eq(AutoRouterAccessTable.autoRouterId, routerId))
}

/** The task rows for these names, creating the missing ones; keyed by `autoRouterTaskKey`. */
async function ensureTasks(tx: Database, organizationId: OrganizationId, names: string[]) {
  const wanted = new Map<string, string>()
  for (const name of names) {
    const key = autoRouterTaskKey(name)
    if (key && !wanted.has(key)) wanted.set(key, normalizeAutoRouterTaskName(name))
  }
  const keys = [...wanted.keys()]
  if (keys.length === 0) return new Map<string, DenTypeId<"autoRouterTask">>()
  const existing = await tx.select({ id: AutoRouterTaskTable.id, nameKey: AutoRouterTaskTable.nameKey }).from(AutoRouterTaskTable)
    .where(and(eq(AutoRouterTaskTable.organizationId, organizationId), inArray(AutoRouterTaskTable.nameKey, keys)))
  const ids = new Map(existing.map((task) => [task.nameKey, task.id]))
  const missing = keys.filter((key) => !ids.has(key))
  if (missing.length > 0) {
    const rows = missing.map((key) => ({ id: createDenTypeId("autoRouterTask"), organizationId, name: wanted.get(key) ?? key, nameKey: key }))
    await tx.insert(AutoRouterTaskTable).values(rows)
    for (const row of rows) ids.set(row.nameKey, row.id)
  }
  return ids
}

/**
 * Creates a router (no id; it applies to nobody yet) or replaces one's name,
 * models and their tasks, in one transaction. Who it applies to is kept; set
 * it with saveAutoRouterAssignment. Tasks are shared across the organization:
 * new names are created, and names no model uses anymore are removed. Returns
 * the router id, or null when `routerId` is not one of the organization's.
 */
export async function saveAutoRouter(input: {
  organizationId: OrganizationId
  memberId: MemberId
  routerId?: string
  write: AutoRouterWrite
}): Promise<AutoRouterId | null> {
  return db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId)
    let routerId: AutoRouterId
    if (input.routerId !== undefined) {
      if (!isDenTypeId("autoRouter", input.routerId)) return null
      const [existing] = await tx.select({ id: AutoRouterTable.id }).from(AutoRouterTable)
        .where(and(eq(AutoRouterTable.id, normalizeDenTypeId("autoRouter", input.routerId)), eq(AutoRouterTable.organizationId, input.organizationId))).limit(1)
      if (!existing) return null
      routerId = existing.id
      await tx.update(AutoRouterTable).set({ name: input.write.name, updatedByOrgMemberId: input.memberId }).where(eq(AutoRouterTable.id, routerId))
      await deleteRouterModels(tx, routerId)
    } else {
      routerId = createDenTypeId("autoRouter")
      await tx.insert(AutoRouterTable).values({
        id: routerId,
        organizationId: input.organizationId,
        name: input.write.name,
        createdByOrgMemberId: input.memberId,
        updatedByOrgMemberId: input.memberId,
      })
    }

    const taskIds = await ensureTasks(tx, input.organizationId, input.write.models.flatMap((model) => model.tasks))
    const models = input.write.models.map((model, position) => ({
      id: createDenTypeId("autoRouterModel"),
      autoRouterId: routerId,
      organizationId: input.organizationId,
      gatewayProviderId: normalizeDenTypeId("inferenceProvider", model.providerId),
      modelId: model.modelId,
      position,
    }))
    if (models.length > 0) await tx.insert(AutoRouterModelTable).values(models)
    const links = input.write.models.flatMap((model, index) => {
      const seen = new Set<string>()
      return model.tasks.flatMap((name) => {
        const taskId = taskIds.get(autoRouterTaskKey(name))
        if (!taskId || seen.has(taskId)) return []
        seen.add(taskId)
        return [{ autoRouterModelId: models[index].id, taskId, organizationId: input.organizationId, position: seen.size - 1 }]
      })
    })
    if (links.length > 0) await tx.insert(AutoRouterModelTaskTable).values(links)
    await deleteUnusedTasks(tx, input.organizationId)
    return routerId
  })
}

/**
 * Replaces who a router applies to. Making it apply to everyone needs
 * `canShareWithEveryone` unless it already does; that is decided against the
 * assignment read under the router's row lock, so a concurrent change cannot
 * slip an org-wide grant past the check. Returns `not_found` when `routerId`
 * is not one of the organization's routers.
 */
export async function saveAutoRouterAssignment(input: {
  organizationId: OrganizationId
  memberId: MemberId
  routerId: string
  assignment: AutoRouterAssignment
  canShareWithEveryone: boolean
}): Promise<"saved" | "not_found" | "needs_share_with_everyone"> {
  if (!isDenTypeId("autoRouter", input.routerId)) return "not_found"
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: AutoRouterTable.id }).from(AutoRouterTable)
      .where(and(eq(AutoRouterTable.id, normalizeDenTypeId("autoRouter", input.routerId)), eq(AutoRouterTable.organizationId, input.organizationId)))
      .for("update").limit(1)
    if (!existing) return "not_found"
    if (input.assignment.everyone && !input.canShareWithEveryone) {
      const [orgWide] = await tx.select({ id: AutoRouterAccessTable.id }).from(AutoRouterAccessTable)
        .where(and(eq(AutoRouterAccessTable.autoRouterId, existing.id), eq(AutoRouterAccessTable.orgWide, true))).limit(1)
      if (!orgWide) return "needs_share_with_everyone"
    }
    await tx.delete(AutoRouterAccessTable).where(eq(AutoRouterAccessTable.autoRouterId, existing.id))
    const rows = assignmentRows(input.organizationId, existing.id, input.assignment)
    if (rows.length > 0) await tx.insert(AutoRouterAccessTable).values(rows)
    await tx.update(AutoRouterTable).set({ updatedByOrgMemberId: input.memberId }).where(eq(AutoRouterTable.id, existing.id))
    return "saved"
  })
}

function assignmentRows(organizationId: OrganizationId, routerId: AutoRouterId, assignment: AutoRouterAssignment) {
  const base = { organizationId, autoRouterId: routerId }
  return [
    ...(assignment.everyone ? [{ ...base, id: createDenTypeId("autoRouterAccess"), orgWide: true, teamId: null, orgMembershipId: null }] : []),
    ...[...new Set(assignment.teamIds)].map((teamId) => ({ ...base, id: createDenTypeId("autoRouterAccess"), orgWide: false, teamId: normalizeDenTypeId("team", teamId), orgMembershipId: null })),
    ...[...new Set(assignment.memberIds)].map((memberId) => ({ ...base, id: createDenTypeId("autoRouterAccess"), orgWide: false, teamId: null, orgMembershipId: normalizeDenTypeId("member", memberId) })),
  ]
}

/** Deletes a router and the tasks only it used; false when it is not one of the organization's. */
export async function deleteAutoRouter(organizationId: OrganizationId, routerId: string): Promise<boolean> {
  if (!isDenTypeId("autoRouter", routerId)) return false
  return db.transaction(async (tx) => {
    await lockOrganization(tx, organizationId)
    const id = normalizeDenTypeId("autoRouter", routerId)
    const [existing] = await tx.select({ id: AutoRouterTable.id }).from(AutoRouterTable)
      .where(and(eq(AutoRouterTable.id, id), eq(AutoRouterTable.organizationId, organizationId))).limit(1)
    if (!existing) return false
    await deleteRouterContents(tx, existing.id)
    await tx.delete(AutoRouterTable).where(eq(AutoRouterTable.id, existing.id))
    await deleteUnusedTasks(tx, organizationId)
    return true
  })
}

/** Removes a team's router assignments inside the transaction that deletes the team. */
export async function deleteTeamAutoRouterAccess(database: Database, teamId: TeamId): Promise<void> {
  await database.delete(AutoRouterAccessTable).where(eq(AutoRouterAccessTable.teamId, teamId))
}

/** Removes every Smart Router of an organization inside the transaction that deletes it. */
export async function deleteOrganizationAutoRouters(database: Database, organizationId: OrganizationId): Promise<void> {
  await database.delete(AutoRouterModelTaskTable).where(eq(AutoRouterModelTaskTable.organizationId, organizationId))
  await database.delete(AutoRouterTaskTable).where(eq(AutoRouterTaskTable.organizationId, organizationId))
  await database.delete(AutoRouterModelTable).where(eq(AutoRouterModelTable.organizationId, organizationId))
  await database.delete(AutoRouterAccessTable).where(eq(AutoRouterAccessTable.organizationId, organizationId))
  await database.delete(AutoRouterTable).where(eq(AutoRouterTable.organizationId, organizationId))
}

/**
 * The routers that apply to a member and that they can use: assigned to them
 * (everyone, one of their teams, or them), with at least one model their
 * AI Gateway grants reach through an active group and credential set.
 */
export async function memberAutoRouters(organizationId: OrganizationId, memberId: MemberId): Promise<AutoRouter[]> {
  if (gatewayManagementUnavailable()) return []
  const routers = await readRouters(db, organizationId)
  if (routers.length === 0) return []
  const teamIds = (await memberGatewayTeams(db, organizationId, memberId)).map((team) => team.id)
  const assigned = routers.filter((router) => autoRouterAssignmentIncludes(router.assignment, memberId, teamIds))
  if (assigned.length === 0) return []
  const providerIds = [...new Set(assigned.flatMap((router) => router.models.map((model) => model.providerId)))]
  const rows = await db.select({ grant: GatewayProviderAccessTable, modelId: GatewayProviderModelTable.model_id })
    .from(GatewayProviderAccessTable)
    .innerJoin(GatewayProviderTable, and(eq(GatewayProviderTable.id, GatewayProviderAccessTable.gateway_provider_id), eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
    .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.status, "active")))
    .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.status, "active")))
    .innerJoin(GatewayModelGroupModelTable, eq(GatewayModelGroupModelTable.model_group_id, GatewayModelGroupTable.id))
    .innerJoin(GatewayProviderModelTable, eq(GatewayProviderModelTable.id, GatewayModelGroupModelTable.gateway_provider_model_id))
    .where(inArray(GatewayProviderAccessTable.gateway_provider_id, providerIds.map((id) => normalizeDenTypeId("inferenceProvider", id))))
  const granted = new Set(effectiveGatewayGrants(rows.map((row) => row.grant), memberId, teamIds).map((grant) => grant.id))
  const usable = new Set(rows.filter((row) => granted.has(row.grant.id)).map((row) => modelKey(row.grant.gateway_provider_id, row.modelId)))
  return assigned.filter((router) => router.models.some((model) => usable.has(modelKey(model.providerId, model.modelId))))
}

const ROUTING_CACHE_MS = { known: 60_000, unknown: 10_000 } as const
let routingCache: { state: AutoRouterRoutingState; expires: number } | null = null

/**
 * Asks the AI Gateway whether it has its TypeSafe (Jev) key. Only the gateway
 * holds the key, so Den reads a boolean from its `/auto-router/status`.
 * Cached briefly; `unknown` when the gateway cannot be reached.
 */
export async function readAutoRouterRouting(fetcher: typeof fetch = fetch, now = Date.now()): Promise<AutoRouterRoutingState> {
  if (routingCache && routingCache.expires > now) return routingCache.state
  let state: AutoRouterRoutingState = "unknown"
  try {
    const base = (env.gatewayProxyBaseUrl ?? env.gatewayPublicBaseUrl).replace(/\/+$/, "")
    const response = await fetcher(`${base}/auto-router/status`, { signal: AbortSignal.timeout(2_000), redirect: "error" })
    if (response.ok) {
      const body: unknown = await response.json()
      const configured = typeof body === "object" && body !== null && !Array.isArray(body) ? Reflect.get(body, "routingConfigured") : undefined
      if (typeof configured === "boolean") state = configured ? "ready" : "missing_key"
    } else {
      await response.body?.cancel().catch(() => {})
    }
  } catch (error) {
    console.warn("[auto-router] could not read the gateway's routing status", error instanceof Error ? error.message : error)
  }
  routingCache = { state, expires: now + (state === "unknown" ? ROUTING_CACHE_MS.unknown : ROUTING_CACHE_MS.known) }
  return state
}

/** Test hook. */
export function clearAutoRouterRoutingCache() {
  routingCache = null
}
