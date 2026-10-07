import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { InvitationTable, MemberTable, OrganizationRoleTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"
import { appendDomainChanges, finishLegacyAuditAction } from "../../audit/domain/legacy.js"
import { roleCreatedEvent, roleDeletedEvent, roleUpdatedEvent } from "../../audit/domain/roles.js"
import { auditChangeCapture } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { jsonValidator, orgRoleRoute, paramValidator } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { validateAssignableOrganizationPermissionRecord } from "../../organization-access.js"
import { isProtectedOrganizationRoleName } from "../../organization-role-hierarchy.js"
import { revokeCredentialsForOrganizationRoleMembers } from "../../organization-role-credential-revocation.js"
import { serializePermissionRecord } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"
import { createRoleId, ensureOrganizationSuperAdmin, idParamSchema, normalizeRoleName, orgAccessFailureStatus, replaceRoleValue, splitRoles } from "./shared.js"

const permissionSchema = z.record(z.string(), z.array(z.string()))

const createRoleSchema = z.object({
  roleName: z.string().trim().min(2).max(64),
  permission: permissionSchema,
})

const updateRoleSchema = z.object({
  roleName: z.string().trim().min(2).max(64).optional(),
  permission: permissionSchema.optional(),
})

type OrganizationRoleId = typeof OrganizationRoleTable.$inferSelect.id
const orgRoleParamsSchema = idParamSchema("roleId", "organizationRole")

export function registerOrgRoleRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/roles",
    describeRoute({
      tags: ["Roles"],
      summary: "Create organization role",
      description: "Creates a custom organization role with a named permission map.",
      responses: {
        201: jsonResponse("Organization role created successfully.", successSchema),
        400: jsonResponse("The role creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create organization roles.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and super-admins can create custom roles.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    jsonValidator(createRoleSchema),
    async (c) => {
    const permission = ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can create custom roles.")
    if (!permission.ok) {
      return c.json(permission.response, orgAccessFailureStatus(permission.response))
    }

    const payload = c.get("organizationContext")
    const input = c.req.valid("json")

    const validPermission = validateAssignableOrganizationPermissionRecord({
      permission: input.permission,
      roleValue: payload.currentMember.role,
      roles: payload.roles,
    })
    if (!validPermission.ok) {
      return c.json({ error: validPermission.error, message: validPermission.message }, 400)
    }

    const roleName = normalizeRoleName(input.roleName)
    if (isProtectedOrganizationRoleName(roleName)) {
      return c.json({ error: "invalid_role", message: "Built-in roles are managed by the system." }, 400)
    }

    const existingByName = await db
      .select({ id: OrganizationRoleTable.id })
      .from(OrganizationRoleTable)
      .where(and(eq(OrganizationRoleTable.organizationId, payload.organization.id), eq(OrganizationRoleTable.role, roleName)))
      .limit(1)

    if (existingByName[0]) {
      return c.json({ error: "role_exists", message: "That role already exists in this organization." }, 409)
    }

    const roleId = createRoleId()
    const capture = auditChangeCapture(c)
    const auditEventIds = await db.transaction(async (tx) => {
      await tx.insert(OrganizationRoleTable).values({
        id: roleId,
        organizationId: payload.organization.id,
        role: roleName,
        permission: serializePermissionRecord(input.permission),
      })
      if (!capture) return []
      const [created] = await tx.select().from(OrganizationRoleTable).where(eq(OrganizationRoleTable.id, roleId)).limit(1)
      return created ? appendDomainChanges(tx, capture, [roleCreatedEvent(payload.organization.id, created)]) : []
    })

    await finishLegacyAuditAction(capture, {
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.roleCreated,
      payload: {
        organizationRoleId: roleId,
        role: roleName,
      },
    }, auditEventIds)

    return c.json({ success: true }, 201)
    },
  )

  app.patch(
    "/v1/roles/:roleId",
    describeRoute({
      tags: ["Roles"],
      summary: "Update organization role",
      description: "Updates a custom organization role and propagates role name changes to members and pending invitations.",
      responses: {
        200: jsonResponse("Organization role updated successfully.", successSchema),
        400: jsonResponse("The role update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update organization roles.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and super-admins can update custom roles.", forbiddenSchema),
        404: jsonResponse("The role or organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    paramValidator(orgRoleParamsSchema),
    jsonValidator(updateRoleSchema),
    async (c) => {
    const permission = ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can update custom roles.")
    if (!permission.ok) {
      return c.json(permission.response, orgAccessFailureStatus(permission.response))
    }

    const payload = c.get("organizationContext")
    const input = c.req.valid("json")

    const params = c.req.valid("param")
    let roleId: OrganizationRoleId
    try {
      roleId = normalizeDenTypeId("organizationRole", params.roleId)
    } catch {
      return c.json({ error: "role_not_found" }, 404)
    }

    const roleRows = await db
      .select()
      .from(OrganizationRoleTable)
      .where(and(eq(OrganizationRoleTable.id, roleId), eq(OrganizationRoleTable.organizationId, payload.organization.id)))
      .limit(1)

    const roleRow = roleRows[0]
    if (!roleRow) {
      return c.json({ error: "role_not_found" }, 404)
    }

    const nextRoleName = input.roleName ? normalizeRoleName(input.roleName) : roleRow.role
    if (isProtectedOrganizationRoleName(roleRow.role) || isProtectedOrganizationRoleName(nextRoleName)) {
      return c.json({ error: "invalid_role", message: "Built-in roles are managed by the system." }, 400)
    }

    if (nextRoleName !== roleRow.role) {
      const duplicate = await db
        .select({ id: OrganizationRoleTable.id })
        .from(OrganizationRoleTable)
        .where(and(eq(OrganizationRoleTable.organizationId, payload.organization.id), eq(OrganizationRoleTable.role, nextRoleName)))
        .limit(1)
      if (duplicate[0]) {
        return c.json({ error: "role_exists", message: "That role name is already in use." }, 409)
      }
    }

    let requestedPermission: string | null = null
    if (input.permission !== undefined) {
      const validPermission = validateAssignableOrganizationPermissionRecord({
        permission: input.permission,
        roleValue: payload.currentMember.role,
        roles: payload.roles,
      })
      if (!validPermission.ok) {
        return c.json({ error: validPermission.error, message: validPermission.message }, 400)
      }
      requestedPermission = serializePermissionRecord(input.permission)
    }

    // One transaction for the role row and its rename cascade; the organization
    // share fence (when captured) precedes the role/member/invitation row locks.
    const capture = auditChangeCapture(c)
    const update = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(OrganizationRoleTable)
        .where(and(eq(OrganizationRoleTable.id, roleRow.id), eq(OrganizationRoleTable.organizationId, payload.organization.id)))
        .limit(1)
        .for("update")
      if (!locked) return null
      const roleName = input.roleName ? nextRoleName : locked.role
      const permissionValue = requestedPermission ?? locked.permission

      await tx
        .update(OrganizationRoleTable)
        .set({ role: roleName, permission: permissionValue })
        .where(eq(OrganizationRoleTable.id, locked.id))

      if (roleName !== locked.role) {
        const members = await tx
          .select()
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, payload.organization.id), isNull(MemberTable.removedAt)))

        for (const member of members) {
          if (!splitRoles(member.role).includes(locked.role)) {
            continue
          }

          await tx
            .update(MemberTable)
            .set({ role: replaceRoleValue(member.role, locked.role, roleName) })
            .where(eq(MemberTable.id, member.id))
        }

        const invitations = await tx
          .select()
          .from(InvitationTable)
          .where(and(
            eq(InvitationTable.organizationId, payload.organization.id),
            eq(InvitationTable.status, "pending"),
          ))

        for (const invitation of invitations) {
          if (!splitRoles(invitation.role).includes(locked.role)) {
            continue
          }

          await tx
            .update(InvitationTable)
            .set({ role: replaceRoleValue(invitation.role, locked.role, roleName) })
            .where(eq(InvitationTable.id, invitation.id))
        }
      }

      const auditEventIds = await appendDomainChanges(tx, capture, [roleUpdatedEvent(payload.organization.id, locked, { ...locked, role: roleName, permission: permissionValue })])
      return { previousRole: locked.role, nextRole: roleName, permissionChanged: permissionValue !== locked.permission, auditEventIds }
    })
    if (!update) {
      return c.json({ error: "role_not_found" }, 404)
    }

    if (update.permissionChanged) {
      await revokeCredentialsForOrganizationRoleMembers({
        organizationId: payload.organization.id,
        role: update.nextRole,
      })
    }

    await finishLegacyAuditAction(capture, {
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.roleUpdated,
      payload: {
        organizationRoleId: roleRow.id,
        previousRole: update.previousRole,
        nextRole: update.nextRole,
        roleRenamed: update.nextRole !== update.previousRole,
        permissionChanged: update.permissionChanged,
      },
    }, update.auditEventIds)

    return c.json({ success: true })
    },
  )

  app.delete(
    "/v1/roles/:roleId",
    describeRoute({
      tags: ["Roles"],
      summary: "Delete organization role",
      description: "Deletes a custom organization role after confirming that no members or pending invitations still depend on it.",
      responses: {
        204: emptyResponse("Organization role deleted successfully."),
        400: jsonResponse("The role deletion request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete organization roles.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and super-admins can delete custom roles.", forbiddenSchema),
        404: jsonResponse("The role or organization could not be found.", notFoundSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    paramValidator(orgRoleParamsSchema),
    async (c) => {
    const permission = ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can delete custom roles.")
    if (!permission.ok) {
      return c.json(permission.response, orgAccessFailureStatus(permission.response))
    }

    const payload = c.get("organizationContext")
    const params = c.req.valid("param")
    let roleId: OrganizationRoleId
    try {
      roleId = normalizeDenTypeId("organizationRole", params.roleId)
    } catch {
      return c.json({ error: "role_not_found" }, 404)
    }

    const roleRows = await db
      .select()
      .from(OrganizationRoleTable)
      .where(and(eq(OrganizationRoleTable.id, roleId), eq(OrganizationRoleTable.organizationId, payload.organization.id)))
      .limit(1)

    const roleRow = roleRows[0]
    if (!roleRow) {
      return c.json({ error: "role_not_found" }, 404)
    }

    if (isProtectedOrganizationRoleName(roleRow.role)) {
      return c.json({ error: "invalid_role", message: "Built-in roles are managed by the system." }, 400)
    }

    const membersUsingRole = await db
      .select({ role: MemberTable.role })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, payload.organization.id), isNull(MemberTable.removedAt)))

    if (membersUsingRole.some((member) => splitRoles(member.role).includes(roleRow.role))) {
      return c.json({ error: "role_in_use", message: "Update members using this role before deleting it." }, 400)
    }

    const invitationsUsingRole = await db
      .select({ role: InvitationTable.role })
      .from(InvitationTable)
      .where(and(
        eq(InvitationTable.organizationId, payload.organization.id),
        eq(InvitationTable.status, "pending"),
      ))

    if (invitationsUsingRole.some((invitation) => splitRoles(invitation.role).includes(roleRow.role))) {
      return c.json({
        error: "role_in_use",
        message: "Cancel or update pending invitations using this role before deleting it.",
      }, 400)
    }

    const capture = auditChangeCapture(c)
    const auditEventIds = await db.transaction(async (tx) => {
      const [locked] = capture
        ? await tx.select().from(OrganizationRoleTable).where(eq(OrganizationRoleTable.id, roleRow.id)).limit(1).for("update")
        : []
      await tx.delete(OrganizationRoleTable).where(eq(OrganizationRoleTable.id, roleRow.id))
      return locked ? appendDomainChanges(tx, capture, [roleDeletedEvent(payload.organization.id, locked)]) : []
    })
    await finishLegacyAuditAction(capture, {
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.roleDeleted,
      payload: {
        organizationRoleId: roleRow.id,
        role: roleRow.role,
      },
    }, auditEventIds)
    return c.body(null, 204)
    },
  )
}
