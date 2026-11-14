/**
 * Config-blob area `ai-gateway.limits`: AI Gateway spend limits
 * (Manage › AI Gateway › Limits): each active policy with its per-period
 * allowances and who it applies to.
 *
 * - Spec: the provider it limits (`$ref` to `ai-gateway.providers`, null for a
 *   default limit), hard/soft, whether members may ask for more, the USD
 *   allowance per period, and its assignments (everyone, team refs, people
 *   refs). Runtime accounting (buckets, events, increase requests, audit) is
 *   never exported.
 * - Archived policies are not exported; "delete" archives, exactly as the
 *   dashboard does (there is no hard delete), so a revert can restore it.
 * - Policy ids are plain UUIDs, not TypeIDs, so the engine never offers a
 *   source id to reuse (no `idPrefix`); a create always gets a fresh id. Nothing
 *   outside the runtime accounting references a policy id.
 * - Apply goes through the same service the limit routes use
 *   (`createGatewayUsageLimits`: savePolicy / assign / unassign /
 *   archivePolicy), so revision checks, entitlement locks, provider validation,
 *   expiry of stale increase requests and the usage audit stay identical.
 *   Only what the plan's changes name is written.
 * - People who have not accepted their invitation yet can't hold a limit (the
 *   service only assigns to members who have joined, as the dashboard does).
 *   An import usually invites the people it names in the same run, so those
 *   assignments are left out with a warning instead of failing the item (and
 *   the run): the plan says so before approval, and importing again once they
 *   have joined assigns them. An update that would only assign people who have
 *   not joined is skipped, so re-importing the same blob has nothing to do.
 */
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { createGatewayUsageLimits, GatewayUsageError, type GatewayUsageScope } from "@openwork-ee/den-db/gateway-usage-limits"
import { GatewayProviderTable, GatewayUsageAssignmentTable, GatewayUsageLimitTable, GatewayUsagePolicyTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { configRefSchema, type ConfigApplyStep, type ConfigFieldChange } from "@openwork/types/den/config-blobs"
import { gatewayUsageTimeframeSchema, gatewayUsdToMicroUsd, type GatewayUsagePolicyWrite, type GatewayUsageTimeframe } from "@openwork/types/den/gateway-usage-limits"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { z } from "zod"
import { gatewayManagementUnavailable } from "../../gateway-deployment.js"
import { permissionDeniedMessage } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { ConfigApplyItemError, defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem, type ConfigPreflightInfo, type ConfigPreflightResult } from "../area.js"
import { audienceRefs, ConfigApplyError, isJsonObject, loadMemberEmails, loadPendingMemberIds, loadTeamNames, resolvedRefIds, specObject } from "./route-support.js"

const AREA = "ai-gateway.limits" as const
const PROVIDERS_AREA = "ai-gateway.providers"
const PEOPLE_PREFIX = "people/"

// ---------------------------------------------------------------------------
// Spec

const usdSchema = z.string().max(32).superRefine((value, ctx) => {
  try {
    gatewayUsdToMicroUsd(value)
  } catch {
    ctx.addIssue({ code: "custom", message: "A USD amount with at most six decimal places." })
  }
})

const limitsSpecSchema = z.object({
  /** The AI provider this limit governs; null for a default limit (every provider without its own limit). */
  provider: configRefSchema.nullable().default(null),
  /** true: members are blocked at the limit; false: only flagged. */
  hardLimit: z.boolean().default(true),
  /** Members may ask an admin for 25% more. */
  allowRequestReset: z.boolean().default(true),
  /** One allowance per period, in USD (estimated provider cost). */
  limits: z.array(z.object({ timeframe: gatewayUsageTimeframeSchema, costUsd: usdSchema }).strict()).min(1).max(3)
    .refine((limits) => new Set(limits.map((limit) => limit.timeframe)).size === limits.length, "Periods must be unique."),
  /** Who the limit applies to. */
  assignments: z.object({
    organization: z.boolean().default(false),
    teams: z.array(configRefSchema).max(500).default([]),
    members: z.array(configRefSchema).max(5000).default([]),
  }).strict().default({ organization: false, teams: [], members: [] }),
}).strict()

type LimitsSpec = z.infer<typeof limitsSpecSchema>

/** Integer micro-USD → the shortest exact USD decimal ("20", "0.5", "1.000001"). */
export function microUsdToUsd(micro: number): string {
  const value = BigInt(micro)
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

const TIMEFRAME_ORDER: GatewayUsageTimeframe[] = ["day", "week", "month"]

// ---------------------------------------------------------------------------
// Read

async function readPolicies(ctx: ConfigAreaContext, ids?: string[]): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  if (ids && ids.length === 0) return []
  const policies = await ctx.db.select().from(GatewayUsagePolicyTable)
    .where(and(
      eq(GatewayUsagePolicyTable.organizationId, organizationId),
      isNull(GatewayUsagePolicyTable.archivedAt),
      ...(ids ? [inArray(GatewayUsagePolicyTable.id, ids)] : []),
    ))
  if (policies.length === 0) return []
  const policyIds = policies.map((policy) => policy.id)
  const [limits, assignments] = await Promise.all([
    ctx.db.select().from(GatewayUsageLimitTable).where(inArray(GatewayUsageLimitTable.policyId, policyIds)),
    ctx.db.select().from(GatewayUsageAssignmentTable).where(and(eq(GatewayUsageAssignmentTable.organizationId, organizationId), inArray(GatewayUsageAssignmentTable.policyId, policyIds))),
  ])
  const providerIds = [...new Set(policies.flatMap((policy) => policy.inferenceProviderId ? [policy.inferenceProviderId] : []))]
  const [providers, teamNames, memberEmails] = await Promise.all([
    providerIds.length
      ? ctx.db.select({ id: GatewayProviderTable.id, name: GatewayProviderTable.name }).from(GatewayProviderTable)
        .where(and(eq(GatewayProviderTable.organization_id, organizationId), inArray(GatewayProviderTable.id, providerIds)))
      : Promise.resolve([]),
    loadTeamNames(ctx.db, organizationId, assignments.flatMap((row) => row.teamId ? [row.teamId] : [])),
    loadMemberEmails(ctx.db, organizationId, assignments.flatMap((row) => row.memberId ? [row.memberId] : [])),
  ])
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]))

  return policies
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
    .map((policy): ConfigItem => {
      const own = assignments.filter((row) => row.policyId === policy.id)
      const audience = audienceRefs({
        teamIds: own.flatMap((row) => row.teamId ? [row.teamId] : []),
        memberIds: own.flatMap((row) => row.memberId ? [row.memberId] : []),
        teamNames,
        memberEmails,
      })
      const providerName = policy.inferenceProviderId ? providerNames.get(policy.inferenceProviderId) : undefined
      const spec: LimitsSpec = {
        // A provider limit whose provider was deleted still points at it; the ref then fails to resolve on import.
        provider: policy.inferenceProviderId
          ? { $ref: `${PROVIDERS_AREA}/${policy.inferenceProviderId}`, ...(providerName ? { name: providerName } : {}) }
          : null,
        hardLimit: policy.hardLimit,
        allowRequestReset: policy.allowRequestReset,
        limits: limits
          .filter((row) => row.policyId === policy.id)
          .sort((left, right) => TIMEFRAME_ORDER.indexOf(left.timeframe) - TIMEFRAME_ORDER.indexOf(right.timeframe))
          .map((row) => ({ timeframe: row.timeframe, costUsd: microUsdToUsd(row.costLimitMicroUsd) })),
        assignments: { organization: own.some((row) => row.organization === true), teams: audience.teams, members: audience.members },
      }
      return { id: policy.id, key: null, name: policy.name, spec }
    })
}

