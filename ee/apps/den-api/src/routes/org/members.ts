import { and, eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { listAssignableRoles, removeOrganizationMember, roleIncludesOwner } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner, idParamSchema, normalizeRoleName, orgIdParamSchema } from "./shared.js"

const updateMemberRoleSchema = z.object({
  role: z.string().trim().min(1).max(64),
})

type MemberId = typeof MemberTable.$inferSelect.id
const orgMemberParamsSchema = orgIdParamSchema.extend(idParamSchema("memberId", "member").shape)

export function registerOrgMemberRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:orgId/members/:memberId/role",
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

    const memberRows = await db
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, payload.organization.id)))
      .limit(1)

    const member = memberRows[0]
    if (!member) {
      return c.json({ error: "member_not_found" }, 404)
    }

    if (roleIncludesOwner(member.role)) {
      return c.json({ error: "owner_role_locked", message: "The organization owner role cannot be changed." }, 400)
    }

    const role = normalizeRoleName(input.role)
    const availableRoles = await listAssignableRoles(payload.organization.id)
    if (!availableRoles.has(role)) {
      return c.json({ error: "invalid_role", message: "Choose one of the existing organization roles." }, 400)
    }

    await db.update(MemberTable).set({ role }).where(eq(MemberTable.id, member.id))
    return c.json({ success: true })
    },
  )

  app.delete(
    "/v1/orgs/:orgId/members/:memberId",
    describeRoute({
      tags: ["Members"],
      summary: "Remove organization member",
      description: "Removes a member from an organization while protecting the owner role from deletion.",
      responses: {
        204: emptyResponse("Member removed successfully."),
        400: jsonResponse("The member removal request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to remove organization members.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can remove members.", forbiddenSchema),
        404: jsonResponse("The member or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgMemberParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
    const permission = ensureOwner(c)
    if (!permission.ok) {
      return c.json(permission.response, 403)
    }

    const payload = c.get("organizationContext")
    const params = c.req.valid("param")
    let memberId: MemberId
    try {
      memberId = normalizeDenTypeId("member", params.memberId)
    } catch {
      return c.json({ error: "member_not_found" }, 404)
    }

    const memberRows = await db
      .select()
      .from(MemberTable)
      .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, payload.organization.id)))
      .limit(1)

    const member = memberRows[0]
    if (!member) {
      return c.json({ error: "member_not_found" }, 404)
    }

    if (roleIncludesOwner(member.role)) {
      return c.json({ error: "owner_role_locked", message: "The organization owner cannot be removed." }, 400)
    }

    await removeOrganizationMember({
      organizationId: payload.organization.id,
      memberId: member.id,
    })
    return c.body(null, 204)
    },
  )
}
