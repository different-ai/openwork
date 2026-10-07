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
  PermissionSetTable,
  PermissionSetTeamTable,
  PluginAccessGrantTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PermissionKey } from "@openwork/types/den/permissions"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
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
  adminDefaultPermissionKeys,
  firstMissingPermission,
  teamGrantedPermissionKeys,
  teamGrantsForbiddenResponse,
  TEAM_GRANTS_FORBIDDEN_MESSAGE,
} from "../../permissions/team-grants.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import {
  idParamSchema,
  memberPermissionsForRequest,
  orgAccessFailureStatus,
  permissionFailureHeaders,
  requirePermission,
  type PermissionCheckResult,
  type PermissionRouteContext,
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

/**
 * Safety rule 9.3 (docs/permissions/overview.md): with the Permissions feature
 * on, the caller must already hold every key the team would grant. The owner
 * bypasses it. SCIM writes team membership through scim-groups.ts, not these
 * routes, so identity-provider membership is exempt.
 */
async function checkHoldsTeamGrants(
  c: PermissionRouteContext,
  grantedKeys: () => Promise<Iterable<PermissionKey>>,
  message: string,
): Promise<PermissionCheckResult> {
  const held = await memberPermissionsForRequest(c)
  if (!held) return { ok: false, response: { error: "organization_not_found" } }
  if (!held.featureEnabled || held.isOwner) return { ok: true }
  const missing = firstMissingPermission(held, await grantedKeys())
  return missing ? { ok: false, response: teamGrantsForbiddenResponse(missing, message) } : { ok: true }
}

