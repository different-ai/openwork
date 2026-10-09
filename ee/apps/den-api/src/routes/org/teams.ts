import { declarativeDeleteSchema, declarativeResponses, externalKeyParamsSchema, isDuplicateEntry, type ResourceActionContext, type ResourceOrganizationContext } from "./declarative.js"
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConnectorInstanceAccessGrantTable,
  DashboardAccessGrantTable,
  DesktopPolicyMemberTable,
  ExternalMcpConnectionAccessGrantTable,
  InvitationTable,
  GatewayProviderAccessTable,
  GatewayUsageAssignmentTable,
  LlmProviderAccessTable,
  MarketplaceAccessGrantTable,
  MemberTable,
  PluginAccessGrantTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { deleteTeamAgentPermissionPolicy } from "../../agent-permissions.js"
import { db } from "../../db.js"
import { invalidateTeamInferenceOAuth } from "../../llm/inference-provider-lifecycle.js"
import { isScimManagedTeam } from "../../scim-groups.js"
import { withOrganizationTeamMutation, withOrganizationMembershipUsageMutation, type TeamMutationTransaction } from "../../organization-team-roles.js"
import {
  jsonValidator,
  orgPermissionRoute,
  paramValidator,
} from "../../middleware/index.js"
import {
  ADMIN_TEAM_GRANTS_FORBIDDEN_MESSAGE,
  resolveTeamActorInTransaction,
  teamGrantDecisionInTransaction,
  teamGrantsForbiddenResponse,
  TEAM_GRANTS_FORBIDDEN_MESSAGE,
} from "../../permissions/team-grants.js"
import { ADMIN_GRANT_REQUIRES_ADMIN_MESSAGE, decideAdminTeamChange } from "../../permissions/role-assignment.js"
import { archiveTeamPermissionSets } from "../../permissions/team-set-archive.js"
import { INSUFFICIENT_SCOPE_CHALLENGE, requiresAdminError, type AgentErrorEnvelope } from "../../agent-error-envelope.js"
import { permissionDeniedResponse, type PermissionDeniedResponse } from "../../permissions/check.js"
import type { MemberPermissions } from "../../permissions/effective.js"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import {
  idParamSchema,
  orgAccessFailureStatus,
  permissionFailureHeaders,
  requirePermission,
} from "./shared.js"

const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(255),
  memberIds: z.array(denTypeIdSchema("member")).optional().default([]),
  grantsOrganizationAdmin: z.boolean().optional(),
})

const updateTeamSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  memberIds: z.array(denTypeIdSchema("member")).optional(),
  grantsOrganizationAdmin: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.name === undefined && value.memberIds === undefined && value.grantsOrganizationAdmin === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "Provide at least one field to update.",
    })
  }
})

type TeamId = typeof TeamTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

const orgTeamParamsSchema = idParamSchema("teamId", "team")

const teamResponseSchema = z.object({
  team: z.object({
    id: denTypeIdSchema("team"),
    organizationId: denTypeIdSchema("organization"),
    name: z.string(),
    externalKey: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
      memberIds: z.array(denTypeIdSchema("member")),
      managedByScim: z.boolean(),
      grantsOrganizationAdmin: z.boolean(),
  }),
}).meta({ ref: "TeamResponse" })

function parseTeamId(value: string) {
  return normalizeDenTypeId("team", value)
}

function parseMemberIds(memberIds: string[]) {
  return [...new Set(memberIds.map((value) => normalizeDenTypeId("member", value)))]
}

async function ensureMembersBelongToOrganization(input: {
  organizationId: typeof TeamTable.$inferSelect.organizationId
  memberIds: MemberId[]
}, database: Pick<typeof db, "select"> = db) {
  if (input.memberIds.length === 0) {
    return true
  }

  const rows = await database
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), inArray(MemberTable.id, input.memberIds), isNull(MemberTable.removedAt)))

  const memberIds = new Set(rows.map((row) => row.id))
  return input.memberIds.every((memberId) => memberIds.has(memberId))
}

type TeamGrantsFailure = PermissionDeniedResponse | (AgentErrorEnvelope & { error: "forbidden" })

