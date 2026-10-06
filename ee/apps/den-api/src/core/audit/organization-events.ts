import { canonicalAuditJson } from "@openwork-ee/den-db/audit-log"
import type { AuditEventInput, AuditEventTypeDeclaration, AuditKind, AuditSinkContext } from "./types.js"

// Stable action strings. They are the pre-W0-P09 legacy action names, kept so
// existing filters, docs and exports keep matching.
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
  scimGroupMappingUpdated: "organization.scim.group_mapping_updated",
  ssoConnectionRegistered: "organization.sso.connection_registered",
  ssoConnectionEnabled: "organization.sso.connection_enabled",
  ssoConnectionDisabled: "organization.sso.connection_disabled",
  ssoConnectionDeleted: "organization.sso.connection_deleted",
  webOriginApproved: "organization.web_origin.approved",
  webOriginRemoved: "organization.web_origin.removed",
  dpaSignedUpdated: "organization.dpa_signed.updated",
  openWorkWebComplimentaryAccessGranted: "organization.openwork_web.complimentary_access_granted",
  openWorkWebComplimentaryAccessRevoked: "organization.openwork_web.complimentary_access_revoked",
} as const

const A = ORGANIZATION_AUDIT_ACTIONS

// Owners are the modules that take these declarations into their manifests
// (W0-04 `auditEvents`). Until then the legacy audit-logs registration file
// registers them on their behalf.
export const ORGANIZATION_AUDIT_EVENT_TYPES = [
  { kind: "organization.api_key", owner: "core", actions: [A.apiKeyCreated, A.apiKeyDeleted], categories: ["security"], resources: ["api_key", "organization", "member"] },
  { kind: "organization.invitation", owner: "core", actions: [A.invitationCreated, A.invitationRefreshed, A.invitationCanceled], categories: ["security"], resources: ["invitation", "organization", "member"] },
  { kind: "organization.member", owner: "core", actions: [A.memberRoleUpdated, A.memberOwnershipTransferred, A.memberRemoved], categories: ["security"], resources: ["member", "organization", "user"] },
  { kind: "organization.role", owner: "advancedPermissions", actions: [A.roleCreated, A.roleUpdated, A.roleDeleted], categories: ["security"], resources: ["organization_role", "organization"] },
  { kind: "organization.web_origin", owner: "webOrigins", actions: [A.webOriginApproved, A.webOriginRemoved], categories: ["security"], resources: ["web_origin", "organization"] },
  { kind: "organization.scim", owner: "enterpriseAuth.scim", actions: [A.scimTokenRotated, A.scimGroupMappingUpdated, A.scimConnectionDeleted, A.scimReconciliationRun], categories: ["security", "execution"], resources: ["scim_connection", "organization"] },
  { kind: "organization.sso", owner: "enterpriseAuth.sso", actions: [A.ssoConnectionRegistered, A.ssoConnectionEnabled, A.ssoConnectionDisabled, A.ssoConnectionDeleted], categories: ["security"], resources: ["sso_connection", "organization"] },
  { kind: "platform_admin.organization", owner: "core", actions: [A.dpaSignedUpdated, A.openWorkWebComplimentaryAccessGranted, A.openWorkWebComplimentaryAccessRevoked], categories: ["change"], resources: ["organization"] },
] as const satisfies readonly AuditEventTypeDeclaration[]

export function organizationRouteAuditContext(
  input: { organizationId: string; userId: string; memberId: string; credentialId?: string | null; requestId?: string | null },
  kind: AuditKind,
  scope: string,
): AuditSinkContext {
  return {
    organizationId: input.organizationId,
    actor: { type: "user", id: input.userId, memberId: input.memberId, ...(input.credentialId ? { credentialId: input.credentialId } : {}) },
    origin: "api",
    requestId: input.requestId ?? null,
    kind,
    scope,
  }
}

/** Platform admins are usually not organization members, so no memberId. */
export function platformAdminAuditContext(input: { organizationId: string; adminUserId: string; requestId?: string | null }): AuditSinkContext {
  return {
    organizationId: input.organizationId,
    actor: { type: "user", id: input.adminUserId },
    origin: "platform_admin",
    requestId: input.requestId ?? null,
    kind: "platform_admin.organization",
    scope: input.organizationId,
  }
}

/** A related resource reference, or none when the id is missing. */
export function relatedAuditResource(type: string, id: string | null | undefined): AuditEventInput["resources"] {
  return id ? [{ type, id, relationship: "related" }] : []
}

/**
 * Free text (for example a platform admin's reason) as audit evidence. Evidence
 * validation rejects bearer-like values, which would otherwise fail an atomic
 * capture and roll back the change, so such text is withheld instead.
 */
export function auditFreeText(value: string): string {
  try {
    canonicalAuditJson({ value }, true)
    return value
  } catch {
    return "[withheld: matched a credential pattern]"
  }
}
