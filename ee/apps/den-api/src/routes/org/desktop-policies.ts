import { and, asc, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  DesktopPolicyMemberTable,
  DesktopPolicyTable,
  MemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  desktopPolicyDefinitions,
  desktopPolicyValueSchema,
  normalizeDefaultDesktopPolicyValue,
  normalizeDesktopPolicyValue,
  type DesktopPolicyValue,
} from "@openwork/types/den/desktop-policies"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { checkEntitlement } from "../../entitlements.js"
import { jsonValidator, orgRoleRoute, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, enterprisePlanRequiredSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, idParamSchema, orgAccessFailureStatus } from "./shared.js"

type DesktopPolicyId = typeof DesktopPolicyTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type TeamId = typeof TeamTable.$inferSelect.id

const desktopPolicyParamsSchema = idParamSchema("desktopPolicyId", "desktopPolicy")

const desktopPolicyWriteSchema = z.object({
  policyName: z.string().trim().min(1).max(255),
  policy: desktopPolicyValueSchema,
  isEnabled: z.boolean().optional(),
  memberIds: z.array(denTypeIdSchema("member")).max(500).optional().default([]),
  teamIds: z.array(denTypeIdSchema("team")).max(500).optional().default([]),
})

const desktopPolicyListResponseSchema = z.object({
  definitions: z.array(z.object({}).passthrough()),
  desktopPolicies: z.array(z.object({}).passthrough()),
}).meta({ ref: "DesktopPolicyListResponse" })

const desktopPolicyResponseSchema = z.object({
  desktopPolicy: z.object({}).passthrough(),
}).meta({ ref: "DesktopPolicyResponse" })

function parseDesktopPolicyId(value: string) {
  return normalizeDenTypeId("desktopPolicy", value)
}

function parseMemberId(value: string) {
  return normalizeDenTypeId("member", value)
}

function parseTeamId(value: string) {
  return normalizeDenTypeId("team", value)
}

async function resolveMemberIds(input: {
  organizationId: typeof DesktopPolicyTable.$inferSelect.organizationId
  values: string[]
}) {
  const memberIds = [...new Set(input.values)].map(parseMemberId)
  if (memberIds.length === 0) return [] as MemberId[]

  const rows = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, input.organizationId), inArray(MemberTable.id, memberIds), isNull(MemberTable.removedAt)))

  if (rows.length !== memberIds.length) {
    throw new Error("member_not_found")
  }

  return memberIds
}

async function resolveTeamIds(input: {
  organizationId: typeof DesktopPolicyTable.$inferSelect.organizationId
  values: string[]
}) {
  const teamIds = [...new Set(input.values)].map(parseTeamId)
  if (teamIds.length === 0) return [] as TeamId[]

  const rows = await db
    .select({ id: TeamTable.id })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, input.organizationId), inArray(TeamTable.id, teamIds)))

  if (rows.length !== teamIds.length) {
    throw new Error("team_not_found")
  }

  return teamIds
}

async function loadDesktopPolicies(organizationId: typeof DesktopPolicyTable.$inferSelect.organizationId) {
  const policies = await db
    .select()
    .from(DesktopPolicyTable)
    .where(and(eq(DesktopPolicyTable.organizationId, organizationId), isNull(DesktopPolicyTable.deletedAt)))
    .orderBy(desc(DesktopPolicyTable.isDefault), asc(DesktopPolicyTable.policyName))

  if (policies.length === 0) return []

  const policyIds = policies.map((policy) => policy.id)
  const assignments = await db
    .select({
      id: DesktopPolicyMemberTable.id,
      desktopPolicyId: DesktopPolicyMemberTable.desktopPolicyId,
      orgMemberId: DesktopPolicyMemberTable.orgMemberId,
      teamId: DesktopPolicyMemberTable.teamId,
      createdAt: DesktopPolicyMemberTable.createdAt,
    })
    .from(DesktopPolicyMemberTable)
    .where(inArray(DesktopPolicyMemberTable.desktopPolicyId, policyIds))

  return policies.map((policy) => ({
    id: policy.id,
    organizationId: policy.organizationId,
    policyName: policy.policyName,
    isDefault: policy.isDefault === true,
    isEnabled: policy.isEnabled === true,
    policy: policy.isDefault === true
      ? normalizeDefaultDesktopPolicyValue(policy.policy)
      : normalizeDesktopPolicyValue(policy.policy),
    createdByOrgMemberId: policy.createdByOrgMemberId,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
    deletedAt: policy.deletedAt,
    assignments: assignments
      .filter((assignment) => assignment.desktopPolicyId === policy.id)
      .map((assignment) => ({
        id: assignment.id,
        orgMemberId: assignment.orgMemberId,
        teamId: assignment.teamId,
        createdAt: assignment.createdAt,
      })),
  }))
}

export function registerOrgDesktopPolicyRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/desktop-policies",
    describeRoute({
      tags: ["Desktop Policies"],
      summary: "List desktop policies",
      responses: {
        200: jsonResponse("Desktop policies returned successfully.", desktopPolicyListResponseSchema),
        401: jsonResponse("The caller must be signed in to list desktop policies.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can list desktop policies.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can manage desktop policies.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      const desktopPolicies = await loadDesktopPolicies(payload.organization.id)
      return c.json({ definitions: desktopPolicyDefinitions, desktopPolicies })
    },
  )

  app.post(
    "/v1/desktop-policies",
    describeRoute({
      tags: ["Desktop Policies"],
      summary: "Create desktop policy",
      responses: {
        201: jsonResponse("Desktop policy created successfully.", desktopPolicyResponseSchema),
        400: jsonResponse("The desktop policy request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create desktop policies.", unauthorizedSchema),
        402: jsonResponse("Desktop policy management requires an Enterprise plan.", enterprisePlanRequiredSchema),
        403: jsonResponse("Only workspace owners and admins can create desktop policies.", forbiddenSchema),
        404: jsonResponse("A referenced member or team was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    jsonValidator(desktopPolicyWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can manage desktop policies.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      const entitlement = checkEntitlement(payload.organization.metadata, "desktopPolicies")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      const input = c.req.valid("json")
      try {
        const memberIds = await resolveMemberIds({ organizationId: payload.organization.id, values: input.memberIds })
        const teamIds = await resolveTeamIds({ organizationId: payload.organization.id, values: input.teamIds })
        const desktopPolicyId = createDenTypeId("desktopPolicy")
        const now = new Date()

        await db.transaction(async (tx) => {
          await tx.insert(DesktopPolicyTable).values({
            id: desktopPolicyId,
            organizationId: payload.organization.id,
            policyName: input.policyName.trim(),
            isDefault: null,
            isEnabled: input.isEnabled ?? true,
            policy: normalizeDesktopPolicyValue(input.policy),
            createdByOrgMemberId: payload.currentMember.id,
            createdAt: now,
            updatedAt: now,
          })

          const assignmentRows = [
            ...memberIds.map((orgMemberId) => ({
              id: createDenTypeId("desktopPolicyMember"),
              organizationId: payload.organization.id,
              desktopPolicyId,
              orgMemberId,
              teamId: null,
              createdAt: now,
            })),
            ...teamIds.map((teamId) => ({
              id: createDenTypeId("desktopPolicyMember"),
              organizationId: payload.organization.id,
              desktopPolicyId,
              orgMemberId: null,
              teamId,
              createdAt: now,
            })),
          ]

          if (assignmentRows.length > 0) {
            await tx.insert(DesktopPolicyMemberTable).values(assignmentRows)
          }
        })

        const [desktopPolicy] = await loadDesktopPolicies(payload.organization.id)
          .then((policies) => policies.filter((policy) => policy.id === desktopPolicyId))
        return c.json({ desktopPolicy }, 201)
      } catch (error) {
        if (error instanceof Error && error.message === "member_not_found") return c.json({ error: "member_not_found" }, 404)
        if (error instanceof Error && error.message === "team_not_found") return c.json({ error: "team_not_found" }, 404)
        throw error
      }
    },
  )

  app.patch(
    "/v1/desktop-policies/:desktopPolicyId",
    describeRoute({
      tags: ["Desktop Policies"],
      summary: "Update desktop policy",
      responses: {
        200: jsonResponse("Desktop policy updated successfully.", desktopPolicyResponseSchema),
        400: jsonResponse("The desktop policy request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update desktop policies.", unauthorizedSchema),
        402: jsonResponse("Desktop policy management requires an Enterprise plan.", enterprisePlanRequiredSchema),
        403: jsonResponse("Only workspace owners and admins can update desktop policies.", forbiddenSchema),
        404: jsonResponse("The policy or a referenced resource was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(desktopPolicyParamsSchema),
    jsonValidator(desktopPolicyWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can manage desktop policies.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      const entitlement = checkEntitlement(payload.organization.metadata, "desktopPolicies")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      let desktopPolicyId: DesktopPolicyId
      try {
        desktopPolicyId = parseDesktopPolicyId(c.req.valid("param").desktopPolicyId)
      } catch {
        return c.json({ error: "desktop_policy_not_found" }, 404)
      }

      const rows = await db
        .select()
        .from(DesktopPolicyTable)
        .where(and(
          eq(DesktopPolicyTable.id, desktopPolicyId),
          eq(DesktopPolicyTable.organizationId, payload.organization.id),
          isNull(DesktopPolicyTable.deletedAt),
        ))
        .limit(1)
      const existing = rows[0]
      if (!existing) return c.json({ error: "desktop_policy_not_found" }, 404)

      const input = c.req.valid("json")
      if (existing.isDefault === true && input.isEnabled === false) {
        return c.json({ error: "default_policy_required", message: "The default desktop policy cannot be disabled." }, 400)
      }

      try {
        const memberIds = await resolveMemberIds({ organizationId: payload.organization.id, values: input.memberIds })
        const teamIds = await resolveTeamIds({ organizationId: payload.organization.id, values: input.teamIds })
        const updatedAt = new Date()

        await db.transaction(async (tx) => {
          await tx
            .update(DesktopPolicyTable)
            .set({
              policyName: existing.isDefault === true ? existing.policyName : input.policyName.trim(),
              isEnabled: existing.isDefault === true ? true : input.isEnabled ?? existing.isEnabled,
              policy: existing.isDefault === true
                ? normalizeDefaultDesktopPolicyValue(input.policy)
                : normalizeDesktopPolicyValue(input.policy),
              updatedAt,
            })
            .where(eq(DesktopPolicyTable.id, existing.id))

          if (existing.isDefault !== true) {
            await tx.delete(DesktopPolicyMemberTable).where(eq(DesktopPolicyMemberTable.desktopPolicyId, existing.id))
            const assignmentRows = [
              ...memberIds.map((orgMemberId) => ({
                id: createDenTypeId("desktopPolicyMember"),
                organizationId: payload.organization.id,
                desktopPolicyId: existing.id,
                orgMemberId,
                teamId: null,
                createdAt: updatedAt,
              })),
              ...teamIds.map((teamId) => ({
                id: createDenTypeId("desktopPolicyMember"),
                organizationId: payload.organization.id,
                desktopPolicyId: existing.id,
                orgMemberId: null,
                teamId,
                createdAt: updatedAt,
              })),
            ]
            if (assignmentRows.length > 0) {
              await tx.insert(DesktopPolicyMemberTable).values(assignmentRows)
            }
          }
        })

        const [desktopPolicy] = await loadDesktopPolicies(payload.organization.id)
          .then((policies) => policies.filter((policy) => policy.id === existing.id))
        return c.json({ desktopPolicy })
      } catch (error) {
        if (error instanceof Error && error.message === "member_not_found") return c.json({ error: "member_not_found" }, 404)
        if (error instanceof Error && error.message === "team_not_found") return c.json({ error: "team_not_found" }, 404)
        throw error
      }
    },
  )

  app.delete(
    "/v1/desktop-policies/:desktopPolicyId",
    describeRoute({
      tags: ["Desktop Policies"],
      summary: "Delete desktop policy",
      responses: {
        204: emptyResponse("Desktop policy deleted successfully."),
        401: jsonResponse("The caller must be signed in to delete desktop policies.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can delete desktop policies.", forbiddenSchema),
        404: jsonResponse("The policy was not found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(desktopPolicyParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can manage desktop policies.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      let desktopPolicyId: DesktopPolicyId
      try {
        desktopPolicyId = parseDesktopPolicyId(c.req.valid("param").desktopPolicyId)
      } catch {
        return c.json({ error: "desktop_policy_not_found" }, 404)
      }

      const rows = await db
        .select()
        .from(DesktopPolicyTable)
        .where(and(
          eq(DesktopPolicyTable.id, desktopPolicyId),
          eq(DesktopPolicyTable.organizationId, payload.organization.id),
          isNull(DesktopPolicyTable.deletedAt),
        ))
        .limit(1)
      const existing = rows[0]
      if (!existing) return c.json({ error: "desktop_policy_not_found" }, 404)
      if (existing.isDefault === true) {
        return c.json({ error: "default_policy_required", message: "The default desktop policy cannot be deleted." }, 400)
      }

      await db
        .update(DesktopPolicyTable)
        .set({ deletedAt: new Date(), isEnabled: false })
        .where(eq(DesktopPolicyTable.id, existing.id))

      return c.body(null, 204)
    },
  )
}