/**
 * Safety rule 9.3 (docs/permissions/overview.md) and the Admin-team rule
 * (role-assignment.ts decideAdminTeamChange), decided inside the team's write
 * transaction against the actor and permission sets read there under share
 * locks (team-grants.ts teamGrantDecisionInTransaction). The owner bypasses
 * both. SCIM writes team membership through scim-groups.ts, not these routes,
 * so identity-provider membership is exempt. Null means allowed.
 */
async function teamGrantsDenial(tx: TeamMutationTransaction, payload: ResourceOrganizationContext, actor: MemberPermissions, input: {
  teamId: TeamId | null
  grantsOrganizationAdmin: boolean
  adminDefaultsOnly?: boolean
  adminTeamChange: Omit<Parameters<typeof decideAdminTeamChange>[0], "actor"> | null
  message: string
}): Promise<TeamGrantsFailure | null> {
  const decision = await teamGrantDecisionInTransaction({
    tx,
    organizationId: payload.organization.id,
    actor,
    teamId: input.teamId,
    grantsOrganizationAdmin: input.grantsOrganizationAdmin,
    adminDefaultsOnly: input.adminDefaultsOnly,
  })
  if (input.adminTeamChange) {
    const denial = decideAdminTeamChange({ actor, ...input.adminTeamChange })
    if (denial) return { error: "forbidden", ...requiresAdminError(denial.message) }
  }
  if (decision.ok) return null
  if (decision.reason === "requires_admin") return { error: "forbidden", ...requiresAdminError(ADMIN_GRANT_REQUIRES_ADMIN_MESSAGE) }
  return teamGrantsForbiddenResponse(decision.requiredPermission, input.message)
}

function teamGrantsFailureHeaders(response: TeamGrantsFailure): Record<string, string> {
  return "requiredPermission" in response ? { "WWW-Authenticate": INSUFFICIENT_SCOPE_CHALLENGE } : {}
}

/**
 * The route checked these keys against the request's permissions (with the recent sign-in for
 * sensitive ones); re-check them against the actor resolved inside the write transaction
 * (resolveTeamActorInTransaction), so a revocation committed since is seen before the write.
 */
function heldInTransaction(actor: MemberPermissions, keys: readonly PermissionKey[]): PermissionDeniedResponse | null {
  const missing = keys.find((key) => !actor.has(key))
  return missing ? permissionDeniedResponse(missing) : null
}

async function createTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, input: z.infer<typeof createTeamSchema>, externalKey?: string) {
  return withOrganizationTeamMutation(payload.organization.id, async (tx) => {
  if (input.grantsOrganizationAdmin !== undefined) {
    const rolePermission = await requirePermission(c, "teams.manage_admin")
    if (!rolePermission.ok) return c.json(rolePermission.response, orgAccessFailureStatus(rolePermission.response), permissionFailureHeaders(rolePermission.response))
  }
  const actor = await resolveTeamActorInTransaction(tx, payload.organization.id, payload.currentMember.id)
  const notHeld = heldInTransaction(actor, input.grantsOrganizationAdmin !== undefined ? ["teams.manage", "teams.manage_admin"] : ["teams.manage"])
  if (notHeld) return c.json(notHeld, 403, teamGrantsFailureHeaders(notHeld))
  if (input.grantsOrganizationAdmin === true) {
    // A new team has no team permission set yet, so it grants only the Admin defaults.
    const denied = await teamGrantsDenial(tx, payload, actor, {
      teamId: null,
      grantsOrganizationAdmin: true,
      adminTeamChange: { makesAdminTeam: true, addsMembersToAdminTeam: input.memberIds.length > 0 },
      message: ADMIN_TEAM_GRANTS_FORBIDDEN_MESSAGE,
    })
    if (denied) return c.json(denied, 403, teamGrantsFailureHeaders(denied))
  }

  let memberIds: MemberId[]
  try {
    memberIds = parseMemberIds(input.memberIds)
  } catch {
    return c.json({ error: "member_not_found" }, 404)
  }

  const membersBelongToOrg = await ensureMembersBelongToOrganization({
    organizationId: payload.organization.id,
    memberIds,
  }, tx)
  if (!membersBelongToOrg) {
    return c.json({ error: "member_not_found" }, 404)
  }

  const existingTeam = await tx
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, payload.organization.id), eq(TeamTable.name, input.name)))
    .limit(1)

  if (existingTeam[0]) {
    return c.json({ error: "team_exists", message: "That team already exists in this organization." }, 409)
  }

  const teamId = createDenTypeId("team")
  const now = new Date()

    await tx.insert(TeamTable).values({
      externalKey,
      id: teamId,
      name: input.name,
      organizationId: payload.organization.id,
      grantsOrganizationAdmin: input.grantsOrganizationAdmin ?? false,
      createdAt: now,
      updatedAt: now,
    })

    if (memberIds.length > 0) {
      await tx.insert(TeamMemberTable).values(
        memberIds.map((memberId) => ({
          id: createDenTypeId("teamMember"),
          teamId,
          orgMembershipId: memberId,
          createdAt: now,
        })),
      )
    }

  return c.json({
    team: {
      id: teamId,
      externalKey: externalKey ?? null,
      organizationId: payload.organization.id,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      memberIds,
      managedByScim: false,
      grantsOrganizationAdmin: input.grantsOrganizationAdmin ?? false,
    },
  }, 201)
  })
}

