/**
 * Config-blob area `ai-gateway.smart-routers`: Smart Routers (feature
 * `autoRouter`, cloud only; Manage › AI Gateway › AI Providers › Smart routers).
 *
 * - Spec: who the router applies to (everyone, team refs, people refs) and its
 *   models in order, each a `$ref` to its `ai-gateway.providers` provider plus
 *   the catalog model id and the task names it handles (in order). Tasks are
 *   organization-wide rows (`auto_router_task`, matched by `name_key`) created
 *   and removed by the router writes, so they travel as names inside models.
 *   Router model row ids are regenerated on every save and are not exported.
 *   `auto_router_reasoning` is runtime state and never exported.
 * - Identity: the router name (names are not unique, so a similarity score
 *   helps the confirm step). The router id is reused on create when free: the
 *   desktop model id is `openwork-smart-<router id>`.
 * - Apply goes through the same functions the routes use (auto-router.ts:
 *   readAutoRouterRouting, checkAutoRouterWrite against the organization's
 *   model options, saveAutoRouter, checkAutoRouterAssignment,
 *   saveAutoRouterAssignment with the Share with everyone rule,
 *   deleteAutoRouter). Only what the plan's changes name is written: a rename
 *   alone updates the name only, models are replaced only when they changed,
 *   and the assignment only when it changed.
 */
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { AutoRouterAccessTable, AutoRouterModelTable, AutoRouterModelTaskTable, AutoRouterTable, AutoRouterTaskTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema, type ConfigApplyStep, type ConfigFieldChange } from "@openwork/types/den/config-blobs"
import { AUTO_ROUTER_MAX_MODELS, AUTO_ROUTER_MAX_ROUTERS, AUTO_ROUTER_MAX_TASKS_PER_MODEL, AUTO_ROUTER_NAME_MAX_LENGTH, AUTO_ROUTER_TASK_MAX_LENGTH, autoRouterWriteSchema, type AutoRouterAssignment } from "@openwork/types/den/auto-router"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { z } from "zod"
import { checkAutoRouterAssignment, checkAutoRouterWrite, deleteAutoRouter, listAutoRouterOptions, readAutoRouterRouting, saveAutoRouter, saveAutoRouterAssignment } from "../../auto-router.js"
import { gatewayManagementUnavailable } from "../../gateway-deployment.js"
import { permissionDeniedMessage, type MemberPermissions } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { AUTO_ROUTER_NOT_CONFIGURED_MESSAGE } from "../../routes/org/auto-router.js"
import { ConfigApplyItemError, defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { audienceRefs, ConfigApplyError, isJsonObject, loadMemberEmails, loadTeamNames, resolvedRefIds, specObject } from "./route-support.js"

const AREA = "ai-gateway.smart-routers" as const
const PROVIDERS_AREA = "ai-gateway.providers"

// ---------------------------------------------------------------------------
// Spec

const routerSpecSchema = z.object({
  /** Who the router applies to. A new router with none applies to nobody. */
  assignment: z.object({
    everyone: z.boolean().default(false),
    teams: z.array(configRefSchema).max(200).default([]),
    members: z.array(configRefSchema).max(1000).default([]),
  }).strict().default({ everyone: false, teams: [], members: [] }),
  /** In order: the first wins ties and is used when the router cannot decide. */
  models: z.array(z.object({
    /** The AI Gateway provider. */
    provider: configRefSchema,
    /** Catalog model id within that provider (not a member's gwm_… alias). */
    modelId: z.string().trim().min(1).max(255),
    /** Task names this model handles, in order. Matched across the organization ignoring case and spacing. */
    tasks: z.array(z.string().trim().min(1).max(AUTO_ROUTER_TASK_MAX_LENGTH)).min(1).max(AUTO_ROUTER_MAX_TASKS_PER_MODEL),
  }).strict()).min(1).max(AUTO_ROUTER_MAX_MODELS),
}).strict()

type RouterSpec = z.infer<typeof routerSpecSchema>

// ---------------------------------------------------------------------------
// Read

async function readRouters(ctx: ConfigAreaContext, ids?: string[]): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const wanted = ids?.filter((id) => isDenTypeId("autoRouter", id)).map((id) => normalizeDenTypeId("autoRouter", id))
  if (wanted && wanted.length === 0) return []
  const routers = await ctx.db.select().from(AutoRouterTable)
    .where(and(eq(AutoRouterTable.organizationId, organizationId), ...(wanted ? [inArray(AutoRouterTable.id, wanted)] : [])))
  if (routers.length === 0) return []
  const routerIds = routers.map((router) => router.id)
  // Sequential: ctx.db may be a transaction.
  const access = await ctx.db.select().from(AutoRouterAccessTable)
    .where(and(eq(AutoRouterAccessTable.organizationId, organizationId), inArray(AutoRouterAccessTable.autoRouterId, routerIds)))
  const models = await ctx.db.select().from(AutoRouterModelTable)
    .where(and(eq(AutoRouterModelTable.organizationId, organizationId), inArray(AutoRouterModelTable.autoRouterId, routerIds)))
    .orderBy(asc(AutoRouterModelTable.position))
  const links = models.length === 0 ? [] : await ctx.db
    .select({ modelId: AutoRouterModelTaskTable.autoRouterModelId, name: AutoRouterTaskTable.name, position: AutoRouterModelTaskTable.position })
    .from(AutoRouterModelTaskTable)
    .innerJoin(AutoRouterTaskTable, eq(AutoRouterTaskTable.id, AutoRouterModelTaskTable.taskId))
    .where(and(eq(AutoRouterModelTaskTable.organizationId, organizationId), inArray(AutoRouterModelTaskTable.autoRouterModelId, models.map((model) => model.id))))
    .orderBy(asc(AutoRouterModelTaskTable.position))
  const providerIds = [...new Set(models.map((model) => model.gatewayProviderId))]
  const providers = providerIds.length === 0 ? [] : await ctx.db.select({ id: GatewayProviderTable.id, name: GatewayProviderTable.name }).from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.organization_id, organizationId), inArray(GatewayProviderTable.id, providerIds)))
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]))
  const teamNames = await loadTeamNames(ctx.db, organizationId, access.flatMap((row) => row.teamId ? [row.teamId] : []))
  const memberEmails = await loadMemberEmails(ctx.db, organizationId, access.flatMap((row) => row.orgMembershipId ? [row.orgMembershipId] : []))

  return routers
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
    .map((router): ConfigItem => {
      const grants = access.filter((row) => row.autoRouterId === router.id)
      const audience = audienceRefs({
        teamIds: grants.flatMap((row) => row.teamId ? [row.teamId] : []),
        memberIds: grants.flatMap((row) => row.orgMembershipId ? [row.orgMembershipId] : []),
        teamNames,
        memberEmails,
      })
      const spec: RouterSpec = {
        assignment: { everyone: grants.some((row) => row.orgWide), teams: audience.teams, members: audience.members },
        models: models.filter((model) => model.autoRouterId === router.id).map((model) => {
          const providerName = providerNames.get(model.gatewayProviderId)
          return {
            provider: { $ref: `${PROVIDERS_AREA}/${model.gatewayProviderId}`, ...(providerName ? { name: providerName } : {}) },
            modelId: model.modelId,
            tasks: links.filter((link) => link.modelId === model.id).map((link) => link.name),
          }
        }),
      }
      return { id: router.id, key: null, name: router.name, spec }
    })
}