// ---------------------------------------------------------------------------
// Matching

function specOf(item: ConfigItem): LimitsSpec | null {
  const parsed = limitsSpecSchema.safeParse(item.spec)
  return parsed.success ? parsed.data : null
}

function providerKey(spec: LimitsSpec): string {
  return spec.provider ? (spec.provider.name ?? spec.provider.$ref).trim().toLowerCase() : ""
}

function similarity(blob: ConfigItem, target: ConfigItem): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  if (blob.name.trim().toLowerCase() === target.name.trim().toLowerCase()) {
    score += 0.4
    reasons.push("same name")
  }
  const left = specOf(blob)
  const right = specOf(target)
  if (left && right) {
    if (providerKey(left) === providerKey(right)) {
      score += 0.25
      reasons.push(left.provider ? `same provider (${left.provider.name ?? left.provider.$ref})` : "both are default limits")
    }
    const frames = (spec: LimitsSpec) => new Set(spec.limits.map((limit) => `${limit.timeframe}:${limit.costUsd}`))
    const a = frames(left)
    const b = frames(right)
    const shared = [...a].filter((entry) => b.has(entry)).length
    if (shared) {
      score += 0.25 * (shared / Math.max(a.size, b.size))
      reasons.push(`${shared}/${Math.max(a.size, b.size)} allowances equal`)
    }
    if (left.assignments.organization && right.assignments.organization) {
      score += 0.1
      reasons.push("both apply to everyone")
    }
  }
  return { score: Math.min(1, Math.round(score * 1000) / 1000), reasons }
}

