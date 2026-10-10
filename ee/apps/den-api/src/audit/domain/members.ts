import type { MemberTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, relatedResource, targetResource, type AuditSnapshot } from "./snapshot.js"

// member.role_updated / member.ownership_transferred / member.removed (legacy
// organization.member.*). Every path that changes or removes a member uses
// these builders: the members routes, invitation cancel (placeholder member),
// SCIM deprovisioning (removeOrganizationMember) and, through
// memberRemovedEvent, better-auth organization hooks.

export type MemberAuditRow = Pick<typeof MemberTable.$inferSelect, "id" | "userId" | "role" | "joinedAt" | "inviteId">

export function serializeMember(row: MemberAuditRow): AuditSnapshot {
  return { id: row.id, userId: row.userId, role: auditText(row.role), joinedAt: auditTime(row.joinedAt), invitationId: row.inviteId }
}

function memberResources(organizationId: string, memberId: string) {
  return [targetResource("member", memberId), organizationParent(organizationId)]
}

export function memberRoleUpdatedEvent(organizationId: string, before: MemberAuditRow, nextRole: string): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "member.role_updated", resources: memberResources(organizationId, before.id), before: serializeMember(before), after: serializeMember({ ...before, role: nextRole }) })
}

/**
 * One event for the whole transfer: target the new owner, relate every member
 * whose role changed, and record owner ids plus each changed member's role.
 */
export function memberOwnershipTransferredEvent(input: {
  organizationId: string
  newOwner: MemberAuditRow
  newOwnerRole: string
  demoted: readonly { member: MemberAuditRow; nextRole: string }[]
}): AuditChangeEventInput | null {
  const changed = [{ member: input.newOwner, nextRole: input.newOwnerRole }, ...input.demoted].sort((a, b) => a.member.id.localeCompare(b.member.id))
  const roles = (pick: "before" | "after") => changed.map(({ member, nextRole }) => ({ id: member.id, userId: member.userId, role: auditText(pick === "before" ? member.role : nextRole) }))
  return auditChangeEvent({
    action: "member.ownership_transferred",
    resources: [...memberResources(input.organizationId, input.newOwner.id), ...input.demoted.map(({ member }) => relatedResource("member", member.id))],
    before: { ownerMemberIds: input.demoted.map(({ member }) => member.id).sort(), members: roles("before") },
    after: { ownerMemberIds: [input.newOwner.id], members: roles("after") },
  })
}

/** Reusable for every removal path (soft delete: after is null). */
export function memberRemovedEvent(input: { organizationId: string; member: MemberAuditRow; removedByMemberId?: string | null; reasonCode?: string }): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "member.removed",
    resources: [...memberResources(input.organizationId, input.member.id), input.removedByMemberId && input.removedByMemberId !== input.member.id ? relatedResource("member", input.removedByMemberId) : null],
    before: serializeMember(input.member), after: null, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  })
}