// ---------------------------------------------------------------------------
// Matching

function modelKeys(item: ConfigItem): Set<string> {
  const parsed = routerSpecSchema.safeParse(item.spec)
  if (!parsed.success) return new Set()
  return new Set(parsed.data.models.map((model) => `${(model.provider.name ?? model.provider.$ref).toLowerCase()}\u0000${model.modelId.toLowerCase()}`))
}

function similarity(blob: ConfigItem, target: ConfigItem): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  if (blob.name.trim().toLowerCase() === target.name.trim().toLowerCase()) {
    score += 0.5
    reasons.push("same name")
  }
  const left = modelKeys(blob)
  const right = modelKeys(target)
  const shared = [...left].filter((key) => right.has(key)).length
  if (shared) {
    score += 0.5 * (shared / Math.max(left.size, right.size))
    reasons.push(`${shared}/${Math.max(left.size, right.size)} models equal`)
  }
  return { score: Math.min(1, Math.round(score * 1000) / 1000), reasons }
}

// ---------------------------------------------------------------------------
// Apply

function touches(changes: ConfigFieldChange[], field: string): boolean {
  return changes.some((change) => change.path === field || change.path.startsWith(`${field}.`) || change.path.startsWith(`${field}[`))
}

async function heldPermissions(ctx: ConfigAreaContext) {
  return resolvePermissionsForMember({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
  })
}

