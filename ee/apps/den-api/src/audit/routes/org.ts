// Org slice: tenant routes of the org/admin/platform inventory (r3). Organization context
// routes (orgMemberRoute/orgRoleRoute/orgPermissionRoute), platform-admin routes that target one org through a
// validated path param, and token/webhook routes whose handler proves the org after
// verification. Tenant-less routes of the same inventory live in ./platform.ts.
//
// Not declared here (generated elsewhere as domain_audit by the existing /v1/audit emitter):
//   GET /v1/audit/event-types, GET /v1/audit/export, GET /v1/audit/operations,
//   GET /v1/audit/operations/:operationId/events, GET /v1/audit/usage, PATCH /v1/audit/settings

import type { AuditRouteAttribution, AuditRouteClass, AuditRouteDeclaration, AuditRouteMethod } from "./types.js"

type Extra = Pick<AuditRouteDeclaration, "changeEvidence" | "external" | "jobOutcome" | "notes">

function route(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, attribution: AuditRouteAttribution, extra: Extra = {},
): AuditRouteDeclaration {
  return { method, path, class: auditClass, action, kind, resource: { type, idParam }, attribution, ...extra }
}

/** orgMemberRoute()/orgRoleRoute()/orgPermissionRoute(): organizationContext supplies org + member actor. */
function member(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, extra: Extra = {},
): AuditRouteDeclaration {
  return route(method, path, auditClass, action, kind, type, idParam, "org_context", extra)
}

const USER_ORGS = "orgMemberRoute({ useUserOrganizations: true }): resolveUserOrganizationsMiddleware calls beginUserOrganizationsAuditRequest with the active organization, which is always one of the caller's verified memberships (API-key org or X-OpenWork-Org-Id filtered to them, else the session active org); actor = user + that membership's member id. These handlers act only on that organization's rows (getWorkerByIdForOrg / listWorkersPage). No active organization: platform store."

/** orgMemberRoute({ useUserOrganizations: true }) routes; same org_context semantics via the verified membership list. */
function userOrgs(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, extra: Extra = {},
): AuditRouteDeclaration {
  return member(method, path, auditClass, action, kind, type, idParam, { ...extra, notes: extra.notes ? `${USER_ORGS} ${extra.notes}` : USER_ORGS })
}

/** adminRoute(): platform admin acting on the org named by :organizationId (actor admin user, origin platform_admin). */
function admin(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string,
  extra: Extra = {},
): AuditRouteDeclaration {
  return route(method, path, auditClass, action, "platform.admin.organization", "organization", "organizationId", "path:organizationId", extra)
}

/** Token/signature routes: the handler calls attributeAuditRequest() only after verification; notes name the proof. */
function handler(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, notes: string, extra: Omit<Extra, "notes"> = {},
): AuditRouteDeclaration {
  return route(method, path, auditClass, action, kind, type, idParam, "handler", { ...extra, notes })
}

const SCIM_PROOF = "Org proof: SCIM bearer token resolved by resolveRequestScimProvider() -> ScimProvider.organizationId (actor service scim:<providerId>); invalid tokens 401 before attribution (platform store)."
const SEAT_SYNC = "stripe (seat/web/inference quantity sync via runPostOrganizationMemberChangeHooks)"
const DOMAIN = (area: string) => `audit/domain/${area}.ts`

