import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"
import { finishLegacyAuditAction } from "../../audit/domain/legacy.js"
import { auditChangeCapture } from "../../audit/request-capture.js"
import { jsonValidator, orgPermissionRoute, orgRoleRoute, paramValidator } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { listAssignableRoles, removeOrganizationMember, transferOrganizationOwnership, updateOrganizationMemberRole } from "../../orgs.js"
import { roleAssignmentDecider, roleAssignmentDeniedHeaders, roleAssignmentDeniedResponse, roleAssignmentDenialInTransaction, roleAssignmentTarget, roleAssignmentTargetFromRole } from "../../permissions/team-grants.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner, idParamSchema, memberPermissionsForRequest, normalizeRoleName, orgAccessFailureStatus } from "./shared.js"

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
        403: jsonResponse("The caller needs the Change member roles permission and a recent sign-in. With Permissions on, making someone an admin also needs every Admin permission, only the owner or an admin can change an admin's role, and nobody but the owner can change their own role.", forbiddenSchema),
        404: jsonResponse("The member or organization could not be found.", notFoundSchema),
      },
    }),
    orgPermissionRoute("members.update"),
    paramValidator(orgMemberParamsSchema),
    jsonValidator(updateMemberRoleSchema),
    async (c) => {
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

    const caller = await memberPermissionsForRequest(c)
    if (!caller) return c.json({ error: "organization_not_found" }, 404)
    const target = await roleAssignmentTarget(payload.organization.id, memberId)
    if (!target) return c.json({ error: "member_not_found", message: "The organization member could not be found." }, 404)
    const decideRoleChange = await roleAssignmentDecider({
      organizationId: payload.organization.id,
      caller,
      callerMemberId: payload.currentMember.id,
      nextRole: role,
    })
    const denial = decideRoleChange(target)
    if (denial) return c.json(roleAssignmentDeniedResponse(denial), 403, roleAssignmentDeniedHeaders(denial))

    const updated = await updateOrganizationMemberRole({
      organizationId: payload.organization.id,
      memberId,
      nextRole: role,
      // The target's role, the caller's permissions and the Admin default set may all have changed
      // since the check above; decide again on the locked row, reading through the transaction.
      authorize: (member, tx) => roleAssignmentDenialInTransaction({
        tx,
        organizationId: payload.organization.id,
        callerMemberId: payload.currentMember.id,
        target: roleAssignmentTargetFromRole(member.id, member.role),
        nextRole: role,
      }),
    })
    if (!updated.ok) {
      if (updated.error === "role_assignment_denied") {
        return c.json(roleAssignmentDeniedResponse(updated.denial), 403, roleAssignmentDeniedHeaders(updated.denial))
      }
      if (updated.error === "member_not_found") {
        return c.json({ error: updated.error, message: updated.message }, 404)
      }
      return c.json({ error: updated.error, message: updated.message }, 400)
    }

    if (updated.changed) {
      await finishLegacyAuditAction(auditChangeCapture(c), {
        organizationId: payload.organization.id,
        actorUserId: payload.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.memberRoleUpdated,
        payload: {
          targetOrgMembershipId: updated.member.id,
          targetUserId: updated.member.userId,
          previousRole: updated.previousRole,
          nextRole: updated.nextRole,
        },
      }, updated.auditEventIds)
    }

    return c.json({ success: true })
    },
  )

  app.post(
    "/v1/members/:memberId/transfer-ownership",
    describeRoute({
      tags: ["Members"],
      summary: "Transfer workspace ownership",
      description: "Transfers the protected workspace owner role to another active admin member.",
      responses: {
        200: jsonResponse("Workspace ownership transferred successfully.", successSchema),
        400: jsonResponse("The ownership transfer request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to transfer ownership.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can transfer ownership.", forbiddenSchema),
        404: jsonResponse("The target member or organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["owner"]),
    paramValidator(orgMemberParamsSchema),
    async (c) => {
    const permission = ensureOwner(c)
    if (!permission.ok) {
      return c.json(permission.response, orgAccessFailureStatus(permission.response))
    }

    const payload = c.get("organizationContext")
    const params = c.req.valid("param")
    let memberId: MemberId
    try {
      memberId = normalizeDenTypeId("member", params.memberId)
    } catch {
      return c.json({ error: "target_member_not_found", message: "Choose an active member to become workspace owner." }, 404)
    }

    const transfer = await transferOrganizationOwnership({
      organizationId: payload.organization.id,
      currentOwnerMemberId: payload.currentMember.id,
      targetMemberId: memberId,
    })
    if (!transfer.ok) {
      if (transfer.error === "target_member_not_found" || transfer.error === "owner_not_found") {
        return c.json({ error: transfer.error, message: transfer.message }, 404)
      }
      return c.json({ error: transfer.error, message: transfer.message }, 400)
    }

    await finishLegacyAuditAction(auditChangeCapture(c), {
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.memberOwnershipTransferred,
      payload: {
        previousOwnerOrgMembershipId: transfer.previousOwner.id,
        previousOwnerUserId: transfer.previousOwner.userId,
        previousOwnerRole: transfer.previousOwner.role,
        previousOwnerNextRole: transfer.previousOwnerRole,
        previousOwnerCount: transfer.previousOwnerCount,
        newOwnerOrgMembershipId: transfer.newOwner.id,
        newOwnerUserId: transfer.newOwner.userId,
        newOwnerPreviousRole: transfer.newOwner.role,
        newOwnerRole: transfer.newOwnerRole,
      },
    }, transfer.auditEventIds)

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
        403: jsonResponse("The caller needs the Remove members permission and a recent sign-in. Removing a member of an Admin team also needs Manage Admin teams, and with Permissions on only the owner or an admin can remove an admin.", forbiddenSchema),
        404: jsonResponse("The member or organization could not be found.", notFoundSchema),
      },
    }),
    orgPermissionRoute("members.delete"),
    paramValidator(orgMemberParamsSchema),
    async (c) => {
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
      requiredPermission: "members.delete",
    })
    if (!removed.ok) {
      if (removed.error === "forbidden") return c.json({ error: removed.error, message: removed.message }, 403)
      if (removed.error === "member_not_found") {
        return c.json({ error: removed.error, message: removed.message }, 404)
      }
      return c.json({ error: removed.error, message: removed.message }, 400)
    }

    await finishLegacyAuditAction(auditChangeCapture(c), {
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.memberRemoved,
      payload: {
        targetOrgMembershipId: removed.member.id,
        targetUserId: removed.member.userId,
        previousRole: removed.member.role,
      },
    }, removed.auditEventIds)

    return c.body(null, 204)
    },
  )
}
