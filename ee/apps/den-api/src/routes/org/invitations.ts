import { and, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, InvitationTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"
import { invitationCanceledEvent, invitationSavedEvent } from "../../audit/domain/invitations.js"
import { appendDomainChanges, finishLegacyAuditAction } from "../../audit/domain/legacy.js"
import { addAuditRequestResource, auditChangeCapture } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { invitationBillingUrl } from "../../agent-links.js"
import { invitationHasAdminTeam, withOrganizationTeamMutation } from "../../organization-team-roles.js"
import { jsonValidator, orgPermissionRoute, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, successSchema, unauthorizedSchema } from "../../openapi.js"
import { appLogger } from "../../observability/logger.js"
import { runPostOrganizationMemberChangeHooks } from "../../organization-member-hooks.js"
import { ORGANIZATION_ADMIN_ROLE, ORGANIZATION_MEMBER_ROLE, ORGANIZATION_OWNER_ROLE } from "../../organization-role-hierarchy.js"
import { isEmailAllowedForOrganization, listAssignableRoles, removeOrganizationMember } from "../../orgs.js"
import type { PermissionDatabase } from "@openwork-ee/den-db/permissions"
import { roleAssignmentDeniedHeaders, roleAssignmentDeniedResponse, roleAssignmentDenial, roleAssignmentDenialInTransaction, type RoleAssignmentDenial } from "../../permissions/team-grants.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { getOrganizationSeatAddEligibility } from "../../stripe-billing.js"
import { DenEmailSendError, sendEmail } from "../../utils/email/send-email.js"
import type { OrgRouteVariables } from "./shared.js"
import {
  buildInvitationLink,
  createInvitationId,
  createInvitationToken,
  idParamSchema,
  memberPermissionsForRequest,
  normalizeRoleName,
  orgAccessFailureStatus,
  permissionDeniedResponse,
  permissionFailureHeaders,
  requirePermission,
  splitRoles,
  type PermissionCheckFailure,
  type PermissionRouteContext,
} from "./shared.js"

const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.string().trim().min(1).max(64),
})
const logger = appLogger.child({ component: "invitations" })

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
  billingUrl: z.string().url().describe("Open in a browser to start seat billing; an owner can finish it there, then retry the invitation."),
}).meta({ ref: "InvitePaymentRequiredError" })

const invitationNotPendingSchema = z.object({
  error: z.literal("invitation_not_pending"),
  message: z.string(),
  status: z.string(),
}).meta({ ref: "InvitationNotPendingError" })

type InvitationId = typeof InvitationTable.$inferSelect.id

const orgInvitationParamsSchema = idParamSchema("invitationId", "invitation")

type InvitationRoleValidation =
  | { ok: true; role: string }
  | { ok: false; error: "invalid_role" | "forbidden"; message: string }
  | { ok: false; error: "permission"; response: PermissionCheckFailure }
  | { ok: false; error: "role_assignment"; denial: RoleAssignmentDenial }

/**
 * Whether the caller may invite someone as an admin (role-assignment rules). With the root
 * database it is the quick pre-transaction check, read once per request. With the invitation's
 * write transaction it decides again through it: the caller's permissions are re-resolved and the
 * Admin default set is re-read under share locks, so a concurrent Admin permissions edit
 * serializes with the write (roleAssignmentDenialInTransaction).
 */
type AdminInvitationCheck = (database: PermissionDatabase) => Promise<RoleAssignmentDenial | null | "organization_not_found">

function adminInvitationCheck(c: PermissionRouteContext): AdminInvitationCheck {
  let preTransaction: Promise<RoleAssignmentDenial | null | "organization_not_found"> | null = null
  return async (database) => {
    const payload = c.get("organizationContext")
    if (!payload) return "organization_not_found"
    if (database !== db) {
      return roleAssignmentDenialInTransaction({
        tx: database,
        organizationId: payload.organization.id,
        callerMemberId: payload.currentMember.id,
        target: null,
        nextRole: ORGANIZATION_ADMIN_ROLE,
      })
    }
    preTransaction ??= (async () => {
      const caller = await memberPermissionsForRequest(c)
      if (!caller) return "organization_not_found"
      return roleAssignmentDenial({
        organizationId: payload.organization.id,
        caller,
        callerMemberId: payload.currentMember.id,
        target: null,
        nextRole: ORGANIZATION_ADMIN_ROLE,
        database,
      })
    })()
    return preTransaction
  }
}