// ---------------------------------------------------------------------------
// Apply

function touches(changes: ConfigFieldChange[], field: string): boolean {
  return changes.some((change) => change.path === field || change.path.startsWith(`${field}.`) || change.path.startsWith(`${field}[`))
}

async function requireActorPermission(ctx: ConfigAreaContext, key: PermissionKey) {
  const held = await resolvePermissionsForMember({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
  })
  if (!held.has(key)) throw new ConfigApplyError("forbidden", permissionDeniedMessage(key), 403)
}

function scopeOf(ctx: ConfigAreaContext): GatewayUsageScope {
  return { organizationId: normalizeDenTypeId("organization", ctx.organizationId), memberId: normalizeDenTypeId("member", ctx.actor.memberId) }
}

/** The resolved provider id, or null for a default limit. */
function resolvedProviderId(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (isJsonObject(value) && typeof value.id === "string" && value.id) return value.id
  const ref = isJsonObject(value) && typeof value.$ref === "string" ? value.$ref : "?"
  throw new ConfigApplyError("ref_unresolved", `provider: reference ${ref} was not resolved.`)
}

type ResolvedLimits = Omit<LimitsSpec, "provider" | "assignments"> & {
  providerId: string | null
  assignments: { organization: boolean; teamIds: string[]; memberIds: string[] }
}

function resolvedSpec(spec: unknown): ResolvedLimits {
  const raw = specObject(spec)
  const assignments = isJsonObject(raw.assignments) ? raw.assignments : {}
  const plain = limitsSpecSchema.omit({ provider: true, assignments: true }).safeParse({ hardLimit: raw.hardLimit, allowRequestReset: raw.allowRequestReset, limits: raw.limits })
  if (!plain.success) throw new ConfigApplyError("invalid_spec", plain.error.issues[0]?.message ?? "Invalid limit.")
  return {
    ...plain.data,
    providerId: resolvedProviderId(raw.provider),
    assignments: {
      organization: assignments.organization === true,
      teamIds: [...new Set(resolvedRefIds(assignments.teams, "assignments.teams"))],
      memberIds: [...new Set(resolvedRefIds(assignments.members, "assignments.members"))],
    },
  }
}

