import { and, eq, isNotNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { revokeOrganizationApiKeysForMember } from "../../api-keys.js"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { revokeMembershipSessionCredentials } from "../../credential-revocation.js"
import { db } from "../../db.js"
import { jsonValidator, orgRoleRoute, paramValidator } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { listAssignableRoles, recoverOrganizationOwnership, removeOrganizationMember, transferOrganizationOwnership, validateOrganizationMemberRoleUpdate } from "../../orgs.js"
import { admitOrganizationMember } from "../../organization-admission.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureMemberRemover, ensureOrganizationAdmin, ensureOwner, idParamSchema, normalizeRoleName, orgAccessFailureStatus } from "./shared.js"

const updateMemberRoleSchema = z.object({
  role: z.string().trim().min(1).max(64),
})
const restoreMemberSchema = z.object({
  role: z.string().trim().min(1).max(64).optional(),
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
    orgRoleRoute(["owner"]),
    paramValidator(orgMemberParamsSchema),
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

  app.post(
    "/v1/members/:memberId/transfer-ownership",
    describeRoute({
      tags: ["Members"],
      summary: "Transfer workspace ownership",
      description: "Transfers the protected workspace owner role to another active organization member. Workspace admins may use this endpoint only to recover an organization that has no active owner.",
      responses: {
        200: jsonResponse("Workspace ownership transferred successfully.", successSchema),
        400: jsonResponse("The ownership transfer request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to transfer ownership.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can transfer ownership.", forbiddenSchema),
        404: jsonResponse("The target member or organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(orgMemberParamsSchema),
    async (c) => {
    const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can transfer ownership.")
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

    const transfer = payload.currentMember.isOwner
      ? await transferOrganizationOwnership({
        organizationId: payload.organization.id,
        currentOwnerMemberId: payload.currentMember.id,
        targetMemberId: memberId,
      })
      : await recoverOrganizationOwnership({
        organizationId: payload.organization.id,
        targetMemberId: memberId,
      })
    if (!transfer.ok) {
      if (transfer.error === "target_member_not_found" || transfer.error === "owner_not_found") {
        return c.json({ error: transfer.error, message: transfer.message }, 404)
      }
      if (!payload.currentMember.isOwner) {
        return c.json({ error: transfer.error, message: transfer.message }, 403)
      }
      return c.json({ error: transfer.error, message: transfer.message }, 400)
    }

    const previousOwner = "previousOwner" in transfer ? transfer.previousOwner : null
    const previousOwnerRole = "previousOwnerRole" in transfer ? transfer.previousOwnerRole : null

    await recordOrganizationAuditEvent({
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.memberOwnershipTransferred,
      payload: {
        previousOwnerOrgMembershipId: previousOwner?.id ?? null,
        previousOwnerUserId: previousOwner?.userId ?? null,
        previousOwnerRole: previousOwner?.role ?? null,
        previousOwnerNextRole: previousOwnerRole,
        previousOwnerCount: "previousOwnerCount" in transfer ? transfer.previousOwnerCount : 1,
        newOwnerOrgMembershipId: transfer.newOwner.id,
        newOwnerUserId: transfer.newOwner.userId,
        newOwnerPreviousRole: transfer.newOwner.role,
        newOwnerRole: transfer.newOwnerRole,
      },
    })

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
    orgRoleRoute(["admin"]),
    paramValidator(orgMemberParamsSchema),
    async (c) => {
    const permission = ensureMemberRemover(c)
    if (!permission.ok) {
      return c.json(permission.response, orgAccessFailureStatus(permission.response))
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

  app.post(
    "/v1/members/:memberId/restore",
    describeRoute({
      tags: ["Members"],
      summary: "Restore a removed organization member",
      description: "Explicitly restores a removed member through the organization admission policy.",
      responses: {
        200: jsonResponse("Member restored successfully.", successSchema),
        400: jsonResponse("The restoration request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only a workspace owner or admin can restore members.", forbiddenSchema),
        404: jsonResponse("The removed member could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    paramValidator(orgMemberParamsSchema),
    jsonValidator(restoreMemberSchema),
    async (c) => {
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can restore members.")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
      const payload = c.get("organizationContext")
      const memberId = normalizeDenTypeId("member", c.req.valid("param").memberId)
      const rows = await db
        .select()
        .from(MemberTable)
        .where(and(
          eq(MemberTable.id, memberId),
          eq(MemberTable.organizationId, payload.organization.id),
          isNotNull(MemberTable.removedAt),
        ))
        .limit(1)
      const member = rows[0]
      if (!member?.userId) return c.json({ error: "member_not_found" }, 404)
      const requestedRole = c.req.valid("json").role
      const role = requestedRole ? normalizeRoleName(requestedRole) : member.role
      const availableRoles = await listAssignableRoles(payload.organization.id)
      if (!availableRoles.has(role)) return c.json({ error: "invalid_role", message: "Choose one of the existing organization roles." }, 400)
      const admission = await admitOrganizationMember({
        organizationId: payload.organization.id,
        userId: member.userId,
        evidence: { kind: "admin_restore", role, actorMemberId: payload.currentMember.id },
      })
      if (admission.decision !== "allow") return c.json({ error: "organization_admission_required", admission }, 403)
      return c.json({ success: true })
    },
  )
}