function requirePermission(held: MemberPermissions, key: PermissionKey) {
  if (!held.has(key)) throw new ConfigApplyError("forbidden", permissionDeniedMessage(key), 403)
}

class Steps {
  readonly done: ConfigApplyStep[] = []
  async run<T>(step: ConfigApplyStep, field: string | undefined, write: () => Promise<T>): Promise<T> {
    try {
      const result = await write()
      this.done.push(step)
      return result
    } catch (error) {
      throw itemError(error, this.done, step, field)
    }
  }
}

function itemError(error: unknown, done: ConfigApplyStep[], step?: ConfigApplyStep, field?: string): ConfigApplyItemError {
  if (error instanceof ConfigApplyItemError) return error
  const code = error instanceof ConfigApplyError ? error.code : "apply_failed"
  const status = error instanceof ConfigApplyError ? error.status : undefined
  const message = error instanceof Error ? error.message : String(error)
  return new ConfigApplyItemError({ code, message, ...(field ? { field } : {}), ...(step ? { step } : {}), ...(status ? { status } : {}) }, [...done])
}

type ResolvedRouter = {
  models: Array<{ providerId: string; modelId: string; tasks: string[] }>
  assignment: AutoRouterAssignment
}

function resolvedRouter(spec: unknown): ResolvedRouter {
  const raw = specObject(spec)
  const assignment = isJsonObject(raw.assignment) ? raw.assignment : {}
  const models = Array.isArray(raw.models) ? raw.models : []
  return {
    models: models.map((model, index) => {
      if (!isJsonObject(model)) throw new ConfigApplyError("invalid_spec", `models[${index}] must be an object.`)
      const [providerId] = resolvedRefIds([model.provider], `models[${index}].provider`)
      const tasks = Array.isArray(model.tasks) ? model.tasks.filter((task): task is string => typeof task === "string") : []
      return { providerId: providerId ?? "", modelId: typeof model.modelId === "string" ? model.modelId : "", tasks }
    }),
    assignment: {
      everyone: assignment.everyone === true,
      teamIds: [...new Set(resolvedRefIds(assignment.teams, "assignment.teams"))],
      memberIds: [...new Set(resolvedRefIds(assignment.members, "assignment.members"))],
    },
  }
}

function hasAudience(assignment: AutoRouterAssignment): boolean {
  return assignment.everyone || assignment.teamIds.length > 0 || assignment.memberIds.length > 0
}