async function affectedTeamUsageMembers(tx: TeamMutationTransaction, organizationId: typeof TeamTable.$inferSelect.organizationId, rawId: string, added: string[] = []) {
  let teamId: TeamId, addedIds: MemberId[]
  try { teamId = parseTeamId(rawId); addedIds = parseMemberIds(added) } catch { return [] }
  const old = await tx.select({ id: TeamMemberTable.orgMembershipId }).from(TeamMemberTable)
    .innerJoin(TeamTable, and(eq(TeamTable.id, TeamMemberTable.teamId), eq(TeamTable.organizationId, organizationId)))
    .where(eq(TeamMemberTable.teamId, teamId))
  return [...new Set([...addedIds, ...old.flatMap((row) => row.id ? [row.id] : [])])]
}

async function updateTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, rawId: string, input: z.infer<typeof updateTeamSchema>) {
  return withOrganizationMembershipUsageMutation(payload.organization.id, async (tx) => {
  let teamId: TeamId
  try {
    teamId = parseTeamId(rawId)
  } catch {
    return c.json({ error: "team_not_found" }, 404)
  }

  // Locked first: creating a team permission set locks the team row before its set, link and
  // history, so the grant check below (team-grants.ts lockTeamGrantInputs) cannot interleave with it.
  const teamRows = await tx
    .select()
    .from(TeamTable)
    .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, payload.organization.id)))
    .limit(1)
    .for("update")

  const team = teamRows[0]
  if (!team) {
    return c.json({ error: "team_not_found" }, 404)
  }
  const managedByScim = await isScimManagedTeam({ organizationId: payload.organization.id, teamId: team.id }, tx)
  if (managedByScim && (input.name !== undefined || input.memberIds !== undefined)) {
    return c.json({ error: "scim_managed_team", message: "Manage this team through the SCIM identity provider." }, 409)
  }
  const touchesAdminTeam = input.grantsOrganizationAdmin !== undefined || (team.grantsOrganizationAdmin && input.memberIds !== undefined)
  if (touchesAdminTeam) {
    const rolePermission = await requirePermission(c, "teams.manage_admin")
    if (!rolePermission.ok) return c.json(rolePermission.response, orgAccessFailureStatus(rolePermission.response), permissionFailureHeaders(rolePermission.response))
  }
  const actor = await resolveTeamActorInTransaction(tx, payload.organization.id, payload.currentMember.id)
  const notHeld = heldInTransaction(actor, touchesAdminTeam ? ["teams.manage", "teams.manage_admin"] : ["teams.manage"])
  if (notHeld) return c.json(notHeld, 403, teamGrantsFailureHeaders(notHeld))
  const nextGrantsOrganizationAdmin = input.grantsOrganizationAdmin ?? team.grantsOrganizationAdmin
  if (team.grantsOrganizationAdmin && !nextGrantsOrganizationAdmin) {
    // Turning an Admin team off takes admin status away from its members.
    const denial = decideAdminTeamChange({ actor, unmakesAdminTeam: true })
    if (denial) return c.json({ error: "forbidden" as const, ...requiresAdminError(denial.message) }, 403)
  }
  if (nextGrantsOrganizationAdmin && !team.grantsOrganizationAdmin) {
    const denied = await teamGrantsDenial(tx, payload, actor, {
      teamId: team.id,
      grantsOrganizationAdmin: true,
      adminDefaultsOnly: true,
      adminTeamChange: { makesAdminTeam: true, addsMembersToAdminTeam: false },
      message: ADMIN_TEAM_GRANTS_FORBIDDEN_MESSAGE,
    })
    if (denied) return c.json(denied, 403, teamGrantsFailureHeaders(denied))
  }

  let memberIds: MemberId[] | undefined
  if (input.memberIds) {
    try {
      memberIds = parseMemberIds(input.memberIds)
    } catch {
      return c.json({ error: "member_not_found" }, 404)
    }

    const membersBelongToOrg = await ensureMembersBelongToOrganization({
      organizationId: payload.organization.id,
      memberIds,
    }, tx)
    if (!membersBelongToOrg) {
      return c.json({ error: "member_not_found" }, 404)
    }

    const currentMemberIds = new Set((await tx
      .select({ id: TeamMemberTable.orgMembershipId })
      .from(TeamMemberTable)
      .where(eq(TeamMemberTable.teamId, team.id)))
      .map((row) => row.id))
    // Taking people out of an Admin team takes away their admin status.
    const nextMemberIds = new Set<MemberId | null>(memberIds)
    if (team.grantsOrganizationAdmin && [...currentMemberIds].some((memberId) => !nextMemberIds.has(memberId))) {
      const denial = decideAdminTeamChange({ actor, removesMembersFromAdminTeam: true })
      if (denial) return c.json({ error: "forbidden" as const, ...requiresAdminError(denial.message) }, 403)
    }
    if (memberIds.some((memberId) => !currentMemberIds.has(memberId))) {
      const denied = await teamGrantsDenial(tx, payload, actor, {
        teamId: team.id,
        grantsOrganizationAdmin: nextGrantsOrganizationAdmin,
        adminTeamChange: nextGrantsOrganizationAdmin ? { makesAdminTeam: false, addsMembersToAdminTeam: true } : null,
        message: TEAM_GRANTS_FORBIDDEN_MESSAGE,
      })
      if (denied) return c.json(denied, 403, teamGrantsFailureHeaders(denied))
    }
  }

  const nextName = input.name ?? team.name
  const duplicate = await tx
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, payload.organization.id), eq(TeamTable.name, nextName)))
    .limit(1)

  if (duplicate[0] && duplicate[0].id !== team.id) {
    return c.json({ error: "team_exists", message: "That team already exists in this organization." }, 409)
  }

  const updatedAt = new Date()
  const responseMemberIds = memberIds ?? (await tx
    .select({ id: TeamMemberTable.orgMembershipId })
    .from(TeamMemberTable)
    .where(eq(TeamMemberTable.teamId, team.id)))
    .map((row) => row.id)

    if (memberIds) await invalidateTeamInferenceOAuth(tx, team.id)
    await tx.update(TeamTable).set({ name: nextName, updatedAt, grantsOrganizationAdmin: input.grantsOrganizationAdmin }).where(eq(TeamTable.id, team.id))

    if (memberIds) {
      await tx.delete(TeamMemberTable).where(eq(TeamMemberTable.teamId, team.id))
      if (memberIds.length > 0) {
        await tx.insert(TeamMemberTable).values(
          memberIds.map((memberId) => ({
            id: createDenTypeId("teamMember"),
            teamId: team.id,
            orgMembershipId: memberId,
            createdAt: updatedAt,
          })),
        )
      }
    }

  return c.json({
    team: {
      ...team,
      name: nextName,
      updatedAt,
      memberIds: responseMemberIds,
      managedByScim,
      grantsOrganizationAdmin: input.grantsOrganizationAdmin ?? team.grantsOrganizationAdmin,
    },
  })
  }, (tx) => input.memberIds === undefined ? Promise.resolve([]) : affectedTeamUsageMembers(tx, payload.organization.id, rawId, input.memberIds))
}

