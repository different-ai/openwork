import type { ORGANIZATION_AUDIT_ACTIONS } from "../audit-events.js"

type LegacyOrganizationAuditAction = typeof ORGANIZATION_AUDIT_ACTIONS[keyof typeof ORGANIZATION_AUDIT_ACTIONS]

/**
 * Single-writer bridge: when tenant capture is active for a request the domain
 * emitter appends the operation change event on the right instead of the legacy
 * audit_event row; otherwise the legacy row is written unchanged. Historical
 * legacy rows are never backfilled or counted.
 */
export const LEGACY_ACTION_BRIDGE: Readonly<Record<LegacyOrganizationAuditAction, string>> = {
  "organization.api_key.created": "api_key.created",
  "organization.api_key.deleted": "api_key.deleted",
  "organization.invitation.created": "invitation.created",
  "organization.invitation.refreshed": "invitation.refreshed",
  "organization.invitation.canceled": "invitation.canceled",
  "organization.role.created": "role.created",
  "organization.role.updated": "role.updated",
  "organization.role.deleted": "role.deleted",
  "organization.member.role_updated": "member.role_updated",
  "organization.member.ownership_transferred": "member.ownership_transferred",
  "organization.member.removed": "member.removed",
  "organization.scim.token_rotated": "scim_connection.token_rotated",
  "organization.scim.connection_deleted": "scim_connection.deleted",
  "organization.scim.reconciliation_run": "scim_connection.reconciled",
  "organization.scim.group_mapping_updated": "scim_group_mapping.updated",
  "organization.sso.connection_registered": "sso_connection.registered",
  "organization.sso.connection_enabled": "sso_connection.enabled",
  "organization.sso.connection_disabled": "sso_connection.disabled",
  "organization.sso.connection_deleted": "sso_connection.deleted",
  "organization.openwork_web.complimentary_access_granted": "organization.complimentary_access.granted",
  "organization.openwork_web.complimentary_access_revoked": "organization.complimentary_access.revoked",
  "organization.dpa_signed.updated": "organization.dpa_signed.updated",
  "organization.web_origin.approved": "web_origin.approved",
  "organization.web_origin.removed": "web_origin.removed",
  "organization.permission_set.created": "permission_set.created",
  "organization.permission_set.permissions_changed": "permission_set.permissions_changed",
  "organization.permission_set.archived": "permission_set.archived",
}