/** Checks and saves the name and models the way the router routes do. Returns the router id. */
async function saveRouter(ctx: ConfigAreaContext, input: { name: string; models: ResolvedRouter["models"]; routerId?: string; createId?: string }) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const parsed = autoRouterWriteSchema.safeParse({ name: input.name, models: input.models })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ConfigApplyError("invalid_spec", issue?.message ?? "Invalid Smart Router.", 400)
  }
  if (await readAutoRouterRouting() === "missing_key") throw new ConfigApplyError("auto_router_not_configured", AUTO_ROUTER_NOT_CONFIGURED_MESSAGE, 409)
  if (input.routerId === undefined) {
    const existing = await ctx.db.select({ id: AutoRouterTable.id }).from(AutoRouterTable).where(eq(AutoRouterTable.organizationId, organizationId))
    if (existing.length >= AUTO_ROUTER_MAX_ROUTERS) throw new ConfigApplyError("too_many_routers", `An organization can have at most ${AUTO_ROUTER_MAX_ROUTERS} Smart Routers.`, 400)
  }
  const problem = checkAutoRouterWrite(parsed.data, await listAutoRouterOptions(organizationId))
  if (problem) {
    const model = problem.model !== undefined ? input.models[problem.model] : undefined
    throw new ConfigApplyError(problem.error, model ? `${problem.message} (${model.modelId})` : problem.message, 400)
  }
  const saved = await saveAutoRouter({
    organizationId,
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
    routerId: input.routerId,
    write: parsed.data,
    ...(input.createId ? { createId: normalizeDenTypeId("autoRouter", input.createId) } : {}),
  })
  if (!saved) throw new ConfigApplyError("auto_router_not_found", "The Smart Router no longer exists.", 404)
  return saved
}

async function saveAssignment(ctx: ConfigAreaContext, routerId: string, assignment: AutoRouterAssignment, held: MemberPermissions) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const problem = await checkAutoRouterAssignment(organizationId, assignment)
  if (problem) throw new ConfigApplyError(problem.error, problem.message, 400)
  const result = await saveAutoRouterAssignment({
    organizationId,
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
    routerId,
    assignment,
    canShareWithEveryone: !assignment.everyone || held.has("sharing.share_org_wide"),
  })
  if (result === "not_found") throw new ConfigApplyError("auto_router_not_found", "The Smart Router no longer exists.", 404)
  if (result === "needs_share_with_everyone") throw new ConfigApplyError("forbidden", "Making a Smart Router apply to everyone needs the Share with everyone permission.", 403)
}

async function freeRouterId(ctx: ConfigAreaContext, id: string | undefined): Promise<string | undefined> {
  if (!id || !isDenTypeId("autoRouter", id)) return undefined
  const normalized = normalizeDenTypeId("autoRouter", id)
  const [taken] = await ctx.db.select({ id: AutoRouterTable.id }).from(AutoRouterTable).where(eq(AutoRouterTable.id, normalized)).limit(1)
  return taken ? undefined : normalized
}