async function deleteTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, rawId: string) {
  return withOrganizationMembershipUsageMutation(payload.organization.id, async (tx) => {
  let teamId: TeamId
  try {
    teamId = parseTeamId(rawId)
  } catch {
    return c.json({ error: "team_not_found" }, 404)
  }

  // Locked before the actor's permission inputs, in the same order as updateTeam.
  const teamRows = await tx
    .select()
    .from(TeamTable)
    .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, payload.organization.id)))
    .limit(1)
    .for("update")

  const team = teamRows[0]
  if (!team) {
    return c.json({ error: "team_not_found" }, 404)
  }
  if (await isScimManagedTeam({ organizationId: payload.organization.id, teamId: team.id }, tx)) {
    return c.json({ error: "scim_managed_team", message: "Disable SCIM team mapping before deleting this team." }, 409)
  }
  if (team.grantsOrganizationAdmin) {
    const rolePermission = await requirePermission(c, "teams.manage_admin")
    if (!rolePermission.ok) return c.json(rolePermission.response, orgAccessFailureStatus(rolePermission.response), permissionFailureHeaders(rolePermission.response))
  }
  const actor = await resolveTeamActorInTransaction(tx, payload.organization.id, payload.currentMember.id)
  const notHeld = heldInTransaction(actor, team.grantsOrganizationAdmin ? ["teams.manage", "teams.manage_admin"] : ["teams.manage"])
  if (notHeld) return c.json(notHeld, 403, teamGrantsFailureHeaders(notHeld))
  if (team.grantsOrganizationAdmin) {
    // Deleting an Admin team takes admin status away from its members.
    const denial = decideAdminTeamChange({ actor, deletesAdminTeam: true })
    if (denial) return c.json({ error: "forbidden" as const, ...requiresAdminError(denial.message) }, 403)
  }

    const removedAt = new Date()
    await invalidateTeamInferenceOAuth(tx, team.id)
    await tx.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.team_id, team.id))

    await tx
      .update(InvitationTable)
      .set({ teamId: null })
      .where(and(
        eq(InvitationTable.organizationId, payload.organization.id),
        eq(InvitationTable.teamId, team.id),
        eq(InvitationTable.status, "pending"),
      ))

    await tx.delete(DesktopPolicyMemberTable).where(eq(DesktopPolicyMemberTable.teamId, team.id))
    await deleteTeamAgentPermissionPolicy(tx, team.id)
    await tx.delete(ExternalMcpConnectionAccessGrantTable).where(eq(ExternalMcpConnectionAccessGrantTable.teamId, team.id))
    await tx.delete(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.teamId, team.id))
    // Usage-limit assignments have no removed_at; unassigning deletes them. This
    // runs inside the usage entitlement mutation, which re-evaluates the team's members.
    await tx.delete(GatewayUsageAssignmentTable).where(and(
      eq(GatewayUsageAssignmentTable.organizationId, payload.organization.id),
      eq(GatewayUsageAssignmentTable.teamId, team.id),
    ))

    await tx
      .update(MarketplaceAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(MarketplaceAccessGrantTable.teamId, team.id), isNull(MarketplaceAccessGrantTable.removedAt)))
    await tx
      .update(ConfigObjectAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(ConfigObjectAccessGrantTable.teamId, team.id), isNull(ConfigObjectAccessGrantTable.removedAt)))
    await tx
      .update(PluginAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(PluginAccessGrantTable.teamId, team.id), isNull(PluginAccessGrantTable.removedAt)))
    await tx
      .update(ConnectorInstanceAccessGrantTable)
      .set({ removedAt })
      .where(and(eq(ConnectorInstanceAccessGrantTable.teamId, team.id), isNull(ConnectorInstanceAccessGrantTable.removedAt)))
    await tx
      .update(DashboardAccessGrantTable)
      .set({ removedAt })
      .where(and(
        eq(DashboardAccessGrantTable.organizationId, payload.organization.id),
        eq(DashboardAccessGrantTable.teamId, team.id),
        isNull(DashboardAccessGrantTable.removedAt),
      ))

    await archiveTeamPermissionSets(tx, {
      organizationId: payload.organization.id,
      teamIds: [team.id],
      actorMemberId: payload.currentMember.id,
      at: removedAt,
    })

    await tx.delete(TeamMemberTable).where(eq(TeamMemberTable.teamId, team.id))
    await tx.delete(TeamTable).where(eq(TeamTable.id, team.id))

  return c.body(null, 204)
  }, (tx) => affectedTeamUsageMembers(tx, payload.organization.id, rawId))
}