export const orgAuditRoutes: readonly AuditRouteDeclaration[] = [
  // API keys
  member("GET", "/v1/api-keys", "tenant_read", "api_key.list", "api_key.management", "api_key", null),
  member("POST", "/v1/api-keys", "tenant_change", "api_key.create", "api_key.management", "api_key", null, { changeEvidence: DOMAIN("api-keys"), notes: "Legacy organization.api_key.created. better-auth createApiKey write: after-snapshot appended in a fresh tx; plaintext key only in the response, never captured." }),
  member("DELETE", "/v1/api-keys/:apiKeyId", "tenant_change", "api_key.delete", "api_key.management", "api_key", "apiKeyId", { changeEvidence: DOMAIN("api-keys"), notes: "Legacy organization.api_key.deleted." }),

  // Desktop policies
  member("GET", "/v1/desktop-policies", "tenant_read", "desktop_policy.list", "desktop_policy.management", "desktop_policy", null),
  member("POST", "/v1/desktop-policies", "tenant_change", "desktop_policy.create", "desktop_policy.management", "desktop_policy", null),
  member("GET", "/v1/desktop-policies/:desktopPolicyId", "tenant_read", "desktop_policy.read", "desktop_policy.management", "desktop_policy", "desktopPolicyId"),
  member("PATCH", "/v1/desktop-policies/:desktopPolicyId", "tenant_change", "desktop_policy.update", "desktop_policy.management", "desktop_policy", "desktopPolicyId"),
  member("DELETE", "/v1/desktop-policies/:desktopPolicyId", "tenant_change", "desktop_policy.delete", "desktop_policy.management", "desktop_policy", "desktopPolicyId"),
  member("GET", "/v1/desktop-policies/by-key/:externalKey", "tenant_read", "desktop_policy.read_by_key", "desktop_policy.management", "desktop_policy", "externalKey"),
  member("PUT", "/v1/desktop-policies/by-key/:externalKey", "tenant_change", "desktop_policy.upsert_by_key", "desktop_policy.management", "desktop_policy", "externalKey"),
  member("DELETE", "/v1/desktop-policies/by-key/:externalKey", "tenant_change", "desktop_policy.delete_by_key", "desktop_policy.management", "desktop_policy", "externalKey"),
  member("GET", "/v1/agent-permissions", "tenant_read", "agent_permission.list", "agent_permission.management", "agent_permission_policy", null),
  member("PUT", "/v1/agent-permissions/everyone", "tenant_change", "agent_permission.everyone.update", "agent_permission.management", "agent_permission_policy", null),
  member("PUT", "/v1/agent-permissions/teams/:teamId", "tenant_change", "agent_permission.team.update", "agent_permission.management", "team", "teamId"),
  member("DELETE", "/v1/agent-permissions/teams/:teamId", "tenant_change", "agent_permission.team.delete", "agent_permission.management", "team", "teamId"),
  member("GET", "/v1/me/desktop-config", "tenant_read", "desktop_policy.effective.read", "desktop_policy.management", "desktop_policy", null),

  // Members and invitations
  member("POST", "/v1/members/:memberId/role", "tenant_change", "member.role.update", "member.management", "member", "memberId", { changeEvidence: DOMAIN("members"), notes: "Legacy organization.member.role_updated (only when changed); implicit API key revocation follows (api_key.revoked), session revocation is not snapshotted." }),
  member("POST", "/v1/members/:memberId/transfer-ownership", "tenant_change", "member.ownership.transfer", "member.management", "member", "memberId", { changeEvidence: DOMAIN("members"), notes: "Legacy organization.member.ownership_transferred; one event lists every member whose role changed. Implicit API key revocation follows (api_key.revoked)." }),
  member("DELETE", "/v1/members/:memberId", "tenant_external", "member.remove", "member.management", "member", "memberId", { changeEvidence: DOMAIN("members"), external: `${SEAT_SYNC}; google credential revocation`, notes: "Legacy organization.member.removed. removeOrganizationMember commits locally, then awaits Stripe quantity hooks; a 5xx may follow a committed removal." }),
  member("POST", "/v1/invitations", "tenant_external", "invitation.create", "invitation.management", "invitation", null, { changeEvidence: DOMAIN("invitations"), external: `resend (invitation email); ${SEAT_SYNC}`, notes: "Legacy organization.invitation.created / organization.invitation.refreshed. inviteToken is a bearer secret and is never snapshotted." }),
  member("POST", "/v1/invitations/:invitationId/cancel", "tenant_external", "invitation.cancel", "invitation.management", "invitation", "invitationId", { changeEvidence: DOMAIN("invitations"), external: SEAT_SYNC, notes: "Legacy organization.invitation.canceled; placeholder member removal is an alternate removeOrganizationMember path (members emitter)." }),

  // Roles

  // Permissions
  member("GET", "/v1/permissions/catalog", "tenant_read", "permission.catalog.read", "permission.management", "permission", null),
  member("GET", "/v1/permissions/sets", "tenant_read", "permission_set.list", "permission.management", "permission_set", null),
  member("POST", "/v1/permissions/sets", "tenant_change", "permission_set.create", "permission.management", "permission_set", null, { changeEvidence: DOMAIN("permissions"), notes: "Legacy organization.permission_set.created; creates the set, its team link and its allow rows in one transaction." }),
  member("GET", "/v1/permissions/sets/:permissionSetId", "tenant_read", "permission_set.read", "permission.management", "permission_set", "permissionSetId"),
  member("PUT", "/v1/permissions/sets/:permissionSetId/permissions", "tenant_change", "permission_set.permissions.update", "permission.management", "permission_set", "permissionSetId", { changeEvidence: DOMAIN("permissions"), notes: "Legacy organization.permission_set.permissions_changed (only when a status changed); append-only rows, granted/revoked keys annotated." }),
  member("GET", "/v1/permissions/sets/:permissionSetId/history", "tenant_read", "permission_set.history.read", "permission.management", "permission_set", "permissionSetId"),
  member("DELETE", "/v1/permissions/sets/:permissionSetId", "tenant_change", "permission_set.archive", "permission.management", "permission_set", "permissionSetId", { changeEvidence: DOMAIN("permissions"), notes: "Legacy organization.permission_set.archived; archives the team set and soft-removes its team link, never deletes." }),
  member("GET", "/v1/permissions/keys/:permissionKey", "tenant_read", "permission.read", "permission.management", "permission", "permissionKey"),
  member("GET", "/v1/members/:memberId/permissions", "tenant_read", "member.permissions.read", "permission.management", "member", "memberId"),

  // Teams
  member("POST", "/v1/teams", "tenant_change", "team.create", "team.management", "team", null),
  member("GET", "/v1/teams/:teamId", "tenant_read", "team.read", "team.management", "team", "teamId"),
  member("PATCH", "/v1/teams/:teamId", "tenant_change", "team.update", "team.management", "team", "teamId"),
  member("DELETE", "/v1/teams/:teamId", "tenant_change", "team.delete", "team.management", "team", "teamId"),
  member("GET", "/v1/teams/:teamId/plugin-access", "tenant_read", "team.plugin_access.list", "team.management", "team", "teamId"),
  member("GET", "/v1/teams/by-key/:externalKey", "tenant_read", "team.read_by_key", "team.management", "team", "externalKey"),
  member("PUT", "/v1/teams/by-key/:externalKey", "tenant_change", "team.upsert_by_key", "team.management", "team", "externalKey"),
  member("DELETE", "/v1/teams/by-key/:externalKey", "tenant_change", "team.delete_by_key", "team.management", "team", "externalKey"),

  // Organization settings
  member("GET", "/v1/org", "tenant_read", "organization.read", "organization.settings", "organization", null),
  member("PATCH", "/v1/org", "tenant_change", "organization.settings.update", "organization.settings", "organization", null, { notes: "Includes requireSso/allowedEmailDomains; brand icon URL validation fetch is incidental." }),
  route("DELETE", "/v1/org", "platform", "organization.delete", "organization.settings", "organization", null, "none", { notes: "Evidence is a platform_audit_event row (success and failure), written before the response is released, because the purge deletes the organization's tenant audit history (a failed insert is logged [platform-audit-lost] and does not fail the deletion): actor = authenticated user (+ API key), target = organization from the verified organizationContext (handler addAuditRequestResource before the purge; never request input). External effects: stripe (cancelOrganizationSubscriptions), linear (deletion ticket). No tenant intent is recorded." }),
  member("POST", "/v1/org/brand-assets", "tenant_change", "organization.brand_assets.update", "organization.settings", "organization", null),
  member("GET", "/v1/org/web-origins", "tenant_read", "web_origin.list", "web_origin.management", "web_origin", null),
  member("POST", "/v1/org/web-origins", "tenant_change", "web_origin.approve", "web_origin.management", "web_origin", null, { changeEvidence: DOMAIN("web-origins"), notes: "Legacy organization.web_origin.approved." }),
  member("DELETE", "/v1/org/web-origins/:webOriginId", "tenant_change", "web_origin.remove", "web_origin.management", "web_origin", "webOriginId", { changeEvidence: DOMAIN("web-origins"), notes: "Legacy organization.web_origin.removed." }),

  // SCIM management
  member("GET", "/v1/scim", "tenant_read", "scim.connection.read", "scim.configuration", "scim_connection", null),
  member("PATCH", "/v1/scim", "tenant_change", "scim.group_mapping.update", "scim.configuration", "scim_connection", null, { changeEvidence: DOMAIN("scim"), notes: "Legacy organization.scim.group_mapping_updated." }),
  member("DELETE", "/v1/scim", "tenant_change", "scim.connection.delete", "scim.configuration", "scim_connection", null, { changeEvidence: DOMAIN("scim"), notes: "Legacy organization.scim.connection_deleted." }),
  member("POST", "/v1/scim/reconcile", "tenant_change", "scim.reconcile", "scim.configuration", "scim_connection", null, { changeEvidence: DOMAIN("scim"), notes: "Legacy organization.scim.reconciliation_run (not an alert action); synchronous repairs." }),
  member("POST", "/v1/scim/token", "tenant_change", "scim.token.rotate", "scim.configuration", "scim_connection", null, { changeEvidence: DOMAIN("scim"), notes: "Legacy organization.scim.token_rotated. better-auth generateSCIMToken write; plaintext token only in the response." }),

  // SSO management
  member("GET", "/v1/sso", "tenant_read", "sso_connection.read", "sso.configuration", "sso_connection", null),
  member("GET", "/v1/sso/metadata", "tenant_read", "sso_connection.metadata.read", "sso.configuration", "sso_connection", null),
  member("POST", "/v1/sso/saml", "tenant_change", "sso_connection.saml.register", "sso.configuration", "sso_connection", null, { changeEvidence: DOMAIN("sso"), notes: "Legacy organization.sso.connection_registered (kind saml); better-auth registerSSOProvider write." }),
  member("POST", "/v1/sso/oidc", "tenant_external", "sso_connection.oidc.register", "sso.configuration", "sso_connection", null, { changeEvidence: DOMAIN("sso"), external: "oidc_idp (issuer discovery)", notes: "Legacy organization.sso.connection_registered (kind oidc); better-auth registerSSOProvider write." }),
  member("DELETE", "/v1/sso", "tenant_change", "sso_connection.delete", "sso.configuration", "sso_connection", null, { changeEvidence: DOMAIN("sso"), notes: "Legacy organization.sso.connection_deleted." }),
  member("POST", "/v1/sso/enable", "tenant_change", "sso_connection.enable", "sso.configuration", "sso_connection", null, { changeEvidence: DOMAIN("sso"), notes: "Legacy organization.sso.connection_enabled." }),
  member("POST", "/v1/sso/disable", "tenant_change", "sso_connection.disable", "sso.configuration", "sso_connection", null, { changeEvidence: DOMAIN("sso"), notes: "Legacy organization.sso.connection_disabled." }),
  member("POST", "/v1/sso/request-domain-verification", "tenant_change", "sso_domain.verification.request", "sso.configuration", "sso_connection", null, { notes: "Returns the DNS TXT verification value (not a credential)." }),
  member("POST", "/v1/sso/verify-domain", "tenant_external", "sso_domain.verify", "sso.configuration", "sso_connection", null, { external: "dns (TXT lookup)" }),
  member("POST", "/v1/sso/test", "tenant_change", "sso_test.create", "sso.configuration", "sso_test_intent", null),
  member("POST", "/v1/sso/test/:intentId/start", "tenant_external", "sso_test.start", "sso.configuration", "sso_test_intent", "intentId", { external: "sso_idp (better-auth signInSSO; OIDC discovery)" }),
  member("POST", "/v1/sso/test/:intentId/cancel", "tenant_change", "sso_test.cancel", "sso.configuration", "sso_test_intent", "intentId"),

  // Billing
  member("GET", "/v1/billing", "tenant_access", "billing.read", "billing.management", "billing", null, { notes: "includePortalUrl creates a Stripe billing portal session and returns its URL (billing.manage)." }),
  member("GET", "/v1/billing/web", "tenant_read", "billing.web.read", "billing.management", "billing", null),
  member("POST", "/v1/billing/stripe/checkout", "tenant_external", "billing.checkout.create", "billing.management", "billing_subscription", null, { external: "stripe (checkout session)" }),
  member("POST", "/v1/billing/stripe/checkout/sync", "tenant_external", "billing.subscription.sync", "billing.management", "billing_subscription", null, { external: "stripe (subscription fetch + local entitlement sync)" }),
  member("POST", "/v1/billing/stripe/portal", "tenant_external", "billing.portal.create", "billing.management", "billing", null, { external: "stripe (billing portal session)" }),

  // Cloud instance (OpenWork Web)
  member("GET", "/v1/cloud/instance", "tenant_job", "cloud_instance.open", "cloud.instance", "cloud_instance", null, { jobOutcome: "not_recorded: the instance start/wake/update completes asynchronously in src/workers/cloud-lifecycle.ts and worker-access.ts recovery; its terminal worker status is written by several independent paths (provisioning success/failure, reconciler, lifecycle failure, recovery) with no single completion point, so it stays on the worker/cloud runtime rows", notes: "GET that starts or wakes the instance and returns a signed browser URL; not a routine read." }),
  member("POST", "/v1/cloud/instance/retry", "tenant_job", "cloud_instance.retry", "cloud.instance", "cloud_instance", null, { jobOutcome: "not_recorded: the instance start/wake/update completes asynchronously in src/workers/cloud-lifecycle.ts and worker-access.ts recovery; its terminal worker status is written by several independent paths (provisioning success/failure, reconciler, lifecycle failure, recovery) with no single completion point, so it stays on the worker/cloud runtime rows" }),
  member("POST", "/v1/cloud/instance/update", "tenant_job", "cloud_instance.update", "cloud.instance", "cloud_instance", null, { jobOutcome: "not_recorded: the instance start/wake/update completes asynchronously in src/workers/cloud-lifecycle.ts and worker-access.ts recovery; its terminal worker status is written by several independent paths (provisioning success/failure, reconciler, lifecycle failure, recovery) with no single completion point, so it stays on the worker/cloud runtime rows" }),
  member("GET", "/v1/cloud/gateway/resolve", "tenant_job", "cloud_instance.gateway.resolve", "cloud.instance", "cloud_instance", null, { jobOutcome: "not_recorded: the instance start/wake/update completes asynchronously in src/workers/cloud-lifecycle.ts and worker-access.ts recovery; its terminal worker status is written by several independent paths (provisioning success/failure, reconciler, lifecycle failure, recovery) with no single completion point, so it stays on the worker/cloud runtime rows", notes: "Gateway shared secret, then orgMemberRoute for the end user. GET that starts/wakes the instance and returns the collaborator token to the gateway." }),

  // Workers
  userOrgs("GET", "/v1/workers", "tenant_read", "worker.list", "worker.management", "worker", null),
  userOrgs("DELETE", "/v1/workers/:id", "tenant_external", "worker.delete", "worker.management", "worker", "id", { external: "cloud_runtime (Daytona deprovision)" }),

  // Diagnostics
  member("GET", "/v1/diagnostics/egress", "tenant_read", "diagnostics.egress.read", "diagnostics", "diagnostic", null),
  member("POST", "/v1/diagnostics/egress", "tenant_external", "diagnostics.egress.run", "diagnostics", "diagnostic", null, { external: "diagnostics_origin (egress probe)" }),
  member("PUT", "/v1/diagnostics/egress/token", "tenant_change", "diagnostics.egress_token.update", "diagnostics", "diagnostic_credential", null, { notes: "Stores a diagnostics credential; never snapshotted." }),

  // Managed deployments (customer-cloud installs)
  member("GET", "/v1/managed-deployments/configuration", "tenant_read", "managed_deployment.configuration.read", "managed_deployment", "managed_deployment", null),
  member("GET", "/v1/managed-deployments", "tenant_read", "managed_deployment.list", "managed_deployment", "managed_deployment", null),
  member("POST", "/v1/managed-deployments", "tenant_change", "managed_deployment.create", "managed_deployment", "managed_deployment", null),
  member("DELETE", "/v1/managed-deployments/:deploymentId", "tenant_change", "managed_deployment.delete", "managed_deployment", "managed_deployment", "deploymentId", { notes: "Only never-approved records; installed deployments answer 409." }),
  member("POST", "/v1/managed-deployments/:deploymentId/launch", "tenant_change", "managed_deployment.launch.prepare", "managed_deployment", "managed_deployment", "deploymentId", { notes: "Prepares an approval link or account-checked command; nothing runs until the customer approves in their cloud." }),

  // Member-facing org reads and install distribution
  member("GET", "/v1/me/dashboards", "tenant_read", "dashboard.my.list", "dashboard.access", "dashboard", null),
  member("GET", "/v1/me/library", "tenant_read", "library.list", "library.access", "plugin", null),
  member("GET", "/v1/me/plugin-access", "tenant_read", "plugin_access.effective.list", "library.access", "plugin", null),
  member("GET", "/v1/me/install-config", "tenant_read", "install_config.read", "install.distribution", "organization", null),
  member("GET", "/v1/me/install/:platform", "tenant_access", "install_artifact.download", "install.distribution", "install_artifact", "platform"),
  member("POST", "/v1/orgs/:organizationId/install-links", "tenant_change", "install_link.create", "install.distribution", "install_link", null, { notes: "Path organizationId only seeds context; attribute to organizationContext. Returns the install token; rotate revokes older links." }),

  // Platform admin acting on one org (actor = admin user, origin platform_admin)
  admin("GET", "/v1/admin/organizations/:organizationId/capabilities", "tenant_read", "organization.capabilities.read"),
  admin("PUT", "/v1/admin/organizations/:organizationId/capabilities", "tenant_change", "organization.capabilities.update", { notes: "Sets or clears this organization's feature overrides (organization_feature, features registry). Can turn auditLogs itself on or off: capture is decided by the feature read before the write; when the request turns it off, the outcome falls back to platform evidence (audit_policy_changed). The admin MCP tool den_set_org_capability makes the same change (service action organization.capability.set)." }),
  admin("PATCH", "/v1/admin/organizations/:organizationId/plan", "tenant_change", "organization.plan.update"),
  admin("PATCH", "/v1/admin/organizations/:organizationId/free-seats", "tenant_external", "organization.free_seats.update", { external: "stripe (seat subscription quantity resync)" }),
  admin("PATCH", "/v1/admin/organizations/:organizationId/dpa", "tenant_change", "organization.dpa.update", { changeEvidence: DOMAIN("organization-settings"), notes: "Legacy organization.dpa_signed.updated; reason text is not snapshotted (reasonProvided only)." }),
  admin("PUT", "/v1/admin/organizations/:organizationId/openwork-web-access", "tenant_change", "organization.openwork_web_access.update", { changeEvidence: DOMAIN("organization-settings"), notes: "Legacy organization.openwork_web.complimentary_access_granted / _revoked; reason text is not snapshotted." }),

  // SCIM v2 provisioning (bearer token)
  handler("GET", "/api/auth/scim/v2/Schemas", "tenant_read", "scim.schema.list", "scim.provisioning", "scim_metadata", null, SCIM_PROOF),
  handler("GET", "/api/auth/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:Group", "tenant_read", "scim.schema.group.read", "scim.provisioning", "scim_metadata", null, SCIM_PROOF),
  handler("GET", "/api/auth/scim/v2/ResourceTypes", "tenant_read", "scim.resource_type.list", "scim.provisioning", "scim_metadata", null, SCIM_PROOF),
  handler("GET", "/api/auth/scim/v2/ResourceTypes/Group", "tenant_read", "scim.resource_type.group.read", "scim.provisioning", "scim_metadata", null, SCIM_PROOF),
  handler("GET", "/api/auth/scim/v2/Groups", "tenant_read", "scim_group.list", "scim.provisioning", "scim_group", null, SCIM_PROOF),
  handler("POST", "/api/auth/scim/v2/Groups", "tenant_change", "scim_group.create", "scim.provisioning", "scim_group", null, SCIM_PROOF),
  handler("GET", "/api/auth/scim/v2/Groups/:groupId", "tenant_read", "scim_group.read", "scim.provisioning", "scim_group", "groupId", SCIM_PROOF),
  handler("PUT", "/api/auth/scim/v2/Groups/:groupId", "tenant_change", "scim_group.replace", "scim.provisioning", "scim_group", "groupId", SCIM_PROOF),
  handler("PATCH", "/api/auth/scim/v2/Groups/:groupId", "tenant_change", "scim_group.patch", "scim.provisioning", "scim_group", "groupId", SCIM_PROOF),
  handler("DELETE", "/api/auth/scim/v2/Groups/:groupId", "tenant_change", "scim_group.delete", "scim.provisioning", "scim_group", "groupId", SCIM_PROOF),
  handler("POST", "/api/auth/scim/v2/Users", "tenant_change", "scim_user.create", "scim.provisioning", "scim_user", null, `${SCIM_PROOF} Membership sync adds the member without Stripe hooks.`),
  handler("PUT", "/api/auth/scim/v2/Users/:userId", "tenant_external", "scim_user.replace", "scim.provisioning", "scim_user", "userId", `${SCIM_PROOF} active=false deprovisions via removeOrganizationMember (members emitter).`, { changeEvidence: DOMAIN("members"), external: SEAT_SYNC }),
  handler("PATCH", "/api/auth/scim/v2/Users/:userId", "tenant_external", "scim_user.patch", "scim.provisioning", "scim_user", "userId", `${SCIM_PROOF} active=false deprovisions via removeOrganizationMember (members emitter).`, { changeEvidence: DOMAIN("members"), external: SEAT_SYNC }),
  handler("DELETE", "/api/auth/scim/v2/Users/:userId", "tenant_external", "scim_user.deprovision", "scim.provisioning", "scim_user", "userId", `${SCIM_PROOF} Deprovisions via removeOrganizationMember (members emitter) and writes a tombstone.`, { changeEvidence: DOMAIN("members"), external: SEAT_SYNC }),

  // Worker tokens
  handler("POST", "/v1/workers/:id/activity-heartbeat", "tenant_signal", "worker.activity.heartbeat", "worker.runtime", "worker", "id", "Org proof: activity-scope WorkerTokenTable match for :id -> worker org (actor service worker:<id>). High volume."),

  // Managed deployment installers and health agents (customer cloud identity)
  handler("POST", "/v1/managed-deployments/:deploymentId/runs/:runId/enroll", "tenant_signal", "managed_deployment.run.enroll", "managed_deployment.runtime", "managed_deployment_run", "runId", "Org proof: AWS-verified signed STS identity of the deployment's runner role and run challenge -> ManagedDeployment.org_id (actor service managed-deployment:<id>)."),
  handler("POST", "/v1/managed-deployments/:deploymentId/runs/:runId/events", "tenant_signal", "managed_deployment.run.event", "managed_deployment.runtime", "managed_deployment_run", "runId", "Org proof: run-scoped token hash for :runId -> ManagedDeployment.org_id (actor service managed-deployment:<id>)."),
  handler("POST", "/v1/managed-deployments/:deploymentId/heartbeat", "tenant_signal", "managed_deployment.health.report", "managed_deployment.runtime", "managed_deployment", "deploymentId", "Org proof: AWS-verified signed STS identity of the deployment's health role, bound to the body hash -> ManagedDeployment.org_id (actor service managed-deployment:<id>). Every 5 minutes per deployment."),

  // Install links and connect grants
  handler("GET", "/v1/install-config", "tenant_access", "install_link.resolve", "install.distribution", "install_link", null, "Org proof: install-link token (query) -> InstallLink.organizationId; actor service install_link:<installLinkId>; attributed before the connect handoff grant is minted."),
  handler("GET", "/v1/install/:platform", "tenant_access", "install_link.artifact.download", "install.distribution", "install_artifact", "platform", "Org proof: install-link token -> InstallLink.organizationId; actor service install_link:<installLinkId>."),
  handler("POST", "/v1/install-connect/preview", "tenant_access", "connect_grant.preview", "install.distribution", "connect_grant", null, "Org proof: connect grant code (body) -> grant's install link -> organization (previewDesktopConnectGrant, no consumption); actor service install_link:<installLinkId> (never the code or its hash)."),
  handler("POST", "/v1/install-connect/exchange", "tenant_access", "connect_grant.exchange", "install.distribution", "connect_grant", null, "Org proof: the grant is resolved without consuming it, attributed (actor service install_link:<installLinkId>), then the one-time exchange runs and returns connection claims."),
  handler("POST", "/v1/install-connect/status", "tenant_access", "connect_grant.status.read", "install.distribution", "connect_grant", null, "Org proof: connect grant code (body) -> grant's install link -> organization; actor service install_link:<installLinkId>. Polling; returns claims."),

  // Workspace bootstrap claims (provisional org)
  handler("GET", "/v1/bootstrap/workspace/:bootstrapId/claim", "tenant_read", "workspace_claim.read", "workspace.bootstrap", "workspace_bootstrap", "bootstrapId", "Org proof: preclaim assertion (Bearer JWT, readPreclaimAssertion) bound to :bootstrapId -> provisional org; actor = the setup agent user + setup member."),
  handler("POST", "/v1/bootstrap/workspace/:bootstrapId/claim", "tenant_change", "workspace_claim_code.create", "workspace.bootstrap", "workspace_bootstrap", "bootstrapId", "Org proof: preclaim assertion bound to :bootstrapId -> provisional org; actor = setup agent user + setup member. Returns a one-time claim user code."),
  handler("GET", "/v1/bootstrap/claim-codes/:userCode", "tenant_read", "workspace_claim_code.lookup", "workspace.bootstrap", "workspace_bootstrap", null, "Org proof: unexpired claim code -> provisional org; actor = session user (not yet a member). :userCode is a bearer claim code and is never used as the resource id."),
  handler("POST", "/v1/bootstrap/claim-codes/accept", "tenant_change", "workspace_claim_code.accept", "workspace.bootstrap", "organization", null, "Org proof: claim code lookup -> provisional org, attributed before the transfer transaction; session user (no member id yet) becomes owner (alternate member-creation/ownership path)."),
  handler("POST", "/v1/bootstrap/claims/accept", "tenant_change", "workspace_claim.accept", "workspace.bootstrap", "organization", null, "Org proof: pending claim token row -> provisional org (unlocked pre-read), attributed before the locking transfer transaction; session user becomes owner (alternate ownership path)."),

  // Device sign-in decision (session user, org chosen in the body)
  handler("POST", "/v1/auth/device/decision", "tenant_access", "auth.device_code.decide", "auth.device", "device_code", null, "Credential issuance: approval binds the CLI session to the chosen organization. Org proof: decideDeviceUserCode verifies the session user's active membership in body organizationId, then (beforeEffect) attributes org + user + member before the code is decided (fails closed). Denials and approvals without an organization stay in the platform store (user-scoped)."),

  // Invitation acceptance (session user, org from the invitation)
  handler("POST", "/v1/orgs/invitations/accept", "tenant_external", "invitation.accept", "invitation.management", "invitation", null, "Org proof: pending invitation row whose email matches the verified session user -> invitation.organizationId; attributed through acceptInvitationForUser beforeEffect (before any write). Actor = invitee user without a member id (not yet a member).", { external: SEAT_SYNC }),

  // Signed webhooks
  handler("POST", "/v1/webhooks/stripe", "tenant_external", "billing.webhook.apply", "billing.webhook", "billing_subscription", null, "Org proof: stripe-signature verified (constructEvent), then our org_subscriptions row for the event's subscription (or the seat row matching the setup checkout's customer) -> row.organization_id; attributed before the event is applied. A first checkout creates that row, so it is attributed phase after. Actor service stripe, origin webhook. Events with no stored mapping go to the platform store.", { external: "stripe (subscription re-fetch; web quantity sync)" }),
  handler("POST", "/v1/webhooks/connectors/github", "tenant_job", "github_connector.webhook.receive", "connector.webhook", "connector_instance", null, "Org proof: x-hub-signature-256 verified against the app secret, then installation id -> stored github ConnectorAccount rows -> org; attributed before enqueue/updates (actor service github, origin webhook). One installation linked to several organizations has no single tenant (the delivery fans out per org), so it stays in the platform store, as do ignored or unmapped deliveries.", { jobOutcome: "connector_sync.completed per enqueued sync event via src/workers/github-sync.ts:processDueGithubSyncEvents (job operation jobRunId = connector_sync_event id; see src/audit/job-outcomes.ts)" }),
]
