import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  MemberTable,
  SkillHubMemberTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import {
  jsonValidator,
  paramValidator,
  requireUserMiddleware,
  resolveOrganizationContextMiddleware,
} from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import {
  ensureTeamManager,
  idParamSchema,
  orgIdParamSchema,
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

const orgTeamParamsSchema = orgIdParamSchema.extend(idParamSchema("teamId", "team").shape)

const teamResponseSchema = z.object({
  team: z.object({
    id: denTypeIdSchema("team"),
    organizationId: denTypeIdSchema("organization"),
    name: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    memberIds: z.array(denTypeIdSchema("member")),
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
    .where(eq(MemberTable.organizationId, input.organizationId))

  const memberIds = new Set(rows.map((row) => row.id))
  return input.memberIds.every((memberId) => memberIds.has(memberId))
}

export function registerOrgTeamRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:orgId/teams",
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
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(createTeamSchema),
    async (c) => {
      const permission = ensureTeamManager(c)
      if (!permission.ok) {
        return c.json(permission.response, 403)
      }

      const payload = c.get("organizationContext")
      const input = c.req.valid("json")

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
          organizationId: payload.organization.id,
          name: input.name,
          createdAt: now,
          updatedAt: now,
          memberIds,
        },
      }, 201)
    },
  )

  app.patch(
    "/v1/orgs/:orgId/teams/:teamId",
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
    requireUserMiddleware,
    paramValidator(orgTeamParamsSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(updateTeamSchema),
    async (c) => {
      const permission = ensureTeamManager(c)
      if (!permission.ok) {
        return c.json(permission.response, 403)
      }

      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const input = c.req.valid("json")

      let teamId: TeamId
      try {
        teamId = parseTeamId(params.teamId)
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
          memberIds: memberIds ?? [],
        },
      })
    },
  )

  app.delete(
    "/v1/orgs/:orgId/teams/:teamId",
    describeRoute({
      tags: ["Teams"],
      summary: "Delete team",
      description: "Deletes a team and removes its related hub-access and team-membership records.",
      responses: {
        204: emptyResponse("Team deleted successfully."),
        400: jsonResponse("The team deletion path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete teams.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can delete teams.", forbiddenSchema),
        404: jsonResponse("The team or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgTeamParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const permission = ensureTeamManager(c)
      if (!permission.ok) {
        return c.json(permission.response, 403)
      }

      const payload = c.get("organizationContext")
      const params = c.req.valid("param")

      let teamId: TeamId
      try {
        teamId = parseTeamId(params.teamId)
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

      await db.transaction(async (tx) => {
        await tx.delete(SkillHubMemberTable).where(eq(SkillHubMemberTable.teamId, team.id))
        await tx.delete(TeamMemberTable).where(eq(TeamMemberTable.teamId, team.id))
        await tx.delete(TeamTable).where(eq(TeamTable.id, team.id))
      })

      return c.body(null, 204)
    },
  )
}
