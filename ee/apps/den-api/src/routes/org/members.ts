import { eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { revokeOrganizationApiKeysForMember } from "../../api-keys.js"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { revokeMembershipSessionCredentials } from "../../credential-revocation.js"
import { db } from "../../db.js"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { listAssignableRoles, removeOrganizationMember, validateOrganizationMemberRoleUpdate } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureMemberRemover, ensureOwner, idParamSchema, normalizeRoleName } from "./shared.js"

const updateMemberRoleSchema = z.object({
  role: z.string().trim().min(1).max(64),
})

type MemberId = typeof MemberTable.$inferSelect.id
const orgMemberParamsSchema = idParamSchema("memberId", "member")

export function registerOrgMemberRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/members/:memberId/role",
    describeRoute({
      tags: ["Members"],
      summary: "Update member role",
      description: "Changes the role assigned to a specific organization member.",
      responses: {
        200: jsonResponse("Member role updated successfully.", successSchema),
        400: jsonResponse("The member role update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update member roles.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can update member roles.", forbiddenSchema),
        404: jsonResponse("The member or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgMemberParamsSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(updateMemberRoleSchema),
    async (c) => {
    const permission = ensureOwner(c)
    if (!permission.ok) {
      return c.json(permission.response, 403)
    }

    const payload = c.get("organizationContext")
    const input = c.req.valid("json")

    const params = c.req.valid("param")
    let memberId: MemberId
    try {
      memberId = normalizeDenTypeId("member", params.memberId)
    } catch {
      return c.json({ error: "member_not_found" }, 404)
    }

    const role = normalizeRoleName(input.role)
    const availableRoles = await listAssignableRoles(payload.organization.id)
    if (!availableRoles.has(role)) {
      return c.json({ error: "invalid_role", message: "Choose one of the existing organization roles." }, 400)
    }

    const validation = await validateOrganizationMemberRoleUpdate({
      organizationId: payload.organization.id,
      memberId,
      nextRole: role,
    })
    if (!validation.ok) {
      if (validation.error === "member_not_found") {
        return c.json({ error: validation.error, message: validation.message }, 404)
      }
      return c.json({ error: validation.error, message: validation.message }, 400)
    }

    if (validation.member.role !== role) {
      await db.update(MemberTable).set({ role }).where(eq(MemberTable.id, validation.member.id))
      await revokeOrganizationApiKeysForMember({
        organizationId: payload.organization.id,
        orgMembershipId: validation.member.id,
        userId: validation.member.userId,
      })
      await revokeMembershipSessionCredentials({
        organizationId: payload.organization.id,
        userId: validation.member.userId,
      })
      await recordOrganizationAuditEvent({
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.memberRoleUpdated,
        payload: {
          targetOrgMembershipId: validation.member.id,
          targetUserId: validation.member.userId,
          previousRole: validation.member.role,
          nextRole: role,
        },
      })
    }

    return c.json({ success: true })
    },
  )

  app.delete(
    "/v1/members/:memberId",
    describeRoute({
      tags: ["Members"],
      summary: "Remove organization member",
      description: "Removes a member from an organization while protecting the owner role from deletion.",
      responses: {
        204: emptyResponse("Member removed successfully."),
        400: jsonResponse("The member removal request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to remove organization members.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can remove members.", forbiddenSchema),
        404: jsonResponse("The member or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgMemberParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
    const permission = ensureMemberRemover(c)
    if (!permission.ok) {
      return c.json(permission.response, permission.response.error === "forbidden" ? 403 : 404)
    }

    const payload = c.get("organizationContext")
    const params = c.req.valid("param")
    let memberId: MemberId
    try {
      memberId = normalizeDenTypeId("member", params.memberId)
    } catch {
      return c.json({ error: "member_not_found" }, 404)
    }

    const removed = await removeOrganizationMember({
      organizationId: payload.organization.id,
      memberId,
      removedByOrgMemberId: payload.currentMember.id,
    })
    if (!removed.ok) {
      if (removed.error === "member_not_found") {
        return c.json({ error: removed.error, message: removed.message }, 404)
      }
      return c.json({ error: removed.error, message: removed.message }, 400)
    }

    await recordOrganizationAuditEvent({
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.memberRemoved,
      payload: {
        targetOrgMembershipId: removed.member.id,
        targetUserId: removed.member.userId,
        previousRole: removed.member.role,
      },
    })

    return c.body(null, 204)
    },
  )
}
