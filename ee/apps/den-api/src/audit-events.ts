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
  memberOwnershipTransferred: "organization.member.ownership_transferred",
  memberRemoved: "organization.member.removed",
  scimTokenRotated: "organization.scim.token_rotated",
  scimConnectionDeleted: "organization.scim.connection_deleted",
  scimReconciliationRun: "organization.scim.reconciliation_run",
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

type OrganizationAuditEvent = ReturnType<typeof buildOrganizationAuditEvent>

export function isOrganizationAuditAlertAction(action: OrganizationAuditAction) {
  switch (action) {
    case ORGANIZATION_AUDIT_ACTIONS.apiKeyCreated:
    case ORGANIZATION_AUDIT_ACTIONS.apiKeyDeleted:
    case ORGANIZATION_AUDIT_ACTIONS.invitationCreated:
    case ORGANIZATION_AUDIT_ACTIONS.invitationRefreshed:
    case ORGANIZATION_AUDIT_ACTIONS.invitationCanceled:
    case ORGANIZATION_AUDIT_ACTIONS.roleCreated:
    case ORGANIZATION_AUDIT_ACTIONS.roleUpdated:
    case ORGANIZATION_AUDIT_ACTIONS.roleDeleted:
    case ORGANIZATION_AUDIT_ACTIONS.memberRoleUpdated:
    case ORGANIZATION_AUDIT_ACTIONS.memberRemoved:
    case ORGANIZATION_AUDIT_ACTIONS.scimTokenRotated:
    case ORGANIZATION_AUDIT_ACTIONS.scimConnectionDeleted:
    case ORGANIZATION_AUDIT_ACTIONS.ssoConnectionRegistered:
    case ORGANIZATION_AUDIT_ACTIONS.ssoConnectionDeleted:
      return true
    case ORGANIZATION_AUDIT_ACTIONS.scimReconciliationRun:
      return false
  }
}

export function buildOrganizationAuditAlertLogLine(event: OrganizationAuditEvent) {
  return `[audit-alert] ${JSON.stringify({
    auditEventId: event.id,
    organizationId: event.org_id,
    actorUserId: event.actor_user_id,
    action: event.action,
    payload: event.payload,
  })}`
}

export async function recordOrganizationAuditEvent(input: Parameters<typeof buildOrganizationAuditEvent>[0]) {
  const { db } = await import("./db.js")
  const event = buildOrganizationAuditEvent(input)
  await db.insert(AuditEventTable).values(event)
  if (isOrganizationAuditAlertAction(event.action)) {
    console.warn(buildOrganizationAuditAlertLogLine(event))
  }
}
