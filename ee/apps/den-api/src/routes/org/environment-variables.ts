import { and, asc, eq, inArray, isNotNull, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  EnvironmentVariableAccessTable,
  EnvironmentVariableMemberSettingTable,
  EnvironmentVariableTable,
  MemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import {
  environmentVariableAssignmentOptionSchema,
  environmentVariableKeySchema,
  environmentVariableValueModeSchema,
  environmentVariableValueSchema,
  environmentVariableValueSourceSchema,
  resolvedEnvironmentVariablesResponseSchema,
  type EnvironmentVariableValueMode,
  type ResolvedEnvironmentVariable,
} from "@openwork/types/den/environment-variables"
import { credentialPromptSchema } from "@openwork/types/den/credential-prompt"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import {
  environmentVariableAdminChange,
  environmentVariableAssignmentSelectedEvent,
  environmentVariableOwnValueEvent,
  type EnvironmentVariableAuditState,
} from "../../audit/domain/environment-variables.js"
import { appendDomainChanges } from "../../audit/domain/legacy.js"
import { addAuditRequestResource, auditChangeCapture, type AuditChangeCapture } from "../../audit/request-capture.js"
import { credentialPromptResponseFields, environmentVariableMemberValuePrompt } from "../../credential-prompt.js"
import {
  accessTarget,
  accessTargetKey,
  memberReceivesEnvironmentVariable,
  resolveEnvironmentVariableValue,
  type AccessTarget,
} from "../../environment-variables/resolve.js"
import { requireFeature } from "../../features.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  requireOrgPermission,
  resolveMemberTeamsMiddleware,
} from "../../middleware/index.js"
import {
  denTypeIdSchema,
  emptyResponse,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  notFoundSchema,
  unauthorizedSchema,
} from "../../openapi.js"
import { isDuplicateEntry } from "./declarative.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema } from "./shared.js"

type EnvironmentVariableRow = typeof EnvironmentVariableTable.$inferSelect
type AccessRow = typeof EnvironmentVariableAccessTable.$inferSelect
type OrganizationId = EnvironmentVariableRow["organizationId"]
type EnvironmentVariableId = EnvironmentVariableRow["id"]
type MemberId = typeof MemberTable.$inferSelect.id
type TeamId = typeof TeamTable.$inferSelect.id
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

const TAG = "Environment Variables"
const FEATURE = "environmentVariables"

const paramsSchema = idParamSchema("environmentVariableId", "environmentVariable")

const nameSchema = z.string().trim().min(1).max(255)
const descriptionSchema = z.string().trim().max(2000).nullable()
/** Leave out to keep the stored value (updates), null to remove it. Ignored when each person sets their own. */
const assignmentValueSchema = environmentVariableValueSchema.nullable().optional()

const assignmentWriteSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("everyone"), value: assignmentValueSchema }).strict(),
  z.object({ type: z.literal("team"), teamId: denTypeIdSchema("team"), value: assignmentValueSchema }).strict(),
  z.object({ type: z.literal("member"), orgMembershipId: denTypeIdSchema("member"), value: assignmentValueSchema }).strict(),
])
type AssignmentWrite = z.infer<typeof assignmentWriteSchema>

const createSchema = z.object({
  name: nameSchema,
  key: environmentVariableKeySchema,
  description: descriptionSchema.optional(),
  valueMode: environmentVariableValueModeSchema,
  /** Who receives it: everyone, teams and people, each with its own value when an admin sets values. */
  assignments: z.array(assignmentWriteSchema).max(1000).default([]),
  /** Agents and API keys: true once the person explicitly asked to deploy these values. */
  confirmed: z.boolean().optional(),
}).strict().meta({ ref: "EnvironmentVariableCreate" })

const updateSchema = z.object({
  name: nameSchema.optional(),
  key: environmentVariableKeySchema.optional(),
  description: descriptionSchema.optional(),
  valueMode: environmentVariableValueModeSchema.optional(),
  /** Replaces who receives it. An assignment that leaves out value keeps the value stored for the same target. */
  assignments: z.array(assignmentWriteSchema).max(1000).optional(),
  /** Agents and API keys: true once the person explicitly asked to deploy the values this change sets. */
  confirmed: z.boolean().optional(),
  /** Agents and API keys: true once the person agreed to replace or remove values that are already set. */
  replaceExisting: z.boolean().optional(),
}).strict().meta({ ref: "EnvironmentVariableUpdate" })

const myValueWriteSchema = z.object({
  value: environmentVariableValueSchema,
  /** Agents and API keys: true once the person explicitly asked to set this value. */
  confirmed: z.boolean().optional(),
  /** Agents and API keys: true once the person agreed to replace their current value. */
  replaceExisting: z.boolean().optional(),
}).strict().meta({ ref: "EnvironmentVariableMyValueWrite" })

const myValueDeleteQuerySchema = z.object({ confirmed: z.enum(["true", "false"]).optional() })

const myAssignmentWriteSchema = z.object({
  /** The assignment to use, from the variable's assignments; null goes back to the default. */
  accessId: z.string().trim().min(1).max(160).nullable(),
}).strict().meta({ ref: "EnvironmentVariableMyAssignmentWrite" })

const adminAssignmentSchema = z.object({
  accessId: z.string(),
  type: z.enum(["everyone", "team", "member"]),
  teamId: z.string().nullable(),
  orgMembershipId: z.string().nullable(),
  /** Team name, person's name, or "Everyone". */
  label: z.string(),
  email: z.string().nullable(),
  /** An admin value is stored for this assignment. Values are never returned. */
  hasValue: z.boolean(),
  updatedAt: z.string().datetime(),
})

const adminVariableSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  valueMode: environmentVariableValueModeSchema,
  assignments: z.array(adminAssignmentSchema),
  /** How many people set their own value (per_member). */
  memberValueCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "EnvironmentVariable" })

const adminListSchema = z.object({
  environmentVariables: z.array(adminVariableSchema),
  canManage: z.boolean(),
}).meta({ ref: "EnvironmentVariableList" })

const adminResponseSchema = z.object({ environmentVariable: adminVariableSchema }).meta({ ref: "EnvironmentVariableResponse" })

const memberVariableSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  valueMode: environmentVariableValueModeSchema,
  source: environmentVariableValueSourceSchema.nullable(),
  hasValue: z.boolean(),
  /** The caller sets this variable's value themselves. */
  editable: z.boolean(),
  /** Assignments that give the caller a value, by name; choose one with my-assignment. */
  assignments: z.array(environmentVariableAssignmentOptionSchema),
  selectedAccessId: z.string().nullable(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "MemberEnvironmentVariable" })

const memberListSchema = z.object({
  environmentVariables: z.array(memberVariableSchema),
}).meta({ ref: "MemberEnvironmentVariableList" })

const valuePromptResponseSchema = z.object({
  environmentVariableId: z.string(),
  credentialPrompt: credentialPromptSchema,
  nextStep: z.string(),
}).meta({ ref: "EnvironmentVariableValuePromptResponse" })

const okSchema = z.object({ ok: z.literal(true) })
const conflictSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  /** Assignments whose stored value the write would replace or remove. */
  affected: z.array(z.string()).optional(),
}).meta({ ref: "EnvironmentVariableConflict" })

class RouteFailure extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly error: string, message?: string, readonly affected?: string[]) {
    super(message ?? error)
  }
}

function serialize(date: Date) {
  return date.toISOString()
}

/** Agents (the internal MCP principal) and API keys act for a person who may not be watching. */
function isMachineCaller(c: { get: <K extends "apiKey" | "session">(key: K) => OrgRouteVariables[K] }) {
  return c.get("session")?.id === "mcp_internal" || Boolean(c.get("apiKey"))
}

function parseVariableId(value: string): EnvironmentVariableId | null {
  try {
    return normalizeDenTypeId("environmentVariable", value)
  } catch {
    return null
  }
}

async function getVariable(organizationId: OrganizationId, id: EnvironmentVariableId, tx: Pick<typeof db, "select"> = db) {
  const rows = await tx
    .select()
    .from(EnvironmentVariableTable)
    .where(and(eq(EnvironmentVariableTable.id, id), eq(EnvironmentVariableTable.organizationId, organizationId)))
    .limit(1)
  return rows[0] ?? null
}

async function listAccess(variableId: EnvironmentVariableId, tx: Pick<typeof db, "select"> = db) {
  return tx.select().from(EnvironmentVariableAccessTable).where(eq(EnvironmentVariableAccessTable.environmentVariableId, variableId))
}

function auditState(variable: Pick<EnvironmentVariableRow, "id" | "name" | "key" | "description" | "valueMode">, access: readonly AccessRow[]): EnvironmentVariableAuditState {
  return {
    id: variable.id,
    name: variable.name,
    key: variable.key,
    description: variable.description ?? null,
    valueMode: variable.valueMode,
    assignments: access.map((entry) => ({ target: accessTargetKey(accessTarget(entry)), hasValue: Boolean(entry.value) })),
  }
}

/** Checks every member and team belongs to the organization; returns writes keyed by target. */
async function validateAssignments(organizationId: OrganizationId, assignments: readonly AssignmentWrite[]) {
  const memberIds = [...new Set(assignments.flatMap((entry) => entry.type === "member" ? [normalizeDenTypeId("member", entry.orgMembershipId)] : []))]
  const teamIds = [...new Set(assignments.flatMap((entry) => entry.type === "team" ? [normalizeDenTypeId("team", entry.teamId)] : []))]
  if (memberIds.length > 0) {
    const rows = await db.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, memberIds), isNull(MemberTable.removedAt)))
    if (rows.length !== memberIds.length) throw new RouteFailure(404, "member_not_found")
  }
  if (teamIds.length > 0) {
    const rows = await db.select({ id: TeamTable.id }).from(TeamTable)
      .where(and(eq(TeamTable.organizationId, organizationId), inArray(TeamTable.id, teamIds)))
    if (rows.length !== teamIds.length) throw new RouteFailure(404, "team_not_found")
  }
  const byTarget = new Map<string, { target: AccessTarget; value: string | null | undefined }>()
  for (const entry of assignments) {
    const target: AccessTarget = entry.type === "everyone" ? { type: "everyone" }
      : entry.type === "team" ? { type: "team", teamId: normalizeDenTypeId("team", entry.teamId) }
        : { type: "member", orgMembershipId: normalizeDenTypeId("member", entry.orgMembershipId) }
    byTarget.set(accessTargetKey(target), { target, value: entry.value })
  }
  return byTarget
}

type PlannedAccess = { target: AccessTarget; value: string | null; existing: AccessRow | null }

/**
 * The assignments after a write, and which stored values it sets, replaces or
 * removes. Each person sets their own value in per_member mode, so assignments
 * keep no value there.
 */
