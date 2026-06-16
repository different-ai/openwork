import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, InvitationTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { db } from "../../db.js"
import { jsonValidator, orgRoleRoute, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { runPostOrganizationMemberChangeHooks } from "../../organization-member-hooks.js"
import { resolveOrganizationPermissionRecord, validateAssignableOrganizationPermissionRecord } from "../../organization-access.js"
import { isEmailAllowedForOrganization, listAssignableRoles, removeOrganizationMember } from "../../orgs.js"
import { getOrganizationSeatAddEligibility } from "../../stripe-billing.js"
import { DenEmailSendError, sendEmail } from "../../utils/email/send-email.js"
import type { OrgRouteVariables } from "./shared.js"
import { buildInvitationLink, createInvitationId, createInvitationToken, ensureInviteManager, idParamSchema, normalizeRoleName, orgAccessFailureStatus } from "./shared.js"

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.string().trim().min(1).max(64),
})

const invitationResponseSchema = z.object({
  invitationId: denTypeIdSchema("invitation"),
  email: z.string().email(),
  role: z.string(),
  expiresAt: z.string().datetime(),
  inviteToken: z.string(),
}).meta({ ref: "InvitationResponse" })

const invitationEmailFailedSchema = z.object({
  error: z.literal("invitation_email_failed"),
  reason: z.enum(["email_not_configured", "resend_rejected", "resend_network", "nodemailer_rejected"]),
  message: z.string(),
  invitationId: denTypeIdSchema("invitation"),
}).meta({ ref: "InvitationEmailFailedError" })

const inviteEmailDomainNotAllowedSchema = z.object({
  error: z.literal("invite_email_domain_not_allowed"),
  message: z.string(),
  emailDomain: z.string().nullable(),
  allowedEmailDomains: z.array(z.string()),
}).meta({ ref: "InviteEmailDomainNotAllowedError" })

const invitePaymentRequiredSchema = z.object({
  error: z.literal("payment_required"),
  reason: z.literal("seat_subscription_required"),
  subscriptionType: z.literal("seat"),
  currentCount: z.number(),
  freeSeatCount: z.number(),
  message: z.string(),
}).meta({ ref: "InvitePaymentRequiredError" })

type InvitationId = typeof InvitationTable.$inferSelect.id

const orgInvitationParamsSchema = idParamSchema("invitationId", "invitation")