const BUILT_IN_INVITATION_ROLES: ReadonlySet<string> = new Set([ORGANIZATION_MEMBER_ROLE, ORGANIZATION_ADMIN_ROLE])

/**
 * Which role an invitation may carry. The route marker already requires
 * `invitations.manage`; any role other than `member` also needs
 * `members.update`, and with Permissions on an admin invitation needs every
 * Admin default permission (src/permissions/role-assignment.ts). Only Member
 * and Admin can be assigned. `database` is the open transaction, if any:
 * inside it `members.update` is re-checked against the caller's permissions
 * resolved through it, and the admin rule is decided through it too
 * (adminInvitationCheck), so a permission change committed after the route
 * check is seen before the invitation is written.
 */
async function validateInvitationRole(c: PermissionRouteContext, input: {
  role: string
  availableRoles: ReadonlySet<string>
  adminCheck: AdminInvitationCheck
  database: PermissionDatabase
}): Promise<InvitationRoleValidation> {
  const requestedRoles = splitRoles(input.role || ORGANIZATION_MEMBER_ROLE)
    .map((role) => normalizeRoleName(role))
    .filter(Boolean)
  const roleValue = requestedRoles[0] ? requestedRoles.join(",") : ORGANIZATION_MEMBER_ROLE

  if (requestedRoles.includes(ORGANIZATION_OWNER_ROLE)) {
    return { ok: false, error: "forbidden", message: "Owner can only be assigned by the Den ownership transfer API." }
  }
  if (roleValue === ORGANIZATION_MEMBER_ROLE) {
    return { ok: true, role: ORGANIZATION_MEMBER_ROLE }
  }

  const permission = await requirePermission(c, "members.update")
  if (!permission.ok) return { ok: false, error: "permission", response: permission.response }
  if (input.database !== db) {
    const payload = c.get("organizationContext")
    if (!payload) return { ok: false, error: "permission", response: { error: "organization_not_found" } }
    const held = await resolvePermissionsForMember({ organizationId: payload.organization.id, memberId: payload.currentMember.id, database: input.database })
    if (!held.has("members.update")) return { ok: false, error: "permission", response: permissionDeniedResponse("members.update") }
  }

  if (requestedRoles.some((role) => !input.availableRoles.has(role) || !BUILT_IN_INVITATION_ROLES.has(role))) {
    return { ok: false, error: "invalid_role", message: "Choose Member or Admin." }
  }

  if (requestedRoles.includes(ORGANIZATION_ADMIN_ROLE)) {
    const denial = await input.adminCheck(input.database)
    if (denial === "organization_not_found") return { ok: false, error: "permission", response: { error: "organization_not_found" } }
    if (denial) return { ok: false, error: "role_assignment", denial }
  }

  return { ok: true, role: roleValue }
}

