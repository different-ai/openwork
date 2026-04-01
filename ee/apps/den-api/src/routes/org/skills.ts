import { and, desc, eq, inArray, isNotNull, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  MemberTable,
  SkillHubMemberTable,
  SkillHubSkillTable,
  SkillHubTable,
  SkillTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { z } from "zod"
import { db } from "../../db.js"
import {
  jsonValidator,
  paramValidator,
  requireUserMiddleware,
  resolveMemberTeamsMiddleware,
  resolveOrganizationContextMiddleware,
} from "../../middleware/index.js"
import type { MemberTeamsContext } from "../../middleware/member-teams.js"
import type { OrgRouteVariables } from "./shared.js"
import { idParamSchema, memberHasRole, orgIdParamSchema } from "./shared.js"

const createSkillSchema = z.object({
  skillText: z.string().trim().min(1),
  shared: z.enum(["org", "public"]).nullable().optional(),
})

const createSkillHubSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(65535).nullish().transform((value) => value || null),
})

const updateSkillHubSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(65535).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.name === undefined && value.description === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["name"],
      message: "Provide at least one field to update.",
    })
  }
})

const addSkillToHubSchema = z.object({
  skillId: z.string().trim().min(1),
})

const addSkillHubAccessSchema = z.object({
  orgMembershipId: z.string().trim().min(1).optional(),
  teamId: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  const count = Number(Boolean(value.orgMembershipId)) + Number(Boolean(value.teamId))
  if (count !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["orgMembershipId"],
      message: "Provide exactly one of orgMembershipId or teamId.",
    })
  }
})

type SkillId = typeof SkillTable.$inferSelect.id
type SkillHubId = typeof SkillHubTable.$inferSelect.id
type SkillHubMemberId = typeof SkillHubMemberTable.$inferSelect.id
type TeamId = typeof TeamTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type SkillRow = typeof SkillTable.$inferSelect
type SkillHubRow = typeof SkillHubTable.$inferSelect

const orgSkillHubParamsSchema = orgIdParamSchema.extend(idParamSchema("skillHubId").shape)
const orgSkillParamsSchema = orgIdParamSchema.extend(idParamSchema("skillId").shape)
const orgSkillHubSkillParamsSchema = orgSkillHubParamsSchema.extend(idParamSchema("skillId").shape)
const orgSkillHubAccessParamsSchema = orgSkillHubParamsSchema.extend(idParamSchema("accessId").shape)

function parseSkillId(value: string) {
  return normalizeDenTypeId("skill", value)
}

function parseSkillHubId(value: string) {
  return normalizeDenTypeId("skillHub", value)
}

function parseSkillHubMemberId(value: string) {
  return normalizeDenTypeId("skillHubMember", value)
}

function parseMemberId(value: string) {
  return normalizeDenTypeId("member", value)
}

function parseTeamId(value: string) {
  return normalizeDenTypeId("team", value)
}

function parseSkillMetadata(skillText: string) {
  const lines = skillText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)

  const cleanup = (value: string) => value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^description\s*:\s*/i, "")
    .trim()

  const title = cleanup(lines[0] ?? "") || "Untitled skill"
  const description = lines.slice(1).map(cleanup).find(Boolean) ?? null

  return {
    title: title.slice(0, 255),
    description: description ? description.slice(0, 65535) : null,
  }
}

function isOrganizationAdmin(payload: { currentMember: { isOwner: boolean; role: string } }) {
  return payload.currentMember.isOwner || memberHasRole(payload.currentMember.role, "admin")
}

function canManageSkill(payload: { currentMember: { id: MemberId; isOwner: boolean; role: string } }, skill: SkillRow) {
  return isOrganizationAdmin(payload) || skill.createdByOrgMembershipId === payload.currentMember.id
}

function canManageHub(payload: { currentMember: { id: MemberId; isOwner: boolean; role: string } }, skillHub: SkillHubRow) {
  return isOrganizationAdmin(payload) || skillHub.createdByOrgMembershipId === payload.currentMember.id
}

