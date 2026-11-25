export const domainChangeEmitters: Readonly<Record<string, string>> = {
  "organization.benefit_setting.updated": "retired (organization grants)",
  "organization.benefit_grant.created": "retired (organization grants)",
  "organization.benefit_grant.revoked": "retired (organization grants)",
  "api_key.created": "audit/domain/api-keys.ts", "api_key.deleted": "audit/domain/api-keys.ts", "api_key.revoked": "audit/domain/api-keys.ts",
  "invitation.created": "audit/domain/invitations.ts", "invitation.refreshed": "audit/domain/invitations.ts", "invitation.canceled": "audit/domain/invitations.ts",
  "invitation.rejected": "audit/domain/invitations.ts",
  "role.created": "audit/domain/roles.ts", "role.updated": "audit/domain/roles.ts", "role.deleted": "audit/domain/roles.ts",
  "member.role_updated": "audit/domain/members.ts", "member.ownership_transferred": "audit/domain/members.ts", "member.removed": "audit/domain/members.ts",
  "scim_connection.token_rotated": "audit/domain/scim.ts", "scim_connection.deleted": "audit/domain/scim.ts", "scim_connection.reconciled": "audit/domain/scim.ts", "scim_group_mapping.updated": "audit/domain/scim.ts",
  "sso_connection.registered": "audit/domain/sso.ts", "sso_connection.enabled": "audit/domain/sso.ts", "sso_connection.disabled": "audit/domain/sso.ts", "sso_connection.deleted": "audit/domain/sso.ts",
  "sso_connection.renamed": "audit/domain/sso.ts",
  "organization.complimentary_access.granted": "audit/domain/organization-settings.ts", "organization.complimentary_access.revoked": "audit/domain/organization-settings.ts",
  "organization.dpa_signed.updated": "audit/domain/organization-settings.ts",
  "web_origin.approved": "audit/domain/web-origins.ts", "web_origin.removed": "audit/domain/web-origins.ts",
  "private_value.filled": "audit/domain/private-values.ts", "private_value.fill_declined": "audit/domain/private-values.ts",
  "private_value.fill_refused": "audit/domain/private-values.ts",
  "permission_set.created": "audit/domain/permissions.ts", "permission_set.permissions_changed": "audit/domain/permissions.ts", "permission_set.archived": "audit/domain/permissions.ts",
  "permission_set.renamed": "audit/domain/permissions.ts", "permission_set.teams_changed": "audit/domain/permissions.ts",
  "permission_set.members_changed": "audit/domain/permissions.ts",
  "agent_permission_policy.updated": "audit/domain/agent-permissions.ts", "agent_permission_policy.removed": "audit/domain/agent-permissions.ts",
  "managed_deployment.renamed": "audit/domain/managed-deployments.ts", "managed_deployment.configuration_change_requested": "audit/domain/managed-deployments.ts",
  "managed_deployment.configuration_change_withdrawn": "audit/domain/managed-deployments.ts",
  "oauth_token.issued": "audit/domain/oauth-tokens.ts", "oauth_token.revoked": "audit/domain/oauth-tokens.ts",
  "session.created": "audit/domain/sessions.ts", "session.revoked": "audit/domain/sessions.ts", "session.organization_entered": "audit/domain/sessions.ts",
  "session.handed_off": "audit/domain/sessions.ts", "desktop_handoff.created": "audit/domain/sessions.ts",
  "session.sign_in_failed": "audit/domain/sessions.ts",
  "account.profile_updated": "audit/domain/account.ts", "account.email_changed": "audit/domain/account.ts", "account.password_changed": "audit/domain/account.ts",
  "account.identity_linked": "audit/domain/account.ts", "account.identity_unlinked": "audit/domain/account.ts", "account.deleted": "audit/domain/account.ts",
  "account.provider_token.accessed": "audit/domain/account.ts",
}

export const domainEventCategories: Readonly<Record<string, "security" | "access">> = {
  "session.sign_in_failed": "security", "account.provider_token.accessed": "access",
  "private_value.filled": "access", "private_value.fill_declined": "access", "private_value.fill_refused": "security",
}

export const domainChangeEventTypes: readonly string[] = Object.keys(domainChangeEmitters).sort()
