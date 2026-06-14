import { AuditEventTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"

export const ORGANIZATION_AUDIT_ACTIONS = {
  apiKeyCreated: "organization.api_key.created",
  apiKeyDeleted: "organization.api_key.deleted",
  invitationCreated: "organization.invitation.created",
  invitationRefreshed: "organization.invitation.refreshed",
  invitationCanceled: "organization.invitation.canceled",
  roleCreated: "organization.role.created",
  roleUpdated: "organization.role.updated",
  roleDeleted: "organization.role.deleted",
  memberRoleUpdated: "organization.member.role_updated",
  memberRemoved: "organization.member.removed",
  scimTokenRotated: "organization.scim.token_rotated",
  scimConnectionDeleted: "organization.scim.connection_deleted",
  ssoConnectionRegistered: "organization.sso.connection_registered",
  ssoConnectionDeleted: "organization.sso.connection_deleted",
}

type OrganizationAuditAction = typeof ORGANIZATION_AUDIT_ACTIONS[keyof typeof ORGANIZATION_AUDIT_ACTIONS]
type OrganizationAuditPayload = Record<string, string | number | boolean | null>

export function buildOrganizationAuditEvent(input: {
  organizationId: DenTypeId<"organization">
  actorUserId: typeof AuditEventTable.$inferInsert.actor_user_id
  action: OrganizationAuditAction
  payload?: OrganizationAuditPayload
}) {
  return {
    id: createDenTypeId("auditEvent"),
    org_id: normalizeDenTypeId("org", input.organizationId),
    worker_id: null,
    actor_user_id: input.actorUserId,
    action: input.action,
    payload: input.payload ?? null,
  }
}

export async function recordOrganizationAuditEvent(input: Parameters<typeof buildOrganizationAuditEvent>[0]) {
  const { db } = await import("./db.js")
  await db.insert(AuditEventTable).values(buildOrganizationAuditEvent(input))
}