async function applyRouter(ctx: ConfigAreaContext, op: ConfigApplyOp) {
  const steps = new Steps()
  try {
    const unavailable = gatewayManagementUnavailable()
    if (unavailable) throw new ConfigApplyError(unavailable.error, unavailable.message, 403)
    if (!ctx.features.autoRouter) throw new ConfigApplyError("feature_disabled", "The Smart Model Router is not turned on for this organization.", 404)
    const held = await heldPermissions(ctx)
    requirePermission(held, "gateway_providers.manage")
    const organizationId = normalizeDenTypeId("organization", ctx.organizationId)

    if (op.kind === "delete") {
      const deleted = await steps.run({ action: "delete", target: `Smart Router "${op.previous.name}"` }, undefined, () => deleteAutoRouter(organizationId, op.targetId))
      return { localId: op.targetId, steps: deleted ? steps.done : [] }
    }

    const name = op.item.name.trim()
    if (!name || name.length > AUTO_ROUTER_NAME_MAX_LENGTH) throw new ConfigApplyItemError({ code: "invalid_spec", message: `A Smart Router needs a name of at most ${AUTO_ROUTER_NAME_MAX_LENGTH} characters.`, field: "name" })
    const spec = resolvedRouter(op.item.spec)

    if (op.kind === "create") {
      const createId = await freeRouterId(ctx, op.preferredId)
      const routerId = await steps.run({ action: "create", target: `Smart Router "${name}"`, detail: `${spec.models.length} model(s)` }, "models", () => saveRouter(ctx, { name, models: spec.models, createId }))
      if (hasAudience(spec.assignment)) {
        await steps.run({ action: "set", target: "assignment" }, "assignment", () => saveAssignment(ctx, routerId, spec.assignment, held))
      }
      return { localId: routerId, steps: steps.done }
    }

    // update
    const [current] = await ctx.db.select({ id: AutoRouterTable.id, name: AutoRouterTable.name }).from(AutoRouterTable)
      .where(and(eq(AutoRouterTable.organizationId, organizationId), eq(AutoRouterTable.id, normalizeDenTypeId("autoRouter", op.targetId)))).limit(1)
    if (!current) throw new ConfigApplyError("auto_router_not_found", `Smart Router "${op.previous.name}" no longer exists.`, 404)

    const renames = touches(op.changes, "name") && current.name !== name
    if (touches(op.changes, "models")) {
      // Models and their tasks are one ordered list: saveAutoRouter replaces it (and the name, unchanged unless renamed).
      await steps.run({ action: "update", target: `Smart Router "${current.name}"`, detail: renames ? "models, name" : "models" }, "models", () => saveRouter(ctx, { name: renames ? name : current.name, models: spec.models, routerId: current.id }))
    } else if (renames) {
      await steps.run({ action: "update", target: `Smart Router "${current.name}"`, detail: "name" }, "name", async () => {
        await ctx.db.update(AutoRouterTable).set({ name, updatedByOrgMemberId: normalizeDenTypeId("member", ctx.actor.memberId) }).where(eq(AutoRouterTable.id, current.id))
      })
    }

    if (touches(op.changes, "assignment")) {
      // People without an email are never exported, so a blob can't name them: keep their assignment.
      const access = await ctx.db.select({ memberId: AutoRouterAccessTable.orgMembershipId }).from(AutoRouterAccessTable).where(eq(AutoRouterAccessTable.autoRouterId, current.id))
      const memberIds = access.flatMap((row) => row.memberId ? [row.memberId] : [])
      const emails = await loadMemberEmails(ctx.db, organizationId, memberIds)
      const kept = memberIds.filter((id) => !emails.has(id))
      const assignment = { ...spec.assignment, memberIds: [...new Set([...spec.assignment.memberIds, ...kept])] }
      await steps.run({ action: "set", target: "assignment" }, "assignment", () => saveAssignment(ctx, current.id, assignment, held))
    }
    return { localId: current.id, steps: steps.done }
  } catch (error) {
    throw itemError(error, steps.done)
  }
}

function irreversible(op: ConfigApplyOp): string[] {
  if (op.kind !== "delete") return []
  return [`Members lose "Smart: ${op.previous.name}" at their next sync. Re-creating it gives it a new model id, so desktops that picked it must pick it again.`]
}

export const aiGatewaySmartRoutersArea = defineConfigArea({
  key: AREA,
  label: "Smart routers",
  path: ["AI Gateway", "AI Providers", "Smart routers"],
  idPrefix: denTypeIdPrefixes.autoRouter,
  specVersion: 1,
  specSchema: routerSpecSchema,
  dependsOn: [PROVIDERS_AREA, "members.teams", "members.people"],
  deployments: ["cloud"],
  feature: "autoRouter",
  viewPermission: "gateway_providers.view",
  managePermission: "gateway_providers.manage",
  // Not auto_router_reasoning: short-lived runtime state.
  tables: ["auto_router", "auto_router_access", "auto_router_model", "auto_router_task", "auto_router_model_task"],
  naturalKeys: [{ label: "name", get: (item) => item.name.trim().toLowerCase() || null }],
  similarity,
  secretFields: [],
  orderedArrays: ["models", "models[].tasks"],
  // The auto-router service writes through the global db in its own transactions.
  transactional: false,
  // Saving checks the AI Gateway's routing status over the network.
  externalEffects: true,
  irreversible,

  exportItems: (ctx) => readRouters(ctx),
  readItems: (ctx, ids) => readRouters(ctx, ids),
  apply: applyRouter,
})