/** Runs the item's writes in order, recording each; a failure carries the writes already done. */
class Steps {
  readonly done: ConfigApplyStep[] = []
  async run<T>(step: ConfigApplyStep, field: string | undefined, write: () => Promise<T>): Promise<T> {
    try {
      const result = await write()
      this.done.push(step)
      return result
    } catch (error) {
      const code = error instanceof GatewayUsageError || error instanceof ConfigApplyError ? error.code : "apply_failed"
      const status = error instanceof GatewayUsageError || error instanceof ConfigApplyError ? error.status : undefined
      const message = error instanceof Error ? error.message : String(error)
      throw new ConfigApplyItemError({ code, message, ...(field ? { field } : {}), step, ...(status ? { status } : {}) }, [...this.done])
    }
  }
}

function policyWrite(name: string, spec: ResolvedLimits): GatewayUsagePolicyWrite {
  return { name, providerId: spec.providerId, hardLimit: spec.hardLimit, allowRequestReset: spec.allowRequestReset, limits: spec.limits }
}

function memberTarget(id: string) {
  if (!isDenTypeId("member", id)) throw new ConfigApplyError("invalid_target", "Invalid membership id.")
  return { memberId: normalizeDenTypeId("member", id) }
}
function teamTarget(id: string) {
  if (!isDenTypeId("team", id)) throw new ConfigApplyError("invalid_target", "Invalid team id.")
  return { teamId: normalizeDenTypeId("team", id) }
}

