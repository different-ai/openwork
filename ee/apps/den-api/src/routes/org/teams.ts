import { declarativeDeleteSchema, declarativeResponses, externalKeyParamsSchema, isDuplicateEntry, type ResourceActionContext, type ResourceOrganizationContext } from "./declarative.js"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectAccessGrantTable,
  ConnectorInstanceAccessGrantTable,
  DesktopPolicyMemberTable,
  ExternalMcpConnectionAccessGrantTable,
  InvitationTable,
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
import { db } from "../../db.js"
import { isScimManagedTeam } from "../../scim-groups.js"
import {
  jsonValidator,
  orgRoleRoute,
  paramValidator,
} from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import {
  ensureTeamManager,
  idParamSchema,
  orgAccessFailureStatus,
} from "./shared.js"

const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(255),
  memberIds: z.array(denTypeIdSchema("member")).optional().default([]),
})

const updateTeamSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  memberIds: z.array(denTypeIdSchema("member")).optional(),
}).superRefine((value, ctx) => {
  if (value.name === undefined && value.memberIds === undefined) {
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
}) {
  if (input.memberIds.length === 0) {
    return true
  }

  const rows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))

  const memberIds = new Set(rows.map((row) => row.id))
  return input.memberIds.every((memberId) => memberIds.has(memberId))
}

async function createTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, input: z.infer<typeof createTeamSchema>, externalKey?: string) {
  const permission = ensureTeamManager(c)
  if (!permission.ok) {
    return c.json(permission.response, orgAccessFailureStatus(permission.response))
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
  })
  if (!membersBelongToOrg) {
    return c.json({ error: "member_not_found" }, 404)
  }

  const existingTeam = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, payload.organization.id), eq(TeamTable.name, input.name)))
    .limit(1)

  if (existingTeam[0]) {
    return c.json({ error: "team_exists", message: "That team already exists in this organization." }, 409)
  }

  const teamId = createDenTypeId("team")
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx.insert(TeamTable).values({
      externalKey,
      id: teamId,
      name: input.name,
      organizationId: payload.organization.id,
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
  })

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
    },
  }, 201)
}

async function updateTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, rawId: string, input: z.infer<typeof updateTeamSchema>) {
  const permission = ensureTeamManager(c)
  if (!permission.ok) {
    return c.json(permission.response, orgAccessFailureStatus(permission.response))
  }

  let teamId: TeamId
  try {
    teamId = parseTeamId(rawId)
  } catch {
    return c.json({ error: "team_not_found" }, 404)
  }

  const teamRows = await db
    .select()
    .from(TeamTable)
    .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, payload.organization.id)))
    .limit(1)

  const team = teamRows[0]
  if (!team) {
    return c.json({ error: "team_not_found" }, 404)
  }
  if (await isScimManagedTeam({ organizationId: payload.organization.id, teamId: team.id })) {
    return c.json({ error: "scim_managed_team", message: "Manage this team through the SCIM identity provider." }, 409)
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
    })
    if (!membersBelongToOrg) {
      return c.json({ error: "member_not_found" }, 404)
    }
  }

  const nextName = input.name ?? team.name
  const duplicate = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, payload.organization.id), eq(TeamTable.name, nextName)))
    .limit(1)

  if (duplicate[0] && duplicate[0].id !== team.id) {
    return c.json({ error: "team_exists", message: "That team already exists in this organization." }, 409)
  }

  const updatedAt = new Date()
  const responseMemberIds = memberIds ?? (await db
    .select({ id: TeamMemberTable.orgMembershipId })
    .from(TeamMemberTable)
    .where(eq(TeamMemberTable.teamId, team.id)))
    .map((row) => row.id)

  await db.transaction(async (tx) => {
    await tx.update(TeamTable).set({ name: nextName, updatedAt }).where(eq(TeamTable.id, team.id))

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
  })

  return c.json({
    team: {
      ...team,
      name: nextName,
      updatedAt,
      memberIds: responseMemberIds,
      managedByScim: false,
    },
  })
}

async function deleteTeam(c: ResourceActionContext, payload: ResourceOrganizationContext, rawId: string) {
  const permission = ensureTeamManager(c)
  if (!permission.ok) {
    return c.json(permission.response, orgAccessFailureStatus(permission.response))
  }

  let teamId: TeamId
  try {
    teamId = parseTeamId(rawId)
  } catch {
    return c.json({ error: "team_not_found" }, 404)
  }

  const teamRows = await db
    .select()
    .from(TeamTable)
    .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, payload.organization.id)))
    .limit(1)

  const team = teamRows[0]
  if (!team) {
    return c.json({ error: "team_not_found" }, 404)
  }
  if (await isScimManagedTeam({ organizationId: payload.organization.id, teamId: team.id })) {
    return c.json({ error: "scim_managed_team", message: "Disable SCIM team mapping before deleting this team." }, 409)
  }

  await db.transaction(async (tx) => {
    const removedAt = new Date()

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

    await tx.delete(TeamMemberTable).where(eq(TeamMemberTable.teamId, team.id))
    await tx.delete(TeamTable).where(eq(TeamTable.id, team.id))
  })

  return c.body(null, 204)
}

export function registerOrgTeamRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {

  app.get(
    "/v1/teams/by-key/:externalKey",
    describeRoute({ tags: ["Teams"], summary: "Read teams by stable key", description: "Reads the team identified by the stable externalKey assigned through declarative provisioning.", responses: {
      200: jsonResponse("Resource configuration.", teamResponseSchema),
      404: jsonResponse("Resource not found.", notFoundSchema),
    } }),
    orgRoleRoute(["admin"]),
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
    orgRoleRoute(["admin"]),
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
    orgRoleRoute(["admin"]),
    paramValidator(externalKeyParamsSchema),
    jsonValidator(createTeamSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureTeamManager(c)
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
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
    orgRoleRoute(["admin"]),
    paramValidator(externalKeyParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureTeamManager(c)
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
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
        403: jsonResponse("Only workspace owners and admins can create teams.", forbiddenSchema),
        404: jsonResponse("The organization or a referenced member could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
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
        403: jsonResponse("Only workspace owners and admins can update teams.", forbiddenSchema),
        404: jsonResponse("The team, organization, or a referenced member could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
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
        403: jsonResponse("Only workspace owners and admins can delete teams.", forbiddenSchema),
        404: jsonResponse("The team or organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(orgTeamParamsSchema),
    async (c) => deleteTeam(c, c.get("organizationContext"), c.req.valid("param").teamId),
  )
}
