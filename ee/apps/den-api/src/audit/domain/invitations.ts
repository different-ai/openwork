import type { InvitationTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, relatedResource, targetResource, type AuditSnapshot } from "./snapshot.js"

// invitation.created / invitation.refreshed / invitation.canceled (legacy
// organization.invitation.*). The invitee email is kept because the legacy
// payload already stored it (targetEmail); `inviteToken` is a bearer join
// token and is never snapshotted (refresh rotation is not recorded either).

export type InvitationAuditRow = Pick<typeof InvitationTable.$inferSelect, "id" | "email" | "role" | "status" | "teamId" | "inviterId" | "orgMemberId" | "expiresAt">

export function serializeInvitation(row: InvitationAuditRow): AuditSnapshot {
  return {
    id: row.id, email: auditText(row.email), role: auditText(row.role), status: auditText(row.status, 32), teamId: row.teamId,
    invitedByUserId: row.inviterId, invitedByMemberId: row.orgMemberId, expiresAt: auditTime(row.expiresAt),
  }
}

function resources(organizationId: string, row: InvitationAuditRow, placeholderMemberId: string | null) {
  return [targetResource("invitation", row.id), organizationParent(organizationId), placeholderMemberId ? relatedResource("member", placeholderMemberId) : null]
}

export function invitationSavedEvent(input: { organizationId: string; before: InvitationAuditRow | null; after: InvitationAuditRow; placeholderMemberId: string | null }): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: input.before ? "invitation.refreshed" : "invitation.created", resources: resources(input.organizationId, input.after, input.placeholderMemberId),
    before: input.before ? serializeInvitation(input.before) : null, after: serializeInvitation(input.after),
  })
}

export function invitationCanceledEvent(input: { organizationId: string; before: InvitationAuditRow; placeholderMemberId: string | null }): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "invitation.canceled", resources: resources(input.organizationId, input.before, input.placeholderMemberId),
    before: serializeInvitation(input.before), after: serializeInvitation({ ...input.before, status: "canceled" }),
  })
}

/**
 * Invitee rejection (better-auth organization/reject-invitation): status only,
 * actor the invitee user (not a member). Never the email or the join token.
 */
export function invitationRejectedEvent(input: { organizationId: string; invitationId: string; beforeStatus: string }): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "invitation.rejected", resources: [targetResource("invitation", input.invitationId), organizationParent(input.organizationId)],
    before: { status: auditText(input.beforeStatus, 32) }, after: { status: "rejected" },
  })
}