export function registerOrgInvitationRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/invitations",
    describeRoute({
      tags: ["Invitations"],
      summary: "Create organization invitation",
      description: "Creates or refreshes a pending organization invitation for an email address and sends the invite email. Returns 502 when the invitation row is persisted but the configured email provider failed to send; the client should surface the error and give the user a retry affordance. Returns 402 with billingUrl when the workspace has used its free members: give the user billingUrl to start seat billing, then invite again.",
      responses: {
        200: jsonResponse("Existing invitation refreshed successfully.", invitationResponseSchema),
        201: jsonResponse("Invitation created successfully.", invitationResponseSchema),
        400: jsonResponse("The invitation request body or path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to invite organization members.", unauthorizedSchema),
        402: jsonResponse("A seat subscription is required before inviting more members. The body includes billingUrl, where an owner starts seat billing.", invitePaymentRequiredSchema),
        403: jsonResponse("The caller needs the Invite people permission and a recent sign-in. Inviting with a role other than member also needs Change member roles, and with Permissions on inviting an admin needs every Admin permission; reusing an invitation with Admin team access needs Manage Admin teams.", forbiddenSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
        409: jsonResponse("The email address is outside this workspace's allowed domains.", inviteEmailDomainNotAllowedSchema),
        502: jsonResponse("The invitation was saved but the email provider rejected or failed to deliver it. Retry by submitting the same email again.", invitationEmailFailedSchema),
      },
    }),
    orgPermissionRoute("invitations.manage"),
    jsonValidator(inviteMemberSchema),
    async (c) => {
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
    const adminCheck = adminInvitationCheck(c)
    const assignableRole = await validateInvitationRole(c, {
      role,
      availableRoles,
      adminCheck,
      database: db,
    })
    if (!assignableRole.ok) {
      if (assignableRole.error === "permission") {
        return c.json(assignableRole.response, orgAccessFailureStatus(assignableRole.response), permissionFailureHeaders(assignableRole.response))
      }
      if (assignableRole.error === "role_assignment") {
        return c.json(roleAssignmentDeniedResponse(assignableRole.denial), 403, roleAssignmentDeniedHeaders(assignableRole.denial))
      }
      if (assignableRole.error === "invalid_role") {
        return c.json({ error: assignableRole.error, message: assignableRole.message }, 400)
      }
      return c.json({ error: assignableRole.error, message: assignableRole.message }, 403)
    }
    const assignedRole = assignableRole.role

    const capture = auditChangeCapture(c)
    const invitationWrite = await db.transaction(async (tx) => {
      await tx
        .select({ id: OrganizationTable.id })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, payload.organization.id))
        .for("update")

      const existingInvitationRows = await tx
        .select()
        .from(InvitationTable)
        .where(
          and(
            eq(InvitationTable.organizationId, payload.organization.id),
            eq(InvitationTable.email, email),
          ),
        )
        .orderBy(desc(InvitationTable.createdAt))
        .for("update")
      const existingInvitation = existingInvitationRows.find((row) => row.status === "pending") ?? null

      const existingMembers = await tx
        .select({ id: MemberTable.id })
        .from(MemberTable)
        .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
        .where(and(eq(MemberTable.organizationId, payload.organization.id), eq(AuthUserTable.email, email), isNull(MemberTable.removedAt)))
        .limit(1)
        .for("update")
      if (existingMembers[0]) {
        return { status: "member_exists" as const }
      }

      if (existingInvitation) {
        if (await invitationHasAdminTeam(tx, existingInvitation)) {
          const permission = await requirePermission(c, "teams.manage_admin")
          if (!permission.ok) return { status: "team_forbidden" as const, response: permission.response }
        }
        const refreshRole = await validateInvitationRole(c, {
          role: normalizeRoleName(existingInvitation.role),
          availableRoles,
          adminCheck,
          database: tx,
        })
        if (!refreshRole.ok) {
          return { status: "role_error" as const, validation: refreshRole }
        }
      } else {
        const seatEligibility = await getOrganizationSeatAddEligibility(payload.organization.id)
        if (!seatEligibility.allowed) {
          return { status: "payment_required" as const, seatEligibility }
        }
      }

      // The role was allowed before the transaction; validate it again through the transaction
      // (members.update and, for admin, the role-assignment rule) so a permission or Admin
      // permissions change committed since is seen before the invitation is written.
      const writeRole = await validateInvitationRole(c, { role: assignedRole, availableRoles, adminCheck, database: tx })
      if (!writeRole.ok) return { status: "role_error" as const, validation: writeRole }

      const now = new Date()
      const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7)
      const invitationId = existingInvitation?.id ?? createInvitationId()
      const inviteToken = existingInvitation?.inviteToken && existingInvitation.expiresAt > now
        ? existingInvitation.inviteToken
        : createInvitationToken()
      let createdOrgMemberId: typeof MemberTable.$inferSelect.id | null = null
      let invitationOrgMemberId: typeof MemberTable.$inferSelect.id | null = null

      if (existingInvitation) {
        await tx
          .update(InvitationTable)
          .set({ role: assignedRole, inviterId: normalizeDenTypeId("user", user.id), orgMemberId: payload.currentMember.id, inviteToken, expiresAt })
          .where(and(eq(InvitationTable.id, existingInvitation.id), eq(InvitationTable.status, "pending")))

        const invitedMemberRows = await tx
          .select({ id: MemberTable.id })
          .from(MemberTable)
          .where(and(eq(MemberTable.inviteId, existingInvitation.id), eq(MemberTable.organizationId, payload.organization.id), isNull(MemberTable.removedAt)))
          .limit(1)

        if (invitedMemberRows[0]) {
          await tx
            .update(MemberTable)
            .set({ role: assignedRole, invitedByOrgMember: payload.currentMember.id })
            .where(eq(MemberTable.id, invitedMemberRows[0].id))
          invitationOrgMemberId = invitedMemberRows[0].id
        } else {
          const memberId = createDenTypeId("member")
          await tx.insert(MemberTable).values({
            id: memberId,
            organizationId: payload.organization.id,
            userId: null,
            inviteId: existingInvitation.id,
            invitedByOrgMember: payload.currentMember.id,
            role: assignedRole,
            joinedAt: null,
          })
          createdOrgMemberId = memberId
          invitationOrgMemberId = memberId
        }
      } else {
        await tx.insert(InvitationTable).values({
          id: invitationId,
          organizationId: payload.organization.id,
          email,
          role: assignedRole,
          status: "pending",
          inviterId: normalizeDenTypeId("user", user.id),
          orgMemberId: payload.currentMember.id,
          inviteToken,
          expiresAt,
        })

        const memberId = createDenTypeId("member")
        await tx.insert(MemberTable).values({
          id: memberId,
          organizationId: payload.organization.id,
          userId: null,
          inviteId: invitationId,
          invitedByOrgMember: payload.currentMember.id,
          role: assignedRole,
          joinedAt: null,
        })
        createdOrgMemberId = memberId
        invitationOrgMemberId = memberId
      }

      // Organization row is already locked FOR UPDATE above; append last.
      const inviterId = normalizeDenTypeId("user", user.id)
      const auditEventIds = await appendDomainChanges(tx, capture, [invitationSavedEvent({
        organizationId: payload.organization.id,
        before: existingInvitation,
        after: existingInvitation
          ? { ...existingInvitation, role: assignedRole, inviterId, orgMemberId: payload.currentMember.id, expiresAt }
          : { id: invitationId, email, role: assignedRole, status: "pending", teamId: null, inviterId, orgMemberId: payload.currentMember.id, expiresAt },
        placeholderMemberId: invitationOrgMemberId,
      })])

      return {
        status: "saved" as const,
        auditEventIds,
        createdOrgMemberId,
        expiresAt,
        invitationId,
        invitationOrgMemberId,
        inviteToken,
        refreshed: Boolean(existingInvitation),
      }
    })

    if (invitationWrite.status === "member_exists") {
      return c.json({
        error: "member_exists",
        message: "That email address is already a member of this organization.",
      }, 409)
    }
    if (invitationWrite.status === "team_forbidden") {
      return c.json(invitationWrite.response, orgAccessFailureStatus(invitationWrite.response), permissionFailureHeaders(invitationWrite.response))
    }
    if (invitationWrite.status === "role_error") {
      const validation = invitationWrite.validation
      if (validation.error === "permission") {
        return c.json(validation.response, orgAccessFailureStatus(validation.response), permissionFailureHeaders(validation.response))
      }
      if (validation.error === "role_assignment") {
        return c.json(roleAssignmentDeniedResponse(validation.denial), 403, roleAssignmentDeniedHeaders(validation.denial))
      }
      if (validation.error === "invalid_role") {
        return c.json({ error: validation.error, message: validation.message }, 400)
      }
      return c.json({ error: validation.error, message: validation.message }, 403)
    }
    if (invitationWrite.status === "payment_required") {
      const { seatEligibility } = invitationWrite
      return c.json({
        error: "payment_required",
        reason: "seat_subscription_required",
        subscriptionType: "seat",
        currentCount: seatEligibility.currentCount,
        freeSeatCount: seatEligibility.freeSeatCount,
        message: `This workspace includes ${seatEligibility.freeSeatCount} free seats. Start seat billing at ${invitationBillingUrl()} to invite more people.`,
        billingUrl: invitationBillingUrl(),
      }, 402)
    }

    const {
      auditEventIds,
      createdOrgMemberId,
      expiresAt,
      invitationId,
      invitationOrgMemberId,
      inviteToken,
      refreshed,
    } = invitationWrite
    addAuditRequestResource(c, { type: "invitation", id: invitationId })

    if (createdOrgMemberId) {
      await runPostOrganizationMemberChangeHooks({ organizationId: payload.organization.id, memberId: createdOrgMemberId, change: "added" })
    }

    await finishLegacyAuditAction(capture, {
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: refreshed
        ? ORGANIZATION_AUDIT_ACTIONS.invitationRefreshed
        : ORGANIZATION_AUDIT_ACTIONS.invitationCreated,
      payload: {
        invitationId,
        targetOrgMembershipId: invitationOrgMemberId,
        targetEmail: email,
        role: assignedRole,
        expiresAt: expiresAt.toISOString(),
      },
    }, auditEventIds)

    try {
      await sendEmail({
        to: email,
        template: "organizationInvite",
        props: {
          inviteLink: buildInvitationLink(inviteToken),
          invitedByName: user.name ?? user.email ?? "OpenWork",
          invitedByEmail: user.email ?? "",
          organizationName: payload.organization.name,
          role: assignedRole,
        },
      })
    } catch (error) {
      if (error instanceof DenEmailSendError) {
        // The invitation row is already persisted (step above). Log at error
        // level so operators can grep, and return a 502 so the caller can
        // render a real failure instead of a silent success. The invitation
        // id is included so the UI can correlate and offer a direct retry.
        logger.error("invite email failed", {
          organization_id: payload.organization.id,
          invitation_id: invitationId,
          reason: error.reason,
          detail: error.detail,
        })

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

    return c.json({ invitationId, email, role: assignedRole, expiresAt, inviteToken }, refreshed ? 200 : 201)
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
        403: jsonResponse("The caller needs the Invite people permission and a recent sign-in; invitations with Admin team access also need Manage Admin teams.", forbiddenSchema),
        404: jsonResponse("The invitation or organization could not be found.", notFoundSchema),
        409: jsonResponse("The invitation is no longer pending and cannot be canceled.", invitationNotPendingSchema),
      },
    }),
    orgPermissionRoute("invitations.manage"),
    paramValidator(orgInvitationParamsSchema),
    async (c) => {
    const payload = c.get("organizationContext")
    const params = c.req.valid("param")
    let invitationId: InvitationId
    try {
      invitationId = normalizeDenTypeId("invitation", params.invitationId)
    } catch {
      return c.json({ error: "invitation_not_found" }, 404)
    }

    const capture = auditChangeCapture(c)
    const cancellation = await withOrganizationTeamMutation(payload.organization.id, async (tx) => {
      const invitationRows = await tx
        .select({
          id: InvitationTable.id,
          email: InvitationTable.email,
          role: InvitationTable.role,
          status: InvitationTable.status,
          organizationId: InvitationTable.organizationId,
          teamId: InvitationTable.teamId,
          inviterId: InvitationTable.inviterId,
          orgMemberId: InvitationTable.orgMemberId,
          expiresAt: InvitationTable.expiresAt,
        })
        .from(InvitationTable)
        .where(and(eq(InvitationTable.id, invitationId), eq(InvitationTable.organizationId, payload.organization.id)))
        .for("update")
      const invitation = invitationRows[0] ?? null
      if (!invitation) {
        return { status: "not_found" as const }
      }
      if (invitation.status !== "pending") {
        return { status: "not_pending" as const, invitation }
      }
      if (await invitationHasAdminTeam(tx, invitation)) {
        const permission = await requirePermission(c, "teams.manage_admin")
        if (!permission.ok) return { status: "team_forbidden" as const, response: permission.response }
      }

      const invitedMemberRows = await tx
        .select({ id: MemberTable.id })
        .from(MemberTable)
        .where(and(eq(MemberTable.inviteId, invitationId), eq(MemberTable.organizationId, payload.organization.id), isNull(MemberTable.joinedAt), isNull(MemberTable.removedAt)))
        .limit(1)

      await tx
        .update(InvitationTable)
        .set({ status: "canceled" })
        .where(and(eq(InvitationTable.id, invitationId), eq(InvitationTable.status, "pending")))

      const auditEventIds = await appendDomainChanges(tx, capture, [invitationCanceledEvent({
        organizationId: payload.organization.id, before: invitation, placeholderMemberId: invitedMemberRows[0]?.id ?? null,
      })])

      return {
        status: "canceled" as const,
        auditEventIds,
        invitation,
        invitedMember: invitedMemberRows[0] ?? null,
      }
    })

    if (cancellation.status === "not_found") {
      return c.json({ error: "invitation_not_found" }, 404)
    }
    if (cancellation.status === "team_forbidden") {
      return c.json(cancellation.response, orgAccessFailureStatus(cancellation.response), permissionFailureHeaders(cancellation.response))
    }

    if (cancellation.status === "not_pending") {
      return c.json({
        error: "invitation_not_pending",
        message: "Only pending invitations can be canceled.",
        status: cancellation.invitation.status,
      }, 409)
    }

    const invitedMember = cancellation.invitedMember
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

    await finishLegacyAuditAction(capture, {
      organizationId: payload.organization.id,
      actorUserId: payload.currentMember.userId,
      action: ORGANIZATION_AUDIT_ACTIONS.invitationCanceled,
      payload: {
        invitationId: cancellation.invitation.id,
        targetOrgMembershipId: invitedMember?.id ?? null,
        targetEmail: cancellation.invitation.email,
        role: cancellation.invitation.role,
        previousStatus: cancellation.invitation.status,
      },
    }, cancellation.auditEventIds)

    return c.json({ success: true })
    },
  )
}
