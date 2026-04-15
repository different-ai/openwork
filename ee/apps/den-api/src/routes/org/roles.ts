import { and, eq } from "@openwork-ee/den-db/drizzle"
import { InvitationTable, MemberTable, OrganizationRoleTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { serializePermissionRecord } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"
import { createRoleId, ensureOwner, idParamSchema, normalizeRoleName, orgIdParamSchema, replaceRoleValue, splitRoles } from "./shared.js"

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
const orgRoleParamsSchema = orgIdParamSchema.extend(idParamSchema("roleId", "organizationRole").shape)

export function registerOrgRoleRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:orgId/roles",
    describeRoute({
      tags: ["Roles"],
      summary: "Create organization role",
      description: "Creates a custom organization role with a named permission map.",
      responses: {
        201: jsonResponse("Organization role created successfully.", successSchema),
        400: jsonResponse("The role creation request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create organization roles.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can create custom roles.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(createRoleSchema),
    async (c) => {
    const permission = ensureOwner(c)
    if (!permission.ok) {
      return c.json(permission.response, 403)
    }

    const payload = c.get("organizationContext")
    const input = c.req.valid("json")

    const roleName = normalizeRoleName(input.roleName)
    if (roleName === "owner") {
      return c.json({ error: "invalid_role", message: "Owner is managed by the system." }, 400)
    }

    const existingByName = await db
      .select({ id: OrganizationRoleTable.id })
      .from(OrganizationRoleTable)
      .where(and(eq(OrganizationRoleTable.organizationId, payload.organization.id), eq(OrganizationRoleTable.role, roleName)))
      .limit(1)

    if (existingByName[0]) {
      return c.json({ error: "role_exists", message: "That role already exists in this organization." }, 409)
    }

    await db.insert(OrganizationRoleTable).values({
      id: createRoleId(),
      organizationId: payload.organization.id,
      role: roleName,
      permission: serializePermissionRecord(input.permission),
    })

    return c.json({ success: true }, 201)
    },
  )

  app.patch(
    "/v1/orgs/:orgId/roles/:roleId",
    describeRoute({
      tags: ["Roles"],
      summary: "Update organization role",
      description: "Updates a custom organization role and propagates role name changes to members and pending invitations.",
      responses: {
        200: jsonResponse("Organization role updated successfully.", successSchema),
        400: jsonResponse("The role update request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to update organization roles.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can update custom roles.", forbiddenSchema),
        404: jsonResponse("The role or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgRoleParamsSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(updateRoleSchema),
    async (c) => {
    const permission = ensureOwner(c)
    if (!permission.ok) {
      return c.json(permission.response, 403)
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
    if (nextRoleName === "owner") {
      return c.json({ error: "invalid_role", message: "Owner is managed by the system." }, 400)
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

    const nextPermission = input.permission ? serializePermissionRecord(input.permission) : roleRow.permission

    await db
      .update(OrganizationRoleTable)
      .set({ role: nextRoleName, permission: nextPermission })
      .where(eq(OrganizationRoleTable.id, roleRow.id))

    if (nextRoleName !== roleRow.role) {
      const members = await db
        .select()
        .from(MemberTable)
        .where(eq(MemberTable.organizationId, payload.organization.id))

      for (const member of members) {
        if (!splitRoles(member.role).includes(roleRow.role)) {
          continue
        }

        await db
          .update(MemberTable)
          .set({ role: replaceRoleValue(member.role, roleRow.role, nextRoleName) })
          .where(eq(MemberTable.id, member.id))
      }

      const invitations = await db
        .select()
        .from(InvitationTable)
        .where(eq(InvitationTable.organizationId, payload.organization.id))

      for (const invitation of invitations) {
        if (!splitRoles(invitation.role).includes(roleRow.role)) {
          continue
        }

        await db
          .update(InvitationTable)
          .set({ role: replaceRoleValue(invitation.role, roleRow.role, nextRoleName) })
          .where(eq(InvitationTable.id, invitation.id))
      }
    }

    return c.json({ success: true })
    },
  )

  app.delete(
    "/v1/orgs/:orgId/roles/:roleId",
    describeRoute({
      tags: ["Roles"],
      summary: "Delete organization role",
      description: "Deletes a custom organization role after confirming that no members or pending invitations still depend on it.",
      responses: {
        204: emptyResponse("Organization role deleted successfully."),
        400: jsonResponse("The role deletion request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to delete organization roles.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can delete custom roles.", forbiddenSchema),
        404: jsonResponse("The role or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgRoleParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
    const permission = ensureOwner(c)
    if (!permission.ok) {
      return c.json(permission.response, 403)
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

    const membersUsingRole = await db
      .select({ role: MemberTable.role })
      .from(MemberTable)
      .where(eq(MemberTable.organizationId, payload.organization.id))

    if (membersUsingRole.some((member) => splitRoles(member.role).includes(roleRow.role))) {
      return c.json({ error: "role_in_use", message: "Update members using this role before deleting it." }, 400)
    }

    const invitationsUsingRole = await db
      .select({ role: InvitationTable.role })
      .from(InvitationTable)
      .where(eq(InvitationTable.organizationId, payload.organization.id))

    if (invitationsUsingRole.some((invitation) => splitRoles(invitation.role).includes(roleRow.role))) {
      return c.json({
        error: "role_in_use",
        message: "Cancel or update pending invitations using this role before deleting it.",
      }, 400)
    }

    await db.delete(OrganizationRoleTable).where(eq(OrganizationRoleTable.id, roleRow.id))
    return c.body(null, 204)
    },
  )
}