async function applyLimits(ctx: ConfigAreaContext, op: ConfigApplyOp) {
  const unavailable = gatewayManagementUnavailable()
  if (unavailable) throw new ConfigApplyError(unavailable.error, unavailable.message, 403)
  await requireActorPermission(ctx, "gateway_limits.manage")
  const service = createGatewayUsageLimits(ctx.db)
  const scope = scopeOf(ctx)
  const steps = new Steps()

  if (op.kind === "delete") {
    const [current] = await ctx.db.select({ revision: GatewayUsagePolicyTable.revision, archivedAt: GatewayUsagePolicyTable.archivedAt })
      .from(GatewayUsagePolicyTable)
      .where(and(eq(GatewayUsagePolicyTable.id, op.targetId), eq(GatewayUsagePolicyTable.organizationId, scope.organizationId))).limit(1)
    if (!current || current.archivedAt) return { localId: op.targetId, steps: [] }
    await steps.run({ action: "delete", target: `limit "${op.previous.name}"`, detail: "archived" }, undefined, () => service.archivePolicy(scope, op.targetId, current.revision))
    return { localId: op.targetId, steps: steps.done }
  }

  const name = op.item.name.trim()
  if (!name || name.length > 120) throw new ConfigApplyItemError({ code: "invalid_spec", message: "A limit needs a name of at most 120 characters.", field: "name" })
  let spec: ResolvedLimits
  try {
    spec = resolvedSpec(op.item.spec)
  } catch (error) {
    throw new ConfigApplyItemError({ code: error instanceof ConfigApplyError ? error.code : "invalid_spec", message: error instanceof Error ? error.message : String(error) })
  }

  if (op.kind === "create") {
    const created = await steps.run({ action: "create", target: `limit "${name}"` }, undefined, () => service.savePolicy(scope, policyWrite(name, spec)))
    const policyId = created.id
    if (spec.assignments.organization) {
      await steps.run({ action: "add", target: "assignments.organization", detail: "everyone" }, "assignments.organization", () => service.assign(scope, policyId, { organization: true }))
    }
    for (const teamId of spec.assignments.teamIds) {
      await steps.run({ action: "add", target: "assignments.teams", detail: teamId }, "assignments.teams", () => service.assign(scope, policyId, teamTarget(teamId)))
    }
    const waiting = await notJoined(ctx, spec.assignments.memberIds)
    for (const memberId of spec.assignments.memberIds) {
      if (waiting.ids.has(memberId)) continue
      await steps.run({ action: "add", target: "assignments.members", detail: memberId }, "assignments.members", () => service.assign(scope, policyId, memberTarget(memberId)))
    }
    return { localId: policyId, steps: steps.done, ...(waiting.warning ? { warnings: [waiting.warning] } : {}) }
  }

  // update
  const warnings: string[] = []
  const [current] = await ctx.db.select().from(GatewayUsagePolicyTable)
    .where(and(eq(GatewayUsagePolicyTable.id, op.targetId), eq(GatewayUsagePolicyTable.organizationId, scope.organizationId))).limit(1)
  if (!current || current.archivedAt) throw new ConfigApplyItemError({ code: "policy_not_found", message: `Limit "${op.previous.name}" no longer exists or was archived.`, status: 404 })

  const settingsFields = ["name", "provider", "hardLimit", "allowRequestReset", "limits"].filter((field) => touches(op.changes, field))
  if (settingsFields.length) {
    const currentLimits = await ctx.db.select().from(GatewayUsageLimitTable).where(eq(GatewayUsageLimitTable.policyId, current.id))
    // Only the named fields come from the blob; the rest are kept as stored.
    const write: GatewayUsagePolicyWrite = {
      name: settingsFields.includes("name") ? name : current.name,
      providerId: settingsFields.includes("provider") ? spec.providerId : current.inferenceProviderId,
      hardLimit: settingsFields.includes("hardLimit") ? spec.hardLimit : current.hardLimit,
      allowRequestReset: settingsFields.includes("allowRequestReset") ? spec.allowRequestReset : current.allowRequestReset,
      limits: settingsFields.includes("limits")
        ? spec.limits
        : currentLimits.map((row) => ({ timeframe: row.timeframe, costUsd: microUsdToUsd(row.costLimitMicroUsd) })),
    }
    await steps.run({ action: "update", target: `limit "${current.name}"`, detail: settingsFields.join(", ") }, settingsFields[0], () => service.savePolicy(scope, write, current.id, current.revision))
  }

  if (touches(op.changes, "assignments")) {
    const rows = await ctx.db.select().from(GatewayUsageAssignmentTable)
      .where(and(eq(GatewayUsageAssignmentTable.organizationId, scope.organizationId), eq(GatewayUsageAssignmentTable.policyId, current.id)))
    // People without an email are never exported, so a blob can't name them: leave their assignments alone.
    const emails = await loadMemberEmails(ctx.db, scope.organizationId, rows.flatMap((row) => row.memberId ? [row.memberId] : []))
    const wantTeams = new Set(spec.assignments.teamIds.map((id) => teamTarget(id).teamId))
    const wantMembers = new Set(spec.assignments.memberIds.map((id) => memberTarget(id).memberId))
    const orgRow = rows.find((row) => row.organization === true)
    const haveTeams = new Set(rows.flatMap((row) => row.teamId ? [row.teamId] : []))
    const haveMembers = new Set(rows.flatMap((row) => row.memberId ? [row.memberId] : []))

    if (touches(op.changes, "assignments.organization")) {
      if (spec.assignments.organization && !orgRow) {
        await steps.run({ action: "add", target: "assignments.organization", detail: "everyone" }, "assignments.organization", () => service.assign(scope, current.id, { organization: true }))
      } else if (!spec.assignments.organization && orgRow) {
        await steps.run({ action: "remove", target: "assignments.organization", detail: "everyone" }, "assignments.organization", () => service.unassign(scope, current.id, orgRow.id))
      }
    }
    if (touches(op.changes, "assignments.teams")) {
      for (const row of rows) if (row.teamId && !wantTeams.has(row.teamId)) {
        const id = row.id
        await steps.run({ action: "remove", target: "assignments.teams", detail: row.teamId }, "assignments.teams", () => service.unassign(scope, current.id, id))
      }
      for (const teamId of wantTeams) if (!haveTeams.has(teamId)) {
        await steps.run({ action: "add", target: "assignments.teams", detail: teamId }, "assignments.teams", () => service.assign(scope, current.id, { teamId }))
      }
    }
    if (touches(op.changes, "assignments.members")) {
      for (const row of rows) if (row.memberId && !wantMembers.has(row.memberId) && emails.has(row.memberId)) {
        const id = row.id
        await steps.run({ action: "remove", target: "assignments.members", detail: emails.get(row.memberId) }, "assignments.members", () => service.unassign(scope, current.id, id))
      }
      const adding = [...wantMembers].filter((memberId) => !haveMembers.has(memberId))
      const waiting = await notJoined(ctx, adding)
      if (waiting.warning) warnings.push(waiting.warning)
      for (const memberId of adding) {
        if (waiting.ids.has(memberId)) continue
        await steps.run({ action: "add", target: "assignments.members", detail: memberId }, "assignments.members", () => service.assign(scope, current.id, { memberId }))
      }
    }
  }
  return { localId: current.id, steps: steps.done, ...(warnings.length ? { warnings } : {}) }
}