export function registerOrgInvitationRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/invitations",
    describeRoute({
      tags: ["Invitations"],
      summary: "Create organization invitation",
      description: "Creates or refreshes a pending organization invitation for an email address and sends the invite email. Returns 502 when the invitation row is persisted but the configured email provider failed to send; the client should surface the error and give the user a retry affordance.",
      responses: {
        200: jsonResponse("Existing invitation refreshed successfully.", invitationResponseSchema),
        201: jsonResponse("Invitation created successfully.", invitationResponseSchema),
        400: jsonResponse("The invitation request body or path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to invite organization members.", unauthorizedSchema),
        402: jsonResponse("A seat subscription is required before inviting more members.", invitePaymentRequiredSchema),
        403: jsonResponse("Only workspace owners and admins can create invitations, and invitees can only receive roles whose permissions the inviter already has.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
        409: jsonResponse("The email address is outside this workspace's allowed domains.", inviteEmailDomainNotAllowedSchema),
        502: jsonResponse("The invitation was saved but the email provider rejected or failed to deliver it. Retry by submitting the same email again.", invitationEmailFailedSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    jsonValidator(inviteMemberSchema),
    async (c) => {
    const permission = ensureInviteManager(c)
    if (!permission.ok) {
      return c.json(permission.response, orgAccessFailureStatus(permission.response))
    }

    const payload = c.get("organizationContext")
    const user = c.get("user")
    const input = c.req.valid("json")

    const email = input.email.trim().toLowerCase()
    if (!isEmailAllowedForOrganization(payload.organization.allowedEmailDomains, email)) {
      const emailDomain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1) : null
      return c.json({
        error: "invite_email_domain_not_allowed",
        message:
          payload.organization.allowedEmailDomains && payload.organization.allowedEmailDomains.length === 1
            ? `This workspace only allows ${payload.organization.allowedEmailDomains[0]} email addresses.`
            : `This workspace only allows email addresses from these domains: ${(payload.organization.allowedEmailDomains ?? []).join(", ")}.`,
        emailDomain,
        allowedEmailDomains: payload.organization.allowedEmailDomains ?? [],
      }, 409)
    }

    const availableRoles = await listAssignableRoles(payload.organization.id)
    const role = normalizeRoleName(input.role)
    if (!availableRoles.has(role)) {
      return c.json({ error: "invalid_role", message: "Choose one of the existing organization roles." }, 400)
    }

    const assignableRole = validateAssignableOrganizationPermissionRecord({
      permission: resolveOrganizationPermissionRecord(role, payload.roles),
      roleValue: payload.currentMember.role,
      roles: payload.roles,
    })
    if (!assignableRole.ok) {
      return c.json({
        error: "forbidden",
        message: "You can only invite members into roles with permissions you already have.",
      }, 403)
    }

    const existingMembers = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
      .where(and(eq(MemberTable.organizationId, payload.organization.id), eq(AuthUserTable.email, email), isNull(MemberTable.removedAt)))
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
      const seatEligibility = await getOrganizationSeatAddEligibility(payload.organization.id)
      if (!seatEligibility.allowed) {
        return c.json({
          error: "payment_required",
          reason: "seat_subscription_required",
          subscriptionType: "seat",
          currentCount: seatEligibility.currentCount,
          freeSeatCount: seatEligibility.freeSeatCount,
          message: `This workspace includes ${seatEligibility.freeSeatCount} free members. Start seat billing before inviting another member.`,
        }, 402)
      }
    }

    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7)
    const invitationId = existingInvitation[0]?.id ?? createInvitationId()
    const inviteToken = createInvitationToken()
    let createdOrgMemberId: typeof MemberTable.$inferSelect.id | null = null
    let invitationOrgMemberId: typeof MemberTable.$inferSelect.id | null = null

    if (existingInvitation[0]) {
      await db
        .update(InvitationTable)
        .set({ role, inviterId: normalizeDenTypeId("user", user.id), orgMemberId: payload.currentMember.id, inviteToken, expiresAt })
        .where(eq(InvitationTable.id, existingInvitation[0].id))

      const invitedMemberRows = await db
        .select({ id: MemberTable.id })
        .from(MemberTable)
        .where(and(eq(MemberTable.inviteId, existingInvitation[0].id), eq(MemberTable.organizationId, payload.organization.id), isNull(MemberTable.removedAt)))
        .limit(1)

      if (invitedMemberRows[0]) {
        await db
          .update(MemberTable)
          .set({ role, invitedByOrgMember: payload.currentMember.id })
          .where(eq(MemberTable.id, invitedMemberRows[0].id))
        invitationOrgMemberId = invitedMemberRows[0].id
      } else {
        const memberId = createDenTypeId("member")
        await db.insert(MemberTable).values({
          id: memberId,
          organizationId: payload.organization.id,
          userId: null,
          inviteId: existingInvitation[0].id,
          invitedByOrgMember: payload.currentMember.id,
          role,
          joinedAt: null,
        })
        createdOrgMemberId = memberId
        invitationOrgMemberId = memberId
      }
    } else {
      await db.insert(InvitationTable).values({
        id: invitationId,
        organizationId: payload.organization.id,
        email,
        role,
        status: "pending",
        inviterId: normalizeDenTypeId("user", user.id),
        orgMemberId: payload.currentMember.id,
        inviteToken,
        expiresAt,
      })

      const memberId = createDenTypeId("member")
      await db.insert(MemberTable).values({
        id: memberId,
        organizationId: payload.organization.id,
        userId: null,
        inviteId: invitationId,
        invitedByOrgMember: payload.currentMember.id,
        role,
        joinedAt: null,
      })
      createdOrgMemberId = memberId
      invitationOrgMemberId = memberId
    }

    if (createdOrgMemberId) {
      await runPostOrganizationMemberChangeHooks({ organizationId: payload.organization.id, memberId: createdOrgMemberId, change: "added" })
    }

    await recordOrganizationAuditEvent({
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: existingInvitation[0]
        ? ORGANIZATION_AUDIT_ACTIONS.invitationRefreshed
        : ORGANIZATION_AUDIT_ACTIONS.invitationCreated,
      payload: {
        invitationId,
        targetOrgMembershipId: invitationOrgMemberId,
        targetEmail: email,
        role,
        expiresAt: expiresAt.toISOString(),
      },
    })

    try {
      await sendEmail({
        to: email,
        template: "organizationInvite",
        props: {
          inviteLink: buildInvitationLink(inviteToken),
          invitedByName: user.name ?? user.email ?? "OpenWork",
          invitedByEmail: user.email ?? "",
          organizationName: payload.organization.name,
          role,
        },
      })
    } catch (error) {
      if (error instanceof DenEmailSendError) {
        // The invitation row is already persisted (step above). Log at error
        // level so operators can grep, and return a 502 so the caller can
        // render a real failure instead of a silent success. The invitation
        // id is included so the UI can correlate and offer a direct retry.
        console.error(
          `[auth][invite_email_failed] organization=${payload.organization.id} invitation=${invitationId} email=${email} reason=${error.reason}${error.detail ? ` detail=${error.detail}` : ""}`,
        )

        return c.json({
          error: "invitation_email_failed" as const,
          reason: error.reason,
          message:
            error.reason === "email_not_configured"
              ? "The invitation email provider is not configured on this deployment."
              : error.reason === "resend_network"
                ? "Could not reach the invitation email provider. The invitation is saved; retry to send again."
                : `The invitation email provider rejected the send${error.detail ? `: ${error.detail}` : "."}`,
          invitationId,
        }, 502)
      }

      throw error
    }

    return c.json({ invitationId, email, role, expiresAt, inviteToken }, existingInvitation[0] ? 200 : 201)
    },
  )

  app.post(
    "/v1/invitations/:invitationId/cancel",
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
    orgRoleRoute(["admin"]),
    paramValidator(orgInvitationParamsSchema),
    async (c) => {
    const permission = ensureInviteManager(c)
    if (!permission.ok) {
      return c.json(permission.response, orgAccessFailureStatus(permission.response))
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
      .select({
        id: InvitationTable.id,
        email: InvitationTable.email,
        role: InvitationTable.role,
        status: InvitationTable.status,
      })
      .from(InvitationTable)
      .where(and(eq(InvitationTable.id, invitationId), eq(InvitationTable.organizationId, payload.organization.id)))
      .limit(1)

    if (!invitationRows[0]) {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    const invitedMemberRows = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.inviteId, invitationId), eq(MemberTable.organizationId, payload.organization.id), isNull(MemberTable.joinedAt), isNull(MemberTable.removedAt)))
      .limit(1)

    await db.update(InvitationTable).set({ status: "canceled" }).where(eq(InvitationTable.id, invitationId))

    const invitedMember = invitedMemberRows[0]
    if (invitedMember) {
      const removed = await removeOrganizationMember({
        organizationId: payload.organization.id,
        memberId: invitedMember.id,
        removedByOrgMemberId: payload.currentMember.id,
      })
      if (!removed.ok && removed.error !== "member_not_found") {
        return c.json({ error: removed.error, message: removed.message }, 400)
      }
    }

    await recordOrganizationAuditEvent({
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.invitationCanceled,
      payload: {
        invitationId: invitationRows[0].id,
        targetOrgMembershipId: invitedMember?.id ?? null,
        targetEmail: invitationRows[0].email,
        role: invitationRows[0].role,
        previousStatus: invitationRows[0].status,
      },
    })

    return c.json({ success: true })
    },
  )
}