function planAccess(input: {
  valueMode: EnvironmentVariableValueMode
  existing: readonly AccessRow[]
  writes: Map<string, { target: AccessTarget; value: string | null | undefined }> | null
}) {
  const existingByTarget = new Map(input.existing.map((entry) => [accessTargetKey(accessTarget(entry)), entry]))
  const writes = input.writes ?? new Map([...existingByTarget].map(([key, entry]) => [key, { target: accessTarget(entry), value: undefined }]))
  const planned: PlannedAccess[] = []
  const changed: string[] = []
  const replaced: string[] = []
  for (const [key, write] of writes) {
    const existing = existingByTarget.get(key) ?? null
    const stored = existing?.value ?? null
    const value = input.valueMode === "per_member" ? null : write.value === undefined ? stored : write.value || null
    planned.push({ target: write.target, value, existing })
    if (value !== stored) {
      changed.push(key)
      if (stored !== null) replaced.push(key)
    }
  }
  for (const [key, entry] of existingByTarget) {
    if (writes.has(key)) continue
    if (entry.value) {
      changed.push(key)
      replaced.push(key)
    }
  }
  return { planned, changed, replaced }
}

async function writeAccess(tx: DbTransaction, variableId: EnvironmentVariableId, plan: readonly PlannedAccess[], memberId: MemberId) {
  const keep = new Set(plan.flatMap((entry) => entry.existing ? [entry.existing.id] : []))
  const stale = await tx.select({ id: EnvironmentVariableAccessTable.id }).from(EnvironmentVariableAccessTable)
    .where(eq(EnvironmentVariableAccessTable.environmentVariableId, variableId))
  const remove = stale.map((row) => row.id).filter((id) => !keep.has(id))
  if (remove.length > 0) await tx.delete(EnvironmentVariableAccessTable).where(inArray(EnvironmentVariableAccessTable.id, remove))
  for (const entry of plan) {
    if (entry.existing) {
      if ((entry.existing.value ?? null) !== entry.value) {
        await tx.update(EnvironmentVariableAccessTable)
          .set({ value: entry.value, updatedByOrgMembershipId: memberId, updatedAt: new Date() })
          .where(eq(EnvironmentVariableAccessTable.id, entry.existing.id))
      }
      continue
    }
    await tx.insert(EnvironmentVariableAccessTable).values({
      id: createDenTypeId("environmentVariableAccess"),
      environmentVariableId: variableId,
      orgMembershipId: entry.target.type === "member" ? normalizeDenTypeId("member", entry.target.orgMembershipId) : null,
      teamId: entry.target.type === "team" ? normalizeDenTypeId("team", entry.target.teamId) : null,
      value: entry.value,
      updatedByOrgMembershipId: entry.value ? memberId : null,
    })
  }
}

async function loadAdminVariables(organizationId: OrganizationId, onlyId?: EnvironmentVariableId) {
  const variables = await db
    .select()
    .from(EnvironmentVariableTable)
    .where(and(
      eq(EnvironmentVariableTable.organizationId, organizationId),
      onlyId ? eq(EnvironmentVariableTable.id, onlyId) : undefined,
    ))
    .orderBy(asc(EnvironmentVariableTable.key))
  if (variables.length === 0) return []
  const ids = variables.map((variable) => variable.id)

  const [accessRows, memberRows, teamRows, ownValueRows] = await Promise.all([
    db.select().from(EnvironmentVariableAccessTable).where(inArray(EnvironmentVariableAccessTable.environmentVariableId, ids)),
    db
      .select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
      .from(EnvironmentVariableAccessTable)
      .innerJoin(MemberTable, eq(EnvironmentVariableAccessTable.orgMembershipId, MemberTable.id))
      .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(inArray(EnvironmentVariableAccessTable.environmentVariableId, ids)),
    db
      .select({ id: TeamTable.id, name: TeamTable.name })
      .from(EnvironmentVariableAccessTable)
      .innerJoin(TeamTable, eq(EnvironmentVariableAccessTable.teamId, TeamTable.id))
      .where(inArray(EnvironmentVariableAccessTable.environmentVariableId, ids)),
    db
      .select({ environmentVariableId: EnvironmentVariableMemberSettingTable.environmentVariableId })
      .from(EnvironmentVariableMemberSettingTable)
      .where(and(inArray(EnvironmentVariableMemberSettingTable.environmentVariableId, ids), isNotNull(EnvironmentVariableMemberSettingTable.value))),
  ])
  const members = new Map(memberRows.map((row) => [row.id, row]))
  const teams = new Map(teamRows.map((row) => [row.id, row.name]))
  const rank = { everyone: 0, team: 1, member: 2 }

  return variables.map((variable) => ({
    id: variable.id,
    name: variable.name,
    key: variable.key,
    description: variable.description ?? null,
    valueMode: variable.valueMode,
    assignments: accessRows
      .filter((row) => row.environmentVariableId === variable.id)
      .map((row) => {
        const target = accessTarget(row)
        const member = target.type === "member" ? members.get(normalizeDenTypeId("member", target.orgMembershipId)) : undefined
        return {
          accessId: row.id,
          type: target.type,
          teamId: target.type === "team" ? target.teamId : null,
          orgMembershipId: target.type === "member" ? target.orgMembershipId : null,
          label: target.type === "everyone" ? "Everyone"
            : target.type === "team" ? teams.get(normalizeDenTypeId("team", target.teamId)) ?? "Team"
              : member?.name ?? member?.email ?? "Member",
          email: member?.email ?? null,
          hasValue: Boolean(row.value),
          updatedAt: serialize(row.updatedAt),
        }
      })
      .sort((a, b) => rank[a.type] - rank[b.type] || a.label.localeCompare(b.label)),
    memberValueCount: ownValueRows.filter((row) => row.environmentVariableId === variable.id).length,
    createdAt: serialize(variable.createdAt),
    updatedAt: serialize(variable.updatedAt),
  }))
}