async function listAccessibleHubMemberships(input: {
  organizationId: typeof SkillHubTable.$inferSelect.organizationId
  currentMemberId: MemberId
  memberTeams: Array<{ id: TeamId }>
}) {
  const teamIds = input.memberTeams.map((team) => team.id)
  const accessWhere = teamIds.length > 0
    ? and(
        eq(SkillHubTable.organizationId, input.organizationId),
        or(
          eq(SkillHubMemberTable.orgMembershipId, input.currentMemberId),
          inArray(SkillHubMemberTable.teamId, teamIds),
        ),
      )
    : and(
        eq(SkillHubTable.organizationId, input.organizationId),
        eq(SkillHubMemberTable.orgMembershipId, input.currentMemberId),
      )

  return db
    .select({
      id: SkillHubMemberTable.id,
      skillHubId: SkillHubMemberTable.skillHubId,
      orgMembershipId: SkillHubMemberTable.orgMembershipId,
      teamId: SkillHubMemberTable.teamId,
      createdAt: SkillHubMemberTable.createdAt,
    })
    .from(SkillHubMemberTable)
    .innerJoin(SkillHubTable, eq(SkillHubMemberTable.skillHubId, SkillHubTable.id))
    .where(accessWhere)
}

async function listAccessibleSkillIds(input: {
  organizationId: typeof SkillHubTable.$inferSelect.organizationId
  currentMemberId: MemberId
  memberTeams: Array<{ id: TeamId }>
}) {
  const memberships = await listAccessibleHubMemberships(input)
  const hubIds = [...new Set(memberships.map((membership) => membership.skillHubId))]
  if (hubIds.length === 0) {
    return new Set<SkillId>()
  }

  const rows = await db
    .select({ skillId: SkillHubSkillTable.skillId })
    .from(SkillHubSkillTable)
    .where(inArray(SkillHubSkillTable.skillHubId, hubIds))

  return new Set(rows.map((row) => row.skillId))
}

function canViewSkill(input: {
  currentMemberId: MemberId
  skill: SkillRow
  accessibleSkillIds: Set<SkillId>
}) {
  return input.skill.createdByOrgMembershipId === input.currentMemberId
    || input.skill.shared !== null
    || input.accessibleSkillIds.has(input.skill.id)
}