async function createTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, input: z.infer<typeof createTeamSchema>, externalKey?: string) {
  return withOrganizationTeamMutation(payload.organization.id, async (tx) => {
  if (input.grantsOrganizationAdmin !== undefined) {
    const rolePermission = await requirePermission(c, "teams.manage_admin")
    if (!rolePermission.ok) return c.json(rolePermission.response, orgAccessFailureStatus(rolePermission.response), permissionFailureHeaders(rolePermission.response))
  }
  if (input.grantsOrganizationAdmin === true) {
    // A new team has no team permission set yet, so it grants only the Admin defaults.
    const grants = await checkHoldsTeamGrants(c, () => adminDefaultPermissionKeys(payload.organization.id, tx), ADMIN_TEAM_GRANTS_FORBIDDEN_MESSAGE)
    if (!grants.ok) return c.json(grants.response, orgAccessFailureStatus(grants.response), permissionFailureHeaders(grants.response))
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

  const teamRows = await tx
    .select()
    .from(TeamTable)
    .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, payload.organization.id)))
    .limit(1)

  const team = teamRows[0]
  if (!team) {
    return c.json({ error: "team_not_found" }, 404)
  }
  const managedByScim = await isScimManagedTeam({ organizationId: payload.organization.id, teamId: team.id }, tx)
  if (managedByScim && (input.name !== undefined || input.memberIds !== undefined)) {
    return c.json({ error: "scim_managed_team", message: "Manage this team through the SCIM identity provider." }, 409)
  }
  if (input.grantsOrganizationAdmin !== undefined || (team.grantsOrganizationAdmin && input.memberIds !== undefined)) {
    const rolePermission = await requirePermission(c, "teams.manage_admin")
    if (!rolePermission.ok) return c.json(rolePermission.response, orgAccessFailureStatus(rolePermission.response), permissionFailureHeaders(rolePermission.response))
  }
  const nextGrantsOrganizationAdmin = input.grantsOrganizationAdmin ?? team.grantsOrganizationAdmin
  if (nextGrantsOrganizationAdmin && !team.grantsOrganizationAdmin) {
    const grants = await checkHoldsTeamGrants(c, () => adminDefaultPermissionKeys(payload.organization.id, tx), ADMIN_TEAM_GRANTS_FORBIDDEN_MESSAGE)
    if (!grants.ok) return c.json(grants.response, orgAccessFailureStatus(grants.response), permissionFailureHeaders(grants.response))
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
    if (memberIds.some((memberId) => !currentMemberIds.has(memberId))) {
      const grants = await checkHoldsTeamGrants(c, () => teamGrantedPermissionKeys({
        organizationId: payload.organization.id,
        teamId: team.id,
        grantsOrganizationAdmin: nextGrantsOrganizationAdmin,
        database: tx,
      }), TEAM_GRANTS_FORBIDDEN_MESSAGE)
      if (!grants.ok) return c.json(grants.response, orgAccessFailureStatus(grants.response), permissionFailureHeaders(grants.response))
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

/**
 * Team delete cascade for permissions (overview section 10): soft-removes the
 * team's active permission set links and archives each linked team set that
 * no other team still uses. Default sets are never archived. Nothing is deleted.
 */
async function archiveTeamPermissionSets(tx: TeamMutationTransaction, input: {
  organizationId: typeof TeamTable.$inferSelect.organizationId
  teamId: TeamId
  actorMemberId: MemberId
  at: Date
}) {
  const links = await tx
    .select({ id: PermissionSetTeamTable.id, permissionSetId: PermissionSetTeamTable.permissionSetId })
    .from(PermissionSetTeamTable)
    .where(and(
      eq(PermissionSetTeamTable.organizationId, input.organizationId),
      eq(PermissionSetTeamTable.teamId, input.teamId),
      isNull(PermissionSetTeamTable.removedAt),
    ))
    .for("update")
  if (links.length === 0) return

  await tx
    .update(PermissionSetTeamTable)
    .set({ removedAt: input.at, removedByOrgMembershipId: input.actorMemberId })
    .where(inArray(PermissionSetTeamTable.id, links.map((link) => link.id)))

  const setIds = [...new Set(links.map((link) => link.permissionSetId))]
  const stillLinked = new Set((await tx
    .select({ permissionSetId: PermissionSetTeamTable.permissionSetId })
    .from(PermissionSetTeamTable)
    .where(and(
      eq(PermissionSetTeamTable.organizationId, input.organizationId),
      inArray(PermissionSetTeamTable.permissionSetId, setIds),
      isNull(PermissionSetTeamTable.removedAt),
    )))
    .map((row) => row.permissionSetId))
  const archiveIds = setIds.filter((setId) => !stillLinked.has(setId))
  if (archiveIds.length === 0) return

  await tx
    .update(PermissionSetTable)
    .set({ archivedAt: input.at, archivedByOrgMembershipId: input.actorMemberId })
    .where(and(
      eq(PermissionSetTable.organizationId, input.organizationId),
      inArray(PermissionSetTable.id, archiveIds),
      isNull(PermissionSetTable.defaultKey),
      isNull(PermissionSetTable.archivedAt),
    ))
}

async function deleteTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, rawId: string) {
  return withOrganizationMembershipUsageMutation(payload.organization.id, async (tx) => {
  let teamId: TeamId
  try {
    teamId = parseTeamId(rawId)
  } catch {
    return c.json({ error: "team_not_found" }, 404)
  }

  const teamRows = await tx
    .select()
    .from(TeamTable)
    .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, payload.organization.id)))
    .limit(1)

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
      teamId: team.id,
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
        403: jsonResponse("The caller needs the Manage teams permission and a recent sign-in; making an Admin team also needs Manage Admin teams.", forbiddenSchema),
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
        403: jsonResponse("The caller needs the Manage teams permission and a recent sign-in. Admin teams also need Manage Admin teams, and with Permissions on, adding people needs every permission the team grants.", forbiddenSchema),
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
        403: jsonResponse("The caller needs the Manage teams permission and a recent sign-in; deleting an Admin team also needs Manage Admin teams.", forbiddenSchema),
        404: jsonResponse("The team or organization could not be found.", notFoundSchema),
      },
    }),
    orgPermissionRoute("teams.manage"),
    paramValidator(orgTeamParamsSchema),
    async (c) => deleteTeam(c, c.get("organizationContext"), c.req.valid("param").teamId),
  )
}