/**
 * Every variable the member receives, with the member's effective value.
 * Values are decrypted here; callers decide whether they may be returned.
 */
export async function resolveMemberEnvironmentVariables(input: {
  organizationId: OrganizationId
  organizationName: string
  memberId: MemberId
  memberTeams: ReadonlyArray<{ id: TeamId; name: string }>
}): Promise<ResolvedEnvironmentVariable[]> {
  const teamIds = input.memberTeams.map((team) => team.id)
  const accessRows = await db
    .select({ access: EnvironmentVariableAccessTable })
    .from(EnvironmentVariableAccessTable)
    .innerJoin(EnvironmentVariableTable, eq(EnvironmentVariableAccessTable.environmentVariableId, EnvironmentVariableTable.id))
    .where(and(
      eq(EnvironmentVariableTable.organizationId, input.organizationId),
      or(
        eq(EnvironmentVariableAccessTable.orgMembershipId, input.memberId),
        teamIds.length > 0 ? inArray(EnvironmentVariableAccessTable.teamId, teamIds) : undefined,
        and(isNull(EnvironmentVariableAccessTable.orgMembershipId), isNull(EnvironmentVariableAccessTable.teamId)),
      ),
    ))
  const ids = [...new Set(accessRows.map((row) => row.access.environmentVariableId))]
  if (ids.length === 0) return []

  const [variables, settings] = await Promise.all([
    db
      .select()
      .from(EnvironmentVariableTable)
      .where(and(eq(EnvironmentVariableTable.organizationId, input.organizationId), inArray(EnvironmentVariableTable.id, ids)))
      .orderBy(asc(EnvironmentVariableTable.key)),
    db
      .select()
      .from(EnvironmentVariableMemberSettingTable)
      .where(and(
        inArray(EnvironmentVariableMemberSettingTable.environmentVariableId, ids),
        eq(EnvironmentVariableMemberSettingTable.orgMembershipId, input.memberId),
      )),
  ])

  return variables.map((variable) => {
    const own = settings.find((row) => row.environmentVariableId === variable.id) ?? null
    const access = accessRows
      .filter((row) => row.access.environmentVariableId === variable.id)
      .map((row) => ({ id: row.access.id, orgMembershipId: row.access.orgMembershipId, teamId: row.access.teamId, value: row.access.value ?? null }))
    const resolved = resolveEnvironmentVariableValue({
      valueMode: variable.valueMode,
      access,
      member: { id: input.memberId, teams: input.memberTeams },
      organizationName: input.organizationName,
      ownValue: own?.value ?? null,
      selectedAccessId: own?.selectedAccessId ?? null,
    })
    const latest = [variable.updatedAt, ...(own ? [own.updatedAt] : []), ...accessRows.filter((row) => row.access.environmentVariableId === variable.id).map((row) => row.access.updatedAt)]
      .reduce((a, b) => (b > a ? b : a))
    return {
      id: variable.id,
      key: variable.key,
      name: variable.name,
      description: variable.description ?? null,
      valueMode: variable.valueMode,
      source: resolved.source,
      editable: variable.valueMode === "per_member",
      assignments: resolved.assignments,
      selectedAccessId: resolved.selectedAccessId,
      value: resolved.value,
      updatedAt: serialize(latest),
    }
  })
}

async function memberReceives(variableId: EnvironmentVariableId, memberId: MemberId, memberTeams: ReadonlyArray<{ id: TeamId; name: string }>) {
  const access = await db
    .select({ orgMembershipId: EnvironmentVariableAccessTable.orgMembershipId, teamId: EnvironmentVariableAccessTable.teamId })
    .from(EnvironmentVariableAccessTable)
    .where(eq(EnvironmentVariableAccessTable.environmentVariableId, variableId))
  return memberReceivesEnvironmentVariable(access, { id: memberId, teams: memberTeams })
}

async function getMemberSetting(tx: DbTransaction, variableId: EnvironmentVariableId, memberId: MemberId) {
  const rows = await tx.select().from(EnvironmentVariableMemberSettingTable)
    .where(and(eq(EnvironmentVariableMemberSettingTable.environmentVariableId, variableId), eq(EnvironmentVariableMemberSettingTable.orgMembershipId, memberId)))
    .for("update")
    .limit(1)
  return rows[0] ?? null
}

async function saveMemberSetting(tx: DbTransaction, input: {
  organizationId: OrganizationId
  variableId: EnvironmentVariableId
  memberId: MemberId
  existing: typeof EnvironmentVariableMemberSettingTable.$inferSelect | null
  changes: { value?: string | null; selectedAccessId?: typeof EnvironmentVariableMemberSettingTable.$inferSelect.selectedAccessId }
}) {
  if (input.existing) {
    await tx.update(EnvironmentVariableMemberSettingTable).set({ ...input.changes, updatedAt: new Date() })
      .where(eq(EnvironmentVariableMemberSettingTable.id, input.existing.id))
    return
  }
  await tx.insert(EnvironmentVariableMemberSettingTable).values({
    id: createDenTypeId("environmentVariableMemberSetting"),
    organizationId: input.organizationId,
    environmentVariableId: input.variableId,
    orgMembershipId: input.memberId,
    value: input.changes.value ?? null,
    selectedAccessId: input.changes.selectedAccessId ?? null,
  })
}