export function registerOrgSkillRoutes<T extends { Variables: OrgRouteVariables & Partial<MemberTeamsContext> }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:orgId/skills",
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(createSkillSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const now = new Date()
      const skillId = createDenTypeId("skill")
      const metadata = parseSkillMetadata(input.skillText)

      await db.insert(SkillTable).values({
        id: skillId,
        organizationId: payload.organization.id,
        createdByOrgMembershipId: payload.currentMember.id,
        title: metadata.title,
        description: metadata.description,
        skillText: input.skillText,
        shared: input.shared ?? null,
        createdAt: now,
        updatedAt: now,
      })

      return c.json({
        skill: {
          id: skillId,
          organizationId: payload.organization.id,
          createdByOrgMembershipId: payload.currentMember.id,
          title: metadata.title,
          description: metadata.description,
          skillText: input.skillText,
          shared: input.shared ?? null,
          createdAt: now,
          updatedAt: now,
        },
      }, 201)
    },
  )

  app.get(
    "/v1/orgs/:orgId/skills",
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const memberTeams = c.get("memberTeams") ?? []
      const accessibleSkillIds = await listAccessibleSkillIds({
        organizationId: payload.organization.id,
        currentMemberId: payload.currentMember.id,
        memberTeams,
      })

      const skills = await db
        .select()
        .from(SkillTable)
        .where(eq(SkillTable.organizationId, payload.organization.id))
        .orderBy(desc(SkillTable.updatedAt))

      return c.json({
        skills: skills
          .filter((skill) => canViewSkill({
            currentMemberId: payload.currentMember.id,
            skill,
            accessibleSkillIds,
          }))
          .map((skill) => ({
            ...skill,
            canManage: canManageSkill(payload, skill),
          })),
      })
    },
  )

  app.delete(
    "/v1/orgs/:orgId/skills/:skillId",
    requireUserMiddleware,
    paramValidator(orgSkillParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")

      let skillId: SkillId
      try {
        skillId = parseSkillId(params.skillId)
      } catch {
        return c.json({ error: "skill_not_found" }, 404)
      }

      const skillRows = await db
        .select()
        .from(SkillTable)
        .where(and(eq(SkillTable.id, skillId), eq(SkillTable.organizationId, payload.organization.id)))
        .limit(1)

      const skill = skillRows[0]
      if (!skill) {
        return c.json({ error: "skill_not_found" }, 404)
      }

      if (!canManageSkill(payload, skill)) {
        return c.json({ error: "forbidden", message: "Only the skill creator or an org admin can delete skills." }, 403)
      }

      await db.transaction(async (tx) => {
        await tx.delete(SkillHubSkillTable).where(eq(SkillHubSkillTable.skillId, skill.id))
        await tx.delete(SkillTable).where(eq(SkillTable.id, skill.id))
      })

      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/orgs/:orgId/skill-hubs",
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(createSkillHubSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const input = c.req.valid("json")
      const now = new Date()
      const skillHubId = createDenTypeId("skillHub")

      await db.transaction(async (tx) => {
        await tx.insert(SkillHubTable).values({
          id: skillHubId,
          organizationId: payload.organization.id,
          createdByOrgMembershipId: payload.currentMember.id,
          name: input.name,
          description: input.description,
          createdAt: now,
          updatedAt: now,
        })

        await tx.insert(SkillHubMemberTable).values({
          id: createDenTypeId("skillHubMember"),
          skillHubId,
          orgMembershipId: payload.currentMember.id,
          teamId: null,
          createdAt: now,
        })
      })

      return c.json({
        skillHub: {
          id: skillHubId,
          organizationId: payload.organization.id,
          createdByOrgMembershipId: payload.currentMember.id,
          name: input.name,
          description: input.description,
          createdAt: now,
          updatedAt: now,
        },
      }, 201)
    },
  )

  app.get(
    "/v1/orgs/:orgId/skill-hubs",
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    resolveMemberTeamsMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const memberTeams = c.get("memberTeams") ?? []
      const accessibleMemberships = await listAccessibleHubMemberships({
        organizationId: payload.organization.id,
        currentMemberId: payload.currentMember.id,
        memberTeams,
      })
      const skillHubIds = [...new Set(accessibleMemberships.map((membership) => membership.skillHubId))]

      if (skillHubIds.length === 0) {
        return c.json({ skillHubs: [] })
      }

      const skillHubs = await db
        .select()
        .from(SkillHubTable)
        .where(and(eq(SkillHubTable.organizationId, payload.organization.id), inArray(SkillHubTable.id, skillHubIds)))
        .orderBy(desc(SkillHubTable.updatedAt))

      const skillLinks = await db
        .select({ skillHubId: SkillHubSkillTable.skillHubId, skillId: SkillHubSkillTable.skillId })
        .from(SkillHubSkillTable)
        .where(inArray(SkillHubSkillTable.skillHubId, skillHubIds))

      const skillIds = [...new Set(skillLinks.map((link) => link.skillId))]
      const skills = skillIds.length === 0
        ? []
        : await db
          .select()
          .from(SkillTable)
          .where(and(eq(SkillTable.organizationId, payload.organization.id), inArray(SkillTable.id, skillIds)))

      const memberAccessRows = await db
        .select({
          access: {
            id: SkillHubMemberTable.id,
            skillHubId: SkillHubMemberTable.skillHubId,
            createdAt: SkillHubMemberTable.createdAt,
          },
          member: {
            id: MemberTable.id,
            role: MemberTable.role,
          },
          user: {
            id: AuthUserTable.id,
            name: AuthUserTable.name,
            email: AuthUserTable.email,
            image: AuthUserTable.image,
          },
        })
        .from(SkillHubMemberTable)
        .innerJoin(MemberTable, eq(SkillHubMemberTable.orgMembershipId, MemberTable.id))
        .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
        .where(and(inArray(SkillHubMemberTable.skillHubId, skillHubIds), isNotNull(SkillHubMemberTable.orgMembershipId)))

      const teamAccessRows = await db
        .select({
          access: {
            id: SkillHubMemberTable.id,
            skillHubId: SkillHubMemberTable.skillHubId,
            createdAt: SkillHubMemberTable.createdAt,
          },
          team: {
            id: TeamTable.id,
            name: TeamTable.name,
            createdAt: TeamTable.createdAt,
            updatedAt: TeamTable.updatedAt,
          },
        })
        .from(SkillHubMemberTable)
        .innerJoin(TeamTable, eq(SkillHubMemberTable.teamId, TeamTable.id))
        .where(and(inArray(SkillHubMemberTable.skillHubId, skillHubIds), isNotNull(SkillHubMemberTable.teamId)))

      const skillsById = new Map(skills.map((skill) => [skill.id, skill]))
      const skillsByHubId = new Map<SkillHubId, SkillRow[]>()
      for (const link of skillLinks) {
        const skill = skillsById.get(link.skillId)
        if (!skill) {
          continue
        }

        const existing = skillsByHubId.get(link.skillHubId) ?? []
        existing.push(skill)
        skillsByHubId.set(link.skillHubId, existing)
      }

      const memberAccessByHubId = new Map<SkillHubId, typeof memberAccessRows>()
      for (const row of memberAccessRows) {
        const existing = memberAccessByHubId.get(row.access.skillHubId) ?? []
        existing.push(row)
        memberAccessByHubId.set(row.access.skillHubId, existing)
      }

      const teamAccessByHubId = new Map<SkillHubId, typeof teamAccessRows>()
      for (const row of teamAccessRows) {
        const existing = teamAccessByHubId.get(row.access.skillHubId) ?? []
        existing.push(row)
        teamAccessByHubId.set(row.access.skillHubId, existing)
      }

      const accessibleViaByHubId = new Map<SkillHubId, { orgMembershipIds: MemberId[]; teamIds: TeamId[] }>()
      for (const row of accessibleMemberships) {
        const existing = accessibleViaByHubId.get(row.skillHubId) ?? { orgMembershipIds: [], teamIds: [] }
        if (row.orgMembershipId && !existing.orgMembershipIds.includes(row.orgMembershipId)) {
          existing.orgMembershipIds.push(row.orgMembershipId)
        }
        if (row.teamId && !existing.teamIds.includes(row.teamId)) {
          existing.teamIds.push(row.teamId)
        }
        accessibleViaByHubId.set(row.skillHubId, existing)
      }

      return c.json({
        skillHubs: skillHubs.map((skillHub) => ({
          ...skillHub,
          canManage: canManageHub(payload, skillHub),
          accessibleVia: accessibleViaByHubId.get(skillHub.id) ?? { orgMembershipIds: [], teamIds: [] },
          skills: skillsByHubId.get(skillHub.id) ?? [],
          access: {
            members: (memberAccessByHubId.get(skillHub.id) ?? []).map((row) => ({
              id: row.access.id,
              orgMembershipId: row.member.id,
              role: row.member.role,
              user: row.user,
              createdAt: row.access.createdAt,
            })),
            teams: (teamAccessByHubId.get(skillHub.id) ?? []).map((row) => ({
              id: row.access.id,
              teamId: row.team.id,
              name: row.team.name,
              createdAt: row.team.createdAt,
              updatedAt: row.team.updatedAt,
            })),
          },
        })),
      })
    },
  )

  app.patch(
    "/v1/orgs/:orgId/skill-hubs/:skillHubId",
    requireUserMiddleware,
    paramValidator(orgSkillHubParamsSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(updateSkillHubSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const input = c.req.valid("json")

      let skillHubId: SkillHubId
      try {
        skillHubId = parseSkillHubId(params.skillHubId)
      } catch {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      const skillHubRows = await db
        .select()
        .from(SkillHubTable)
        .where(and(eq(SkillHubTable.id, skillHubId), eq(SkillHubTable.organizationId, payload.organization.id)))
        .limit(1)

      const skillHub = skillHubRows[0]
      if (!skillHub) {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      if (!canManageHub(payload, skillHub)) {
        return c.json({ error: "forbidden", message: "Only the hub creator or an org admin can update hubs." }, 403)
      }

      const updatedAt = new Date()
      const nextName = input.name ?? skillHub.name
      const nextDescription = input.description === undefined ? skillHub.description : input.description

      await db
        .update(SkillHubTable)
        .set({
          name: nextName,
          description: nextDescription,
          updatedAt,
        })
        .where(eq(SkillHubTable.id, skillHub.id))

      return c.json({
        skillHub: {
          ...skillHub,
          name: nextName,
          description: nextDescription,
          updatedAt,
        },
      })
    },
  )

  app.delete(
    "/v1/orgs/:orgId/skill-hubs/:skillHubId",
    requireUserMiddleware,
    paramValidator(orgSkillHubParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")

      let skillHubId: SkillHubId
      try {
        skillHubId = parseSkillHubId(params.skillHubId)
      } catch {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      const skillHubRows = await db
        .select()
        .from(SkillHubTable)
        .where(and(eq(SkillHubTable.id, skillHubId), eq(SkillHubTable.organizationId, payload.organization.id)))
        .limit(1)

      const skillHub = skillHubRows[0]
      if (!skillHub) {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      if (!canManageHub(payload, skillHub)) {
        return c.json({ error: "forbidden", message: "Only the hub creator or an org admin can delete hubs." }, 403)
      }

      await db.transaction(async (tx) => {
        await tx.delete(SkillHubMemberTable).where(eq(SkillHubMemberTable.skillHubId, skillHub.id))
        await tx.delete(SkillHubSkillTable).where(eq(SkillHubSkillTable.skillHubId, skillHub.id))
        await tx.delete(SkillHubTable).where(eq(SkillHubTable.id, skillHub.id))
      })

      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/orgs/:orgId/skill-hubs/:skillHubId/skills",
    requireUserMiddleware,
    paramValidator(orgSkillHubParamsSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(addSkillToHubSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const input = c.req.valid("json")

      let skillHubId: SkillHubId
      let skillId: SkillId
      try {
        skillHubId = parseSkillHubId(params.skillHubId)
        skillId = parseSkillId(input.skillId)
      } catch {
        return c.json({ error: "not_found" }, 404)
      }

      const skillHubRows = await db
        .select()
        .from(SkillHubTable)
        .where(and(eq(SkillHubTable.id, skillHubId), eq(SkillHubTable.organizationId, payload.organization.id)))
        .limit(1)

      const skillHub = skillHubRows[0]
      if (!skillHub) {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      if (!canManageHub(payload, skillHub)) {
        return c.json({ error: "forbidden", message: "Only the hub creator or an org admin can manage hub skills." }, 403)
      }

      const skillRows = await db
        .select()
        .from(SkillTable)
        .where(and(eq(SkillTable.id, skillId), eq(SkillTable.organizationId, payload.organization.id)))
        .limit(1)

      const skill = skillRows[0]
      if (!skill) {
        return c.json({ error: "skill_not_found" }, 404)
      }

      if (!canManageSkill(payload, skill) && skill.shared === null) {
        return c.json({
          error: "forbidden",
          message: "Private skills can only be added to hubs by their creator or an org admin.",
        }, 403)
      }

      const existing = await db
        .select({ id: SkillHubSkillTable.id })
        .from(SkillHubSkillTable)
        .where(and(eq(SkillHubSkillTable.skillHubId, skillHubId), eq(SkillHubSkillTable.skillId, skill.id)))
        .limit(1)

      if (existing[0]) {
        return c.json({ error: "skill_hub_skill_exists" }, 409)
      }

      await db.insert(SkillHubSkillTable).values({
        id: createDenTypeId("skillHubSkill"),
        skillHubId,
        skillId: skill.id,
        addedByOrgMembershipId: payload.currentMember.id,
        createdAt: new Date(),
      })

      return c.json({ success: true }, 201)
    },
  )

  app.delete(
    "/v1/orgs/:orgId/skill-hubs/:skillHubId/skills/:skillId",
    requireUserMiddleware,
    paramValidator(orgSkillHubSkillParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")

      let skillHubId: SkillHubId
      let skillId: SkillId
      try {
        skillHubId = parseSkillHubId(params.skillHubId)
        skillId = parseSkillId(params.skillId)
      } catch {
        return c.json({ error: "not_found" }, 404)
      }

      const skillHubRows = await db
        .select()
        .from(SkillHubTable)
        .where(and(eq(SkillHubTable.id, skillHubId), eq(SkillHubTable.organizationId, payload.organization.id)))
        .limit(1)

      const skillHub = skillHubRows[0]
      if (!skillHub) {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      if (!canManageHub(payload, skillHub)) {
        return c.json({ error: "forbidden", message: "Only the hub creator or an org admin can manage hub skills." }, 403)
      }

      const existing = await db
        .select({ id: SkillHubSkillTable.id })
        .from(SkillHubSkillTable)
        .where(and(eq(SkillHubSkillTable.skillHubId, skillHubId), eq(SkillHubSkillTable.skillId, skillId)))
        .limit(1)

      if (!existing[0]) {
        return c.json({ error: "skill_hub_skill_not_found" }, 404)
      }

      await db
        .delete(SkillHubSkillTable)
        .where(and(eq(SkillHubSkillTable.skillHubId, skillHubId), eq(SkillHubSkillTable.skillId, skillId)))

      return c.body(null, 204)
    },
  )

  app.post(
    "/v1/orgs/:orgId/skill-hubs/:skillHubId/access",
    requireUserMiddleware,
    paramValidator(orgSkillHubParamsSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(addSkillHubAccessSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")
      const input = c.req.valid("json")

      let skillHubId: SkillHubId
      let orgMembershipId: MemberId | null = null
      let teamId: TeamId | null = null
      try {
        skillHubId = parseSkillHubId(params.skillHubId)
        orgMembershipId = input.orgMembershipId ? parseMemberId(input.orgMembershipId) : null
        teamId = input.teamId ? parseTeamId(input.teamId) : null
      } catch {
        return c.json({ error: "access_target_not_found" }, 404)
      }

      const skillHubRows = await db
        .select()
        .from(SkillHubTable)
        .where(and(eq(SkillHubTable.id, skillHubId), eq(SkillHubTable.organizationId, payload.organization.id)))
        .limit(1)

      const skillHub = skillHubRows[0]
      if (!skillHub) {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      if (!canManageHub(payload, skillHub)) {
        return c.json({ error: "forbidden", message: "Only the hub creator or an org admin can manage access." }, 403)
      }

      if (orgMembershipId) {
        const memberRows = await db
          .select({ id: MemberTable.id })
          .from(MemberTable)
          .where(and(eq(MemberTable.id, orgMembershipId), eq(MemberTable.organizationId, payload.organization.id)))
          .limit(1)

        if (!memberRows[0]) {
          return c.json({ error: "member_not_found" }, 404)
        }
      }

      if (teamId) {
        const teamRows = await db
          .select({ id: TeamTable.id })
          .from(TeamTable)
          .where(and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, payload.organization.id)))
          .limit(1)

        if (!teamRows[0]) {
          return c.json({ error: "team_not_found" }, 404)
        }
      }

      const existing = await db
        .select({ id: SkillHubMemberTable.id })
        .from(SkillHubMemberTable)
        .where(
          orgMembershipId
            ? and(eq(SkillHubMemberTable.skillHubId, skillHubId), eq(SkillHubMemberTable.orgMembershipId, orgMembershipId))
            : and(eq(SkillHubMemberTable.skillHubId, skillHubId), eq(SkillHubMemberTable.teamId, teamId as TeamId)),
        )
        .limit(1)

      if (existing[0]) {
        return c.json({ error: "skill_hub_access_exists" }, 409)
      }

      const accessId = createDenTypeId("skillHubMember")
      const createdAt = new Date()

      await db.insert(SkillHubMemberTable).values({
        id: accessId,
        skillHubId,
        orgMembershipId,
        teamId,
        createdAt,
      })

      return c.json({
        access: {
          id: accessId,
          skillHubId,
          orgMembershipId,
          teamId,
          createdAt,
        },
      }, 201)
    },
  )

  app.delete(
    "/v1/orgs/:orgId/skill-hubs/:skillHubId/access/:accessId",
    requireUserMiddleware,
    paramValidator(orgSkillHubAccessParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const params = c.req.valid("param")

      let skillHubId: SkillHubId
      let accessId: SkillHubMemberId
      try {
        skillHubId = parseSkillHubId(params.skillHubId)
        accessId = parseSkillHubMemberId(params.accessId)
      } catch {
        return c.json({ error: "not_found" }, 404)
      }

      const skillHubRows = await db
        .select()
        .from(SkillHubTable)
        .where(and(eq(SkillHubTable.id, skillHubId), eq(SkillHubTable.organizationId, payload.organization.id)))
        .limit(1)

      const skillHub = skillHubRows[0]
      if (!skillHub) {
        return c.json({ error: "skill_hub_not_found" }, 404)
      }

      if (!canManageHub(payload, skillHub)) {
        return c.json({ error: "forbidden", message: "Only the hub creator or an org admin can manage access." }, 403)
      }

      const accessRows = await db
        .select()
        .from(SkillHubMemberTable)
        .where(and(eq(SkillHubMemberTable.id, accessId), eq(SkillHubMemberTable.skillHubId, skillHubId)))
        .limit(1)

      const access = accessRows[0]
      if (!access) {
        return c.json({ error: "skill_hub_access_not_found" }, 404)
      }

      await db.delete(SkillHubMemberTable).where(eq(SkillHubMemberTable.id, access.id))
      return c.body(null, 204)
    },
  )
}