// ---------------------------------------------------------------------------
// People who have not joined yet

/** "ada@example.com", "ada@example.com and bo@example.com", "ada@example.com, bo@example.com and 3 more". */
function listPeople(names: readonly string[]): string {
  const sorted = [...names].sort()
  if (sorted.length <= 2) return sorted.join(" and ")
  if (sorted.length === 3) return `${sorted[0]}, ${sorted[1]} and ${sorted[2]}`
  return `${sorted[0]}, ${sorted[1]} and ${sorted.length - 2} more`
}

const JOIN_FIRST = "a limit can only be assigned to someone who has joined. Import again once they have accepted their invitation."

function whoIsWaiting(names: readonly string[], count: number): string {
  if (names.length === count && count > 0) return listPeople(names)
  return count === 1 ? "1 person" : `${count} people`
}

/** Of the members a limit is to be assigned to, the ones who have not accepted their invitation (and the warning to report). */
async function notJoined(ctx: ConfigAreaContext, memberIds: readonly string[]): Promise<{ ids: Set<string>; warning: string | null }> {
  const pending = await loadPendingMemberIds(ctx.db, ctx.organizationId, memberIds)
  const ids = new Set(memberIds.filter((id) => isDenTypeId("member", id) && pending.has(normalizeDenTypeId("member", id))))
  if (ids.size === 0) return { ids, warning: null }
  const emails = await loadMemberEmails(ctx.db, ctx.organizationId, [...ids])
  return { ids, warning: `Not assigned to ${whoIsWaiting([...emails.values()], ids.size)} yet: ${JOIN_FIRST}` }
}

const MEMBERS_PATH = /^assignments\.members\[\d+\]$/

/**
 * Plan time: which of the people this op assigns have not joined (invited by
 * this same plan, or already invited and still pending). They are left out
 * at apply, so say it before approval; an update with nothing else to do is
 * skipped instead of running to assign nobody.
 */
async function limitsPreflight(ctx: ConfigAreaContext, op: ConfigApplyOp, info: ConfigPreflightInfo): Promise<ConfigPreflightResult | null> {
  if (op.kind === "delete" || !info.refs) return null
  const people = info.refs.filter((ref) => MEMBERS_PATH.test(ref.path) && ref.ref.startsWith(PEOPLE_PREFIX))
  if (people.length === 0) return null
  const existing = people.flatMap((ref) => ref.resolution === "target" && ref.id ? [ref.id] : [])
  const pending = await loadPendingMemberIds(ctx.db, ctx.organizationId, existing)
  const waiting = people.filter((ref) => ref.resolution === "planned" || ref.resolution === "invite"
    || (ref.resolution === "target" && ref.id !== undefined && isDenTypeId("member", ref.id) && pending.has(normalizeDenTypeId("member", ref.id))))
  if (waiting.length === 0) return null
  const handles = waiting.map((ref) => ref.ref.slice(PEOPLE_PREFIX.length))
  const who = whoIsWaiting(handles.every((handle) => handle.includes("@")) ? handles : [], waiting.length)

  if (op.kind === "update") {
    // Already assigned people stay assigned; only additions are written.
    const waitingRefs = new Set(waiting.map((ref) => ref.ref))
    const onlyWaiting = op.changes.length > 0 && op.secretPaths.length === 0 && op.changes.every((change) => (
      change.path === "assignments.members"
      && (change.removed ?? []).length === 0
      && (change.added ?? []).length > 0
      && (change.added ?? []).every((entry) => typeof entry === "string" && waitingRefs.has(entry))
    ))
    if (onlyWaiting) return { skip: `Nothing to assign until ${who} ${waiting.length === 1 ? "has" : "have"} joined: ${JOIN_FIRST}` }
  }
  return { warnings: [`${who} will not be assigned yet: ${JOIN_FIRST}`] }
}