export function registerOrgTeamRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {

  app.get(
    "/v1/teams/by-key/:externalKey",
    describeRoute({ tags: ["Teams"], summary: "Read teams by stable key", description: "Reads the team identified by the stable externalKey assigned through declarative provisioning.", responses: {
      200: jsonResponse("Resource configuration.", teamResponseSchema),
      404: jsonResponse("Resource not found.", notFoundSchema),
    } }),
    orgPermissionRoute("teams.view"),
    paramValidator(externalKeyParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const [row] = await db.select().from(TeamTable).where(and(eq(TeamTable.organizationId, payload.organization.id), eq(TeamTable.externalKey, c.req.valid("param").externalKey))).limit(1)
      if (!row) return c.json({ error: "team_not_found" }, 404)
      const memberRows = await db.select({ id: TeamMemberTable.orgMembershipId }).from(TeamMemberTable).where(eq(TeamMemberTable.teamId, row.id))
      const value = { ...row, memberIds: memberRows.flatMap((member) => member.id ? [member.id] : []), managedByScim: await isScimManagedTeam({ organizationId: payload.organization.id, teamId: row.id }) }
      if (!value) return c.json({ error: "team_not_found" }, 404)
      return c.json({ team: value })
    },
  )

  app.get(
    "/v1/teams/:teamId",
    describeRoute({ tags: ["Teams"], summary: "Read teams by id", description: "Reads a single team by id.", responses: {
      200: jsonResponse("Resource configuration.", teamResponseSchema),
      404: jsonResponse("Resource not found.", notFoundSchema),
    } }),
    orgPermissionRoute("teams.view"),
    paramValidator(orgTeamParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const [row] = await db.select().from(TeamTable).where(and(eq(TeamTable.organizationId, payload.organization.id), eq(TeamTable.id, parseTeamId(c.req.valid("param").teamId)))).limit(1)
      if (!row) return c.json({ error: "team_not_found" }, 404)
      const memberRows = await db.select({ id: TeamMemberTable.orgMembershipId }).from(TeamMemberTable).where(eq(TeamMemberTable.teamId, row.id))
      const value = { ...row, memberIds: memberRows.flatMap((member) => member.id ? [member.id] : []), managedByScim: await isScimManagedTeam({ organizationId: payload.organization.id, teamId: row.id }) }
      if (!value) return c.json({ error: "team_not_found" }, 404)
      return c.json({ team: value })
    },
  )

  app.put(
    "/v1/teams/by-key/:externalKey",
    describeRoute({
      tags: ["Teams"],
      summary: "Apply teams by stable key",
      description: "Creates or replaces an organization-scoped resource. Names do not identify resources; existing unkeyed resources are never adopted automatically. Assignments are replaced. Omitted write-only secrets are preserved. Concurrent writes are last-write-wins; conditional headers are not supported on this route.",
      responses: declarativeResponses(teamResponseSchema),
    }),
    orgPermissionRoute("teams.manage"),
    paramValidator(externalKeyParamsSchema),
    jsonValidator(createTeamSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (c.req.header("If-Match") || c.req.header("If-None-Match")) {
        return c.json({ error: "unsupported_precondition", message: "This endpoint uses last-write-wins. Serialize configuration writers." }, 400)
      }
      const { externalKey } = c.req.valid("param")
      const input = c.req.valid("json")
      const [existing] = await db.select().from(TeamTable).where(and(
        eq(TeamTable.organizationId, payload.organization.id),
        eq(TeamTable.externalKey, externalKey),
      )).limit(1)
      try {
        if (existing) return await updateTeam(c, payload, existing.id, input)
        return await createTeam(c, payload, input, externalKey)
      } catch (error) {
        if (!isDuplicateEntry(error)) throw error
        // A concurrent creator can win between lookup and insert. Retry against
        // its identity instead of creating a second resource.
        const [winner] = await db.select().from(TeamTable).where(and(
        eq(TeamTable.organizationId, payload.organization.id),
        eq(TeamTable.externalKey, externalKey),
      )).limit(1)
        if (winner) return updateTeam(c, payload, winner.id, input)
        return c.json({ error: "resource_conflict", message: "The resource name is already in use by another identity." }, 409)
      }
    },
  )

  app.delete(
    "/v1/teams/by-key/:externalKey",
    describeRoute({
      tags: ["Teams"],
      summary: "Delete teams by stable key",
      description: "Deletes the team identified by its stable externalKey. Idempotent: deleting a key that does not exist is reported as already removed.",
      responses: { 200: jsonResponse("Idempotent deletion result.", declarativeDeleteSchema) },
    }),
    orgPermissionRoute("teams.manage"),
    paramValidator(externalKeyParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const { externalKey } = c.req.valid("param")
      const [existing] = await db.select().from(TeamTable).where(and(
        eq(TeamTable.organizationId, payload.organization.id),
        eq(TeamTable.externalKey, externalKey),
      )).limit(1)
      if (!existing) return c.json({ ok: true, deleted: false })
      const result = await deleteTeam(c, payload, existing.id)
      if (result.status !== 204) return result
      return c.json({ ok: true, deleted: true })
    },
  )
  app.post(
    "/v1/teams",
    describeRoute({
      tags: ["Teams"],
      summary: "Create team",
      description: "Creates a team inside an organization and can optionally attach existing organization members to it.",
      responses: {
        201: jsonResponse("Team created successfully.", teamResponseSchema),
        400: jsonResponse("The team creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create teams.", unauthorizedSchema),
        403: jsonResponse("The caller needs the Manage teams permission and a recent sign-in; making an Admin team also needs Manage Admin teams, and with Permissions on only the owner or an admin can make one.", forbiddenSchema),
        404: jsonResponse("The organization or a referenced member could not be found.", notFoundSchema),
      },
    }),
    orgPermissionRoute("teams.manage"),
    jsonValidator(createTeamSchema),
    async (c) => createTeam(c, c.get("organizationContext"), c.req.valid("json")),
  )

  app.patch(
    "/v1/teams/:teamId",
    describeRoute({
      tags: ["Teams"],
      summary: "Update team",
      description: "Updates a team's name and-or membership list within an organization.",
      responses: {
        200: jsonResponse("Team updated successfully.", teamResponseSchema),
        400: jsonResponse("The team update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update teams.", unauthorizedSchema),
        403: jsonResponse("The caller needs the Manage teams permission and a recent sign-in. Admin teams also need Manage Admin teams, and with Permissions on, adding people needs every permission the team grants, and only the owner or an admin can make a team an Admin team, turn one off, or add people to or remove people from one.", forbiddenSchema),
        404: jsonResponse("The team, organization, or a referenced member could not be found.", notFoundSchema),
      },
    }),
    orgPermissionRoute("teams.manage"),
    paramValidator(orgTeamParamsSchema),
    jsonValidator(updateTeamSchema),
    async (c) => updateTeam(c, c.get("organizationContext"), c.req.valid("param").teamId, c.req.valid("json")),
  )

  app.delete(
    "/v1/teams/:teamId",
    describeRoute({
      tags: ["Teams"],
      summary: "Delete team",
      description: "Deletes a team and removes its related team-membership records.",
      responses: {
        204: emptyResponse("Team deleted successfully."),
        400: jsonResponse("The team deletion path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete teams.", unauthorizedSchema),
        403: jsonResponse("The caller needs the Manage teams permission and a recent sign-in; deleting an Admin team also needs Manage Admin teams, and with Permissions on only the owner or an admin can delete one.", forbiddenSchema),
        404: jsonResponse("The team or organization could not be found.", notFoundSchema),
      },
    }),
    orgPermissionRoute("teams.manage"),
    paramValidator(orgTeamParamsSchema),
    async (c) => deleteTeam(c, c.get("organizationContext"), c.req.valid("param").teamId),
  )
}
