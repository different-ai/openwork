// Event types appended by domain emitters (src/audit/domain/*) through
// appendAuditChanges or the user-membership fan-out (src/audit/fanout.ts);
// change category unless domainEventCategories says otherwise. Every emitted action must be listed here so the
// event-type catalog (GET /v1/audit/event-types) can filter it; the coverage
// script checks that every LEGACY_ACTION_BRIDGE target is registered.

/**
 * Emitter module per domain change action. api_key.revoked is not a legacy
 * bridge target: implicit revocation when a member's role, ownership or
 * membership changes (revokeOrganizationApiKeysForMember; enabled → false).
 */
export const domainChangeEmitters: Readonly<Record<string, string>> = {
  "api_key.created": "audit/domain/api-keys.ts", "api_key.deleted": "audit/domain/api-keys.ts", "api_key.revoked": "audit/domain/api-keys.ts",
  "invitation.created": "audit/domain/invitations.ts", "invitation.refreshed": "audit/domain/invitations.ts", "invitation.canceled": "audit/domain/invitations.ts",
  "invitation.rejected": "audit/domain/invitations.ts",
  "role.created": "audit/domain/roles.ts", "role.updated": "audit/domain/roles.ts", "role.deleted": "audit/domain/roles.ts",
  "member.role_updated": "audit/domain/members.ts", "member.ownership_transferred": "audit/domain/members.ts", "member.removed": "audit/domain/members.ts",
  "scim_connection.token_rotated": "audit/domain/scim.ts", "scim_connection.deleted": "audit/domain/scim.ts", "scim_connection.reconciled": "audit/domain/scim.ts", "scim_group_mapping.updated": "audit/domain/scim.ts",
  "sso_connection.registered": "audit/domain/sso.ts", "sso_connection.enabled": "audit/domain/sso.ts", "sso_connection.disabled": "audit/domain/sso.ts", "sso_connection.deleted": "audit/domain/sso.ts",
  "organization.complimentary_access.granted": "audit/domain/organization-settings.ts", "organization.complimentary_access.revoked": "audit/domain/organization-settings.ts",
  "organization.dpa_signed.updated": "audit/domain/organization-settings.ts",
  "web_origin.approved": "audit/domain/web-origins.ts", "web_origin.removed": "audit/domain/web-origins.ts",
  "permission_set.created": "audit/domain/permissions.ts", "permission_set.permissions_changed": "audit/domain/permissions.ts", "permission_set.archived": "audit/domain/permissions.ts", "permission_set.rules_changed": "audit/domain/permissions.ts",
  // Organization-bound MCP OAuth tokens (consent referenceId; src/audit/better-auth.ts).
  "oauth_token.issued": "audit/domain/oauth-tokens.ts", "oauth_token.revoked": "audit/domain/oauth-tokens.ts",
  // User-scoped events (attribution user_memberships, src/audit/fanout.ts).
  "session.created": "audit/domain/sessions.ts", "session.revoked": "audit/domain/sessions.ts", "session.organization_entered": "audit/domain/sessions.ts",
  "session.handed_off": "audit/domain/sessions.ts", "desktop_handoff.created": "audit/domain/sessions.ts",
  "session.sign_in_failed": "audit/domain/sessions.ts",
  "account.profile_updated": "audit/domain/account.ts", "account.email_changed": "audit/domain/account.ts", "account.password_changed": "audit/domain/account.ts",
  "account.identity_linked": "audit/domain/account.ts", "account.identity_unlinked": "audit/domain/account.ts", "account.deleted": "audit/domain/account.ts",
  "account.provider_token.accessed": "audit/domain/account.ts",
}

/** Non-change categories of domain events (everything else is "change"). */
export const domainEventCategories: Readonly<Record<string, "security" | "access">> = {
  "session.sign_in_failed": "security", "account.provider_token.accessed": "access",
}

export const domainChangeEventTypes: readonly string[] = Object.keys(domainChangeEmitters).sort()