function failureResponse(c: { json: (body: unknown, status: 400 | 404 | 409) => Response }, error: unknown) {
  if (error instanceof RouteFailure) {
    return c.json({
      error: error.error,
      ...(error.message !== error.error ? { message: error.message } : {}),
      ...(error.affected ? { affected: error.affected } : {}),
    }, error.status)
  }
  if (isDuplicateEntry(error)) return c.json({ error: "environment_variable_key_taken", message: "Another environment variable already uses this key." }, 409)
  throw error
}

export function registerOrgEnvironmentVariableRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/environment-variables",
    describeRoute({
      tags: [TAG],
      summary: "List organization environment variables",
      description: "Lists every environment variable the organization deploys to desktops, with each assignment (everyone, a team or a person) and whether it holds a value. Values are never returned. Requires the environment_variables.view permission.",
      responses: {
        200: jsonResponse("Environment variables returned.", adminListSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the environment_variables.view permission.", forbiddenSchema),
        404: jsonResponse("Environment variables are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    requireOrgPermission("environment_variables.view"),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      return c.json({
        environmentVariables: await loadAdminVariables(payload.organization.id),
        canManage: await hasPermission(c, "environment_variables.manage"),
      })
    },
  )

  app.get(
    "/v1/environment-variables/mine",
    describeRoute({
      tags: [TAG],
      summary: "List my environment variables",
      description: "Lists the environment variables deployed to the caller's desktop agent, where each value comes from and whether one is set. Values are never returned. editable true means the person sets the value themselves (my-value, or the value prompt for a private field). assignments names every assignment giving the person a value; they can pick one with my-assignment.",
      responses: {
        200: jsonResponse("The caller's environment variables returned.", memberListSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Environment variables are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const variables = await resolveMemberEnvironmentVariables({
        organizationId: payload.organization.id,
        organizationName: payload.organization.name,
        memberId: payload.currentMember.id,
        memberTeams: c.get("memberTeams") ?? [],
      })
      return c.json({
        environmentVariables: variables.map(({ value, ...variable }) => ({ ...variable, hasValue: value !== null })),
      })
    },
  )

  // Values for the desktop that runs the caller's agent. Never an agent
  // capability: values are only read while the desktop syncs its environment.
  app.get(
    "/v1/environment-variables/resolved",
    describeNonMcpRoute({
      tags: [TAG],
      summary: "Resolve my environment variable values",
      description: "Returns the caller's environment variables with their effective values, for the desktop to add to the agent's environment. Not available to agents or API keys.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("Resolved environment variables returned.", resolvedEnvironmentVariablesResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Agents and API keys cannot read values.", forbiddenSchema),
        404: jsonResponse("Environment variables are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      if (isMachineCaller(c)) {
        return c.json({ error: "forbidden", message: "Environment variable values are only delivered to the person's desktop." }, 403)
      }
      const environmentVariables = await resolveMemberEnvironmentVariables({
        organizationId: payload.organization.id,
        organizationName: payload.organization.name,
        memberId: payload.currentMember.id,
        memberTeams: c.get("memberTeams") ?? [],
      })
      return c.json({ environmentVariables })
    },
  )

  app.get(
    "/v1/environment-variables/:environmentVariableId",
    describeRoute({
      tags: [TAG],
      summary: "Get an environment variable",
      description: "Returns one environment variable with its assignments and whether each holds a value. Values are never returned. Requires the environment_variables.view permission.",
      responses: {
        200: jsonResponse("Environment variable returned.", adminResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the environment_variables.view permission.", forbiddenSchema),
        404: jsonResponse("The environment variable was not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    requireOrgPermission("environment_variables.view"),
    paramValidator(paramsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const id = parseVariableId(c.req.valid("param").environmentVariableId)
      const [variable] = id ? await loadAdminVariables(payload.organization.id, id) : []
      if (!variable) return c.json({ error: "environment_variable_not_found" }, 404)
      return c.json({ environmentVariable: variable })
    },
  )

  app.post(
    "/v1/environment-variables",
    describeRoute({
      tags: [TAG],
      summary: "Create an environment variable",
      description: "Creates an environment variable for the agents of everyone, chosen teams or chosen people. With valueMode admin each assignment carries its own value (a person in several gets the most specific: directly to them, then their teams, then everyone; they can choose another). With valueMode per_member each person sets their own value. Agents: only send values the person explicitly asked to deploy, with confirmed true (409 confirmation_required otherwise). Requires the environment_variables.manage permission and a recent sign-in.",
      responses: {
        201: jsonResponse("Environment variable created.", adminResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the environment_variables.manage permission.", forbiddenSchema),
        404: jsonResponse("A member or team was not found.", notFoundSchema),
        409: jsonResponse("Another environment variable already uses this key.", conflictSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    requireOrgPermission("environment_variables.manage"),
    jsonValidator(createSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const input = c.req.valid("json")
      const organizationId = payload.organization.id
      const id = createDenTypeId("environmentVariable")
      const capture = auditChangeCapture(c)
      try {
        const writes = await validateAssignments(organizationId, input.assignments)
        const plan = planAccess({ valueMode: input.valueMode, existing: [], writes })
        if (isMachineCaller(c) && plan.changed.length > 0 && input.confirmed !== true) {
          throw new RouteFailure(409, "confirmation_required",
            "These values reach people's desktop agents. Only deploy values the person explicitly asked for; tell them which assignments get a value, then send again with confirmed true.",
            plan.changed)
        }
        await db.transaction(async (tx) => {
          const row = {
            id,
            organizationId,
            createdByOrgMembershipId: payload.currentMember.id,
            name: input.name,
            key: input.key,
            description: input.description || null,
            valueMode: input.valueMode,
          }
          await tx.insert(EnvironmentVariableTable).values(row)
          await writeAccess(tx, id, plan.planned, payload.currentMember.id)
          await appendDomainChanges(tx, capture, [environmentVariableAdminChange({
            organizationId,
            before: null,
            after: auditState(row, await listAccess(id, tx)),
            valuesChangedFor: plan.changed,
          })])
        })
      } catch (error) {
        return failureResponse(c, error)
      }
      addAuditRequestResource(c, { type: "environment_variable", id })
      const [variable] = await loadAdminVariables(organizationId, id)
      return c.json({ environmentVariable: variable }, 201)
    },
  )

  app.patch(
    "/v1/environment-variables/:environmentVariableId",
    describeRoute({
      tags: [TAG],
      summary: "Update an environment variable",
      description: "Changes an environment variable's name, key, description, how it gets its value, or its assignments (send assignments to replace them; an assignment without value keeps its stored value). Values the new state no longer uses are removed. Agents and API keys get 409 confirmation_required when the change sets new values (send confirmed true once the person asked for them) or replaces or removes a value that is already set (ask the person, then send replaceExisting true). Requires the environment_variables.manage permission and a recent sign-in.",
      responses: {
        200: jsonResponse("Environment variable updated.", adminResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the environment_variables.manage permission.", forbiddenSchema),
        404: jsonResponse("The environment variable, a member or a team was not found.", notFoundSchema),
        409: jsonResponse("Another environment variable uses this key, or values would be replaced without confirmation.", conflictSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    requireOrgPermission("environment_variables.manage"),
    paramValidator(paramsSchema),
    jsonValidator(updateSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const organizationId = payload.organization.id
      const id = parseVariableId(c.req.valid("param").environmentVariableId)
      if (!id || !(await getVariable(organizationId, id))) return c.json({ error: "environment_variable_not_found" }, 404)
      const input = c.req.valid("json")
      const machine = isMachineCaller(c)
      const capture = auditChangeCapture(c)
      try {
        const writes = input.assignments ? await validateAssignments(organizationId, input.assignments) : null
        await db.transaction(async (tx) => {
          const existing = await tx.select().from(EnvironmentVariableTable).where(eq(EnvironmentVariableTable.id, id)).for("update").limit(1)
          const variable = existing[0]
          if (!variable) throw new RouteFailure(404, "environment_variable_not_found")
          const access = await listAccess(id, tx)
          const valueMode = input.valueMode ?? variable.valueMode
          const plan = planAccess({ valueMode, existing: access, writes })
          const dropsOwnValues = variable.valueMode === "per_member" && valueMode !== "per_member"
          const setsValues = plan.changed.some((key) => !plan.replaced.includes(key))
          if (machine && setsValues && input.confirmed !== true) {
            throw new RouteFailure(409, "confirmation_required",
              "These values reach people's desktop agents. Only deploy values the person explicitly asked for; tell them which assignments get a value, then send again with confirmed true.",
              plan.changed.filter((key) => !plan.replaced.includes(key)))
          }
          if (machine && input.replaceExisting !== true && (plan.replaced.length > 0 || dropsOwnValues)) {
            throw new RouteFailure(409, "confirmation_required",
              "This change replaces or removes values that are already set. Tell the person which, and only if they agree, send it again with replaceExisting true.",
              [...plan.replaced, ...(dropsOwnValues ? ["each person's own value"] : [])])
          }
          const next = {
            name: input.name ?? variable.name,
            key: input.key ?? variable.key,
            description: input.description !== undefined ? input.description || null : variable.description,
            valueMode,
          }
          await tx.update(EnvironmentVariableTable).set({ ...next, updatedAt: new Date() }).where(eq(EnvironmentVariableTable.id, id))
          await writeAccess(tx, id, plan.planned, payload.currentMember.id)
          // Each person's own values only exist while each person sets their own.
          if (dropsOwnValues) {
            await tx.update(EnvironmentVariableMemberSettingTable).set({ value: null, updatedAt: new Date() })
              .where(eq(EnvironmentVariableMemberSettingTable.environmentVariableId, id))
          }
          await appendDomainChanges(tx, capture, [environmentVariableAdminChange({
            organizationId,
            before: auditState(variable, access),
            after: auditState({ id, ...next }, await listAccess(id, tx)),
            valuesChangedFor: [...plan.changed, ...(dropsOwnValues ? ["own_values"] : [])],
          })])
        })
      } catch (error) {
        return failureResponse(c, error)
      }
      const [variable] = await loadAdminVariables(organizationId, id)
      return c.json({ environmentVariable: variable })
    },
  )

  app.delete(
    "/v1/environment-variables/:environmentVariableId",
    describeRoute({
      tags: [TAG],
      summary: "Delete an environment variable",
      description: "Deletes an environment variable and every value stored for it. Desktops remove it from the agent's environment the next time they refresh. Requires the environment_variables.manage permission and a recent sign-in.",
      responses: {
        204: emptyResponse("Environment variable deleted."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the environment_variables.manage permission.", forbiddenSchema),
        404: jsonResponse("The environment variable was not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    requireOrgPermission("environment_variables.manage"),
    paramValidator(paramsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const id = parseVariableId(c.req.valid("param").environmentVariableId)
      const existing = id ? await getVariable(payload.organization.id, id) : null
      if (!existing) return c.json({ error: "environment_variable_not_found" }, 404)
      await deleteEnvironmentVariables(payload.organization.id, [existing.id], auditChangeCapture(c))
      return c.body(null, 204)
    },
  )

  // Asks the person for their own value in a private field, so it never passes through the agent.
  app.post(
    "/v1/environment-variables/:environmentVariableId/value-prompt",
    describeRoute({
      tags: [TAG],
      summary: "Ask a person to enter their own environment variable value",
      ...{ "x-mcp-search-aliases": ["set my environment variable privately", "enter environment variable value privately", "missing environment variable value"] },
      description: "Shows the person a private field in OpenWork for their own value of an environment variable each person sets themselves. Prefer this when the person hasn't given you the value. Changes nothing by itself.",
      responses: {
        200: jsonResponse("A private field is shown to the person.", valuePromptResponseSchema),
        400: jsonResponse("An admin sets this variable's value.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The variable is not deployed to the caller.", forbiddenSchema),
        404: jsonResponse("The environment variable was not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    resolveMemberTeamsMiddleware,
    paramValidator(paramsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const id = parseVariableId(c.req.valid("param").environmentVariableId)
      const variable = id ? await getVariable(payload.organization.id, id) : null
      if (!variable) return c.json({ error: "environment_variable_not_found" }, 404)
      if (!(await memberReceives(variable.id, payload.currentMember.id, c.get("memberTeams") ?? []))) {
        return c.json({ error: "forbidden", message: "This environment variable is not deployed to you." }, 403)
      }
      if (variable.valueMode !== "per_member") {
        return c.json({ error: "invalid_request", message: `An admin sets ${variable.key}. Ask an organization admin to change it.`, details: [] }, 400)
      }
      return c.json({ environmentVariableId: variable.id, ...credentialPromptResponseFields(environmentVariableMemberValuePrompt(variable)) })
    },
  )

  app.put(
    "/v1/environment-variables/:environmentVariableId/my-value",
    describeRoute({
      tags: [TAG],
      summary: "Set my environment variable value",
      ...{ "x-mcp-search-aliases": ["set my environment variable", "save my env var", "update my token variable"] },
      description: "Saves the caller's own value for an environment variable each person sets themselves. Agents: only send a value the person explicitly asked you to save, with confirmed true. If they already have a value you get 409 confirmation_required: ask whether to replace it, then send again with replaceExisting true. You can never read values back.",
      responses: {
        200: jsonResponse("The caller's value was saved.", okSchema),
        400: jsonResponse("The request was invalid, or an agent did not confirm.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("An admin sets this value, or it is not deployed to the caller.", forbiddenSchema),
        404: jsonResponse("The environment variable was not found.", notFoundSchema),
        409: jsonResponse("A value is already set; replacing it needs replaceExisting true.", conflictSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    resolveMemberTeamsMiddleware,
    paramValidator(paramsSchema),
    jsonValidator(myValueWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const id = parseVariableId(c.req.valid("param").environmentVariableId)
      const variable = id ? await getVariable(payload.organization.id, id) : null
      if (!variable) return c.json({ error: "environment_variable_not_found" }, 404)
      if (!(await memberReceives(variable.id, payload.currentMember.id, c.get("memberTeams") ?? []))) {
        return c.json({ error: "forbidden", message: "This environment variable is not deployed to you." }, 403)
      }
      if (variable.valueMode !== "per_member") {
        return c.json({ error: "admin_managed", message: "Only an organization admin can change this value." }, 403)
      }
      const input = c.req.valid("json")
      const machine = isMachineCaller(c)
      if (machine && input.confirmed !== true) {
        return c.json({ error: "invalid_request", message: `Only save a value the person explicitly asked you to set for ${variable.key}, then send confirmed true. Or use the value prompt so they enter it privately.`, details: [] }, 400)
      }
      const capture = auditChangeCapture(c)
      try {
        await db.transaction(async (tx) => {
          const existing = await getMemberSetting(tx, variable.id, payload.currentMember.id)
          const hadValue = Boolean(existing?.value)
          if (machine && hadValue && input.replaceExisting !== true) {
            throw new RouteFailure(409, "confirmation_required", `The person already has a value for ${variable.key}. Ask whether to replace it; only if they agree, send again with replaceExisting true.`)
          }
          await saveMemberSetting(tx, {
            organizationId: payload.organization.id,
            variableId: variable.id,
            memberId: payload.currentMember.id,
            existing,
            changes: { value: input.value },
          })
          await appendDomainChanges(tx, capture, [environmentVariableOwnValueEvent({
            organizationId: payload.organization.id, variable, memberId: payload.currentMember.id, hadValue, hasValue: true,
          })])
        })
      } catch (error) {
        return failureResponse(c, error)
      }
      return c.json({ ok: true as const })
    },
  )

  app.delete(
    "/v1/environment-variables/:environmentVariableId/my-value",
    describeRoute({
      tags: [TAG],
      summary: "Clear my environment variable value",
      description: "Removes the caller's own value for an environment variable each person sets themselves. Answers 200 even when no value was stored. Agents: only when the person asked, with confirmed=true in the query.",
      responses: {
        200: jsonResponse("The caller's value was removed.", okSchema),
        400: jsonResponse("An agent did not confirm.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("An admin manages this value.", forbiddenSchema),
        404: jsonResponse("The environment variable was not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    paramValidator(paramsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const id = parseVariableId(c.req.valid("param").environmentVariableId)
      const variable = id ? await getVariable(payload.organization.id, id) : null
      if (!variable) return c.json({ error: "environment_variable_not_found" }, 404)
      if (variable.valueMode !== "per_member") {
        return c.json({ error: "forbidden", message: "Only an organization admin can change this value." }, 403)
      }
      const query = myValueDeleteQuerySchema.safeParse({ confirmed: c.req.query("confirmed") })
      if (isMachineCaller(c) && (!query.success || query.data.confirmed !== "true")) {
        return c.json({ error: "invalid_request", message: `Only clear ${variable.key} when the person asked, with confirmed=true.`, details: [] }, 400)
      }
      const capture = auditChangeCapture(c)
      await db.transaction(async (tx) => {
        const existing = await getMemberSetting(tx, variable.id, payload.currentMember.id)
        if (!existing?.value) return
        await tx.update(EnvironmentVariableMemberSettingTable).set({ value: null, updatedAt: new Date() })
          .where(eq(EnvironmentVariableMemberSettingTable.id, existing.id))
        await appendDomainChanges(tx, capture, [environmentVariableOwnValueEvent({
          organizationId: payload.organization.id, variable, memberId: payload.currentMember.id, hadValue: true, hasValue: false,
        })])
      })
      return c.json({ ok: true as const })
    },
  )

  app.put(
    "/v1/environment-variables/:environmentVariableId/my-assignment",
    describeRoute({
      tags: [TAG],
      summary: "Choose which assignment gives me a value",
      description: "When several assignments (for example everyone, a team and directly to the caller) give the caller a value, picks the one their agent uses. accessId comes from the variable's assignments in GET /v1/environment-variables/mine; null goes back to the default (the most specific).",
      responses: {
        200: jsonResponse("The choice was saved.", okSchema),
        400: jsonResponse("The assignment does not give the caller a value.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The variable is not deployed to the caller.", forbiddenSchema),
        404: jsonResponse("The environment variable was not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature(FEATURE),
    resolveMemberTeamsMiddleware,
    paramValidator(paramsSchema),
    jsonValidator(myAssignmentWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const id = parseVariableId(c.req.valid("param").environmentVariableId)
      const variable = id ? await getVariable(payload.organization.id, id) : null
      if (!variable) return c.json({ error: "environment_variable_not_found" }, 404)
      const [resolved] = (await resolveMemberEnvironmentVariables({
        organizationId: payload.organization.id,
        organizationName: payload.organization.name,
        memberId: payload.currentMember.id,
        memberTeams: c.get("memberTeams") ?? [],
      })).filter((entry) => entry.id === variable.id)
      if (!resolved) return c.json({ error: "forbidden", message: "This environment variable is not deployed to you." }, 403)
      const accessId = c.req.valid("json").accessId
      const option = accessId ? resolved.assignments.find((entry) => entry.accessId === accessId) : null
      if (accessId && !option) {
        return c.json({ error: "invalid_request", message: "That assignment doesn't give you a value for this variable.", details: [] }, 400)
      }
      const selectedAccessId = option ? normalizeDenTypeId("environmentVariableAccess", option.accessId) : null
      const capture = auditChangeCapture(c)
      await db.transaction(async (tx) => {
        const existing = await getMemberSetting(tx, variable.id, payload.currentMember.id)
        const before = existing?.selectedAccessId ?? null
        if (before === selectedAccessId) return
        await saveMemberSetting(tx, {
          organizationId: payload.organization.id,
          variableId: variable.id,
          memberId: payload.currentMember.id,
          existing,
          changes: { selectedAccessId },
        })
        await appendDomainChanges(tx, capture, [environmentVariableAssignmentSelectedEvent({
          organizationId: payload.organization.id, variable, memberId: payload.currentMember.id, before, after: selectedAccessId,
        })])
      })
      return c.json({ ok: true as const })
    },
  )
}

/**
 * Deletes variables with their assignments and every person's settings,
 * recording one event each when audit capture applies.
 */
export async function deleteEnvironmentVariables(organizationId: OrganizationId, ids: EnvironmentVariableId[], capture: AuditChangeCapture | null = null) {
  if (ids.length === 0) return
  await db.transaction(async (tx) => {
    const variables = await tx.select().from(EnvironmentVariableTable)
      .where(and(eq(EnvironmentVariableTable.organizationId, organizationId), inArray(EnvironmentVariableTable.id, ids)))
      .for("update")
    const access = await tx.select().from(EnvironmentVariableAccessTable).where(inArray(EnvironmentVariableAccessTable.environmentVariableId, ids))
    await tx.delete(EnvironmentVariableMemberSettingTable).where(inArray(EnvironmentVariableMemberSettingTable.environmentVariableId, ids))
    await tx.delete(EnvironmentVariableAccessTable).where(inArray(EnvironmentVariableAccessTable.environmentVariableId, ids))
    await tx.delete(EnvironmentVariableTable).where(inArray(EnvironmentVariableTable.id, ids))
    await appendDomainChanges(tx, capture, variables.map((variable) => environmentVariableAdminChange({
      organizationId,
      before: auditState(variable, access.filter((entry) => entry.environmentVariableId === variable.id)),
      after: null,
      valuesChangedFor: [],
    })))
  })
}
