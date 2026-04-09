import { and, eq, gt } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, InvitationTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { sendDenOrganizationInvitationEmail } from "../../email.js"
import { jsonValidator, paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { getOrganizationLimitStatus } from "../../organization-limits.js"
import { listAssignableRoles } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"
import { buildInvitationLink, createInvitationId, ensureInviteManager, idParamSchema, normalizeRoleName, orgIdParamSchema } from "./shared.js"

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.string().trim().min(1).max(64),
})

const invitationResponseSchema = z.object({
  invitationId: denTypeIdSchema("invitation"),
  email: z.string().email(),
  role: z.string(),
  expiresAt: z.string().datetime(),
}).meta({ ref: "InvitationResponse" })

type InvitationId = typeof InvitationTable.$inferSelect.id
const orgInvitationParamsSchema = orgIdParamSchema.extend(idParamSchema("invitationId", "invitation").shape)

export function registerOrgInvitationRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:orgId/invitations",
    describeRoute({
      tags: ["Invitations"],
      summary: "Create organization invitation",
      description: "Creates or refreshes a pending organization invitation for an email address and sends the invite email.",
      responses: {
        200: jsonResponse("Existing invitation refreshed successfully.", invitationResponseSchema),
        201: jsonResponse("Invitation created successfully.", invitationResponseSchema),
        400: jsonResponse("The invitation request body or path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to invite organization members.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can create or resend invitations.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgIdParamSchema),
    resolveOrganizationContextMiddleware,
    jsonValidator(inviteMemberSchema),
    async (c) => {
    const permission = ensureInviteManager(c)
    if (!permission.ok) {
      return c.json(permission.response, permission.response.error === "forbidden" ? 403 : 404)
    }

    const payload = c.get("organizationContext")
    const user = c.get("user")
    const input = c.req.valid("json")

    const email = input.email.trim().toLowerCase()
    const availableRoles = await listAssignableRoles(payload.organization.id)
    const role = normalizeRoleName(input.role)
    if (!availableRoles.has(role)) {
      return c.json({ error: "invalid_role", message: "Choose one of the existing organization roles." }, 400)
    }

    const existingMembers = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, payload.organization.id), eq(AuthUserTable.email, email)))
      .limit(1)

    if (existingMembers[0]) {
      return c.json({
        error: "member_exists",
        message: "That email address is already a member of this organization.",
      }, 409)
    }

    const existingInvitation = await db
      .select()
      .from(InvitationTable)
      .where(
        and(
          eq(InvitationTable.organizationId, payload.organization.id),
          eq(InvitationTable.email, email),
          eq(InvitationTable.status, "pending"),
          gt(InvitationTable.expiresAt, new Date()),
        ),
      )
      .limit(1)

    if (!existingInvitation[0]) {
      const memberLimit = await getOrganizationLimitStatus(payload.organization.id, "members")
      if (memberLimit.exceeded) {
        return c.json({
          error: "org_limit_reached",
          limitType: "members",
          limit: memberLimit.limit,
          currentCount: memberLimit.currentCount,
          message: `This workspace currently supports up to ${memberLimit.limit} members. Contact support to increase the limit.`,
        }, 409)
      }
    }

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
    const invitationId = existingInvitation[0]?.id ?? createInvitationId()

    if (existingInvitation[0]) {
      await db
        .update(InvitationTable)
        .set({ role, inviterId: normalizeDenTypeId("user", user.id), expiresAt })
        .where(eq(InvitationTable.id, existingInvitation[0].id))
    } else {
      await db.insert(InvitationTable).values({
        id: invitationId,
        organizationId: payload.organization.id,
        email,
        role,
        status: "pending",
        inviterId: normalizeDenTypeId("user", user.id),
        expiresAt,
      })
    }

    await sendDenOrganizationInvitationEmail({
      email,
      inviteLink: buildInvitationLink(invitationId),
      invitedByName: user.name ?? user.email ?? "OpenWork",
      invitedByEmail: user.email ?? "",
      organizationName: payload.organization.name,
      role,
    })

    return c.json({ invitationId, email, role, expiresAt }, existingInvitation[0] ? 200 : 201)
    },
  )

  app.post(
    "/v1/orgs/:orgId/invitations/:invitationId/cancel",
    describeRoute({
      tags: ["Invitations"],
      summary: "Cancel organization invitation",
      description: "Cancels a pending organization invitation so the invite link can no longer be used.",
      responses: {
        200: jsonResponse("Invitation cancelled successfully.", successSchema),
        400: jsonResponse("The invitation cancellation path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to cancel invitations.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can cancel invitations.", forbiddenSchema),
        404: jsonResponse("The invitation or organization could not be found.", notFoundSchema),
      },
    }),
    requireUserMiddleware,
    paramValidator(orgInvitationParamsSchema),
    resolveOrganizationContextMiddleware,
    async (c) => {
    const permission = ensureInviteManager(c)
    if (!permission.ok) {
      return c.json(permission.response, permission.response.error === "forbidden" ? 403 : 404)
    }

    const payload = c.get("organizationContext")
    const params = c.req.valid("param")
    let invitationId: InvitationId
    try {
      invitationId = normalizeDenTypeId("invitation", params.invitationId)
    } catch {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    const invitationRows = await db
      .select({ id: InvitationTable.id })
      .from(InvitationTable)
      .where(and(eq(InvitationTable.id, invitationId), eq(InvitationTable.organizationId, payload.organization.id)))
      .limit(1)

    if (!invitationRows[0]) {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    await db.update(InvitationTable).set({ status: "canceled" }).where(eq(InvitationTable.id, invitationId))
    return c.json({ success: true })
    },
  )
}