// ---------------------------------------------------------------------------
// Irreversible effects

function microOf(spec: LimitsSpec | null, timeframe: GatewayUsageTimeframe): number | null {
  const entry = spec?.limits.find((limit) => limit.timeframe === timeframe)
  if (!entry) return null
  try { return gatewayUsdToMicroUsd(entry.costUsd) } catch { return null }
}

function irreversible(op: ConfigApplyOp): string[] {
  const effects: string[] = []
  const pendingNote = "Members whose effective limit changes have their pending increase requests closed and this period's approved increases cleared."
  if (op.kind === "delete") {
    effects.push(`Archiving "${op.previous.name}" stops it applying at once. ${pendingNote}`)
    return effects
  }
  const next = specOf({ id: "", name: op.item.name, spec: op.item.spec })
  if (op.kind === "create") {
    const assigned = next && (next.assignments.organization || next.assignments.teams.length > 0 || next.assignments.members.length > 0)
    if (assigned && next?.hardLimit) effects.push(`Spend already tracked this period counts toward "${op.item.name}": members already over it are blocked as soon as it is created. ${pendingNote}`)
    else if (assigned) effects.push(pendingNote)
    return effects
  }
  const previous = specOf(op.previous)
  const lowered = TIMEFRAME_ORDER.some((frame) => {
    const before = microOf(previous, frame)
    const after = microOf(next, frame)
    return after !== null && (before === null || after < before)
  })
  const hardened = next?.hardLimit === true && previous?.hardLimit === false
  if ((lowered || hardened) && next?.hardLimit) effects.push(`Members already over the new "${op.item.name}" limit are blocked immediately.`)
  if (touches(op.changes, "limits") || touches(op.changes, "provider") || touches(op.changes, "hardLimit") || touches(op.changes, "allowRequestReset") || touches(op.changes, "assignments")) effects.push(pendingNote)
  return effects
}

export const aiGatewayLimitsArea = defineConfigArea({
  key: AREA,
  label: "Limits",
  path: ["AI Gateway", "Limits"],
  specVersion: 1,
  specSchema: limitsSpecSchema,
  dependsOn: [PROVIDERS_AREA, "members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "gateway_limits.view",
  managePermission: "gateway_limits.manage",
  // Runtime accounting (gateway_usage_subject, _tracking, _bucket, _consumption_event, _quarantine,
  // _bucket_charge, _reset_request, _audit) is never exported.
  tables: ["gateway_usage_limit_policy", "gateway_usage_limit_entry", "gateway_usage_limit_assignment"],
  naturalKeys: [{ label: "name", get: (item) => item.name.trim().toLowerCase() || null }],
  similarity,
  secretFields: [],
  arrayKeys: { limits: "timeframe" },
  // A limit on one provider's usage is that provider's: without it, it would become a limit on everything.
  requiredRefs: ["provider"],
  // The usage service opens its own (deadlock-retried) transactions.
  transactional: false,
  irreversible,

  exportItems: (ctx) => readPolicies(ctx),
  readItems: (ctx, ids) => readPolicies(ctx, ids),
  preflight: limitsPreflight,
  apply: applyLimits,
})
