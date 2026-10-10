// Platform slice: routes of the org/admin/platform inventory (r3) with no trustworthy tenant:
// public discovery, auth helpers, session-only user routes, global platform-admin routes,
// operational probes, app.use middleware entries, the legacy org proxy and the MCP consumption transports.
//
// Not declared here: the better-auth catch-alls `DELETE|GET|PATCH|POST|PUT /api/auth/*`
// (declared per concrete better-auth endpoint in ./auth.ts) and the six /v1/audit/* routes
// (domain_audit, see ./org.ts).

import { MCP_CONSUMPTION_EXCLUSIONS, OPERATIONAL_EXCLUSIONS, type AuditRouteClass, type AuditRouteDeclaration, type AuditRouteMethod } from "./types.js"

function route(
  method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string,
  type: string, idParam: string | null, notes?: string,
): AuditRouteDeclaration {
  return { method, path, class: auditClass, action, kind, resource: { type, idParam }, attribution: "none", ...(notes ? { notes } : {}) }
}

function platform(method: AuditRouteMethod, path: string, action: string, kind: string, type: string, idParam: string | null, notes?: string): AuditRouteDeclaration {
  return route(method, path, "platform", action, kind, type, idParam, notes)
}

/** Side-effect-free platform GET (pure metadata, docs, discovery or session read): successes need the platformAuditReads feature. */
function readOnly(path: string, action: string, kind: string, type: string, idParam: string | null, notes?: string): AuditRouteDeclaration {
  return { ...platform("GET", path, action, kind, type, idParam, notes), readOnly: true }
}

/** Platform request evidence; the emitter appends events about the user into the user's verified memberships. */
function userScoped(method: AuditRouteMethod, path: string, action: string, kind: string, type: string, changeEvidence: string, notes: string): AuditRouteDeclaration {
  return { method, path, class: "platform", action, kind, resource: { type, idParam: null }, attribution: "user_memberships", changeEvidence, notes }
}

/** Tenant-class route whose handler (or a better-auth hook it forwards to) attributes the tenant after verification. */
function handler(method: AuditRouteMethod, path: string, auditClass: AuditRouteClass, action: string, kind: string, type: string, notes: string, changeEvidence?: string): AuditRouteDeclaration {
  return { method, path, class: auditClass, action, kind, resource: { type, idParam: null }, attribution: "handler", ...(changeEvidence ? { changeEvidence } : {}), notes }
}

const RAW_REFUSED = "Refused for every caller (403; 401 without a session). The refused attempt is attributed (attribution refusal: no .requested intent, so audit can never change the 403) to the organization the body names (organizationId), else the session's active organization, ONLY when the session user is an active member there: <action>.attempted, outcome denied, reasonCode raw_endpoint_refused, category security when selected. Otherwise, including a foreign organization, it stays platform evidence."

function support(method: AuditRouteMethod, path: string, action: string, notes: string): AuditRouteDeclaration {
  return route(method, path, "support", action, "request.pipeline", "middleware", null, notes)
}

function mcp(method: AuditRouteMethod, path: string, action: string): AuditRouteDeclaration {
  const exclusion = MCP_CONSUMPTION_EXCLUSIONS.find((entry) => entry.method === method && entry.path === path)
  return route(method, path, "mcp_consumption", action, "mcp.transport", "mcp_transport", null, exclusion?.reason ?? "MCP consumption transport.")
}

function operational(path: string, action: string): AuditRouteDeclaration {
  const exclusion = OPERATIONAL_EXCLUSIONS.find((entry) => entry.method === "GET" && entry.path === path)
  return route("GET", path, "excluded_operational", action, "platform.operational", "service", null, exclusion?.reason ?? "Operational probe.")
}

const ADMIN = "adminRoute(): platform admin acting across tenants; no single tenant."

export const platformAuditRoutes: readonly AuditRouteDeclaration[] = [
  // app.use middleware entries (not endpoints)
  support("ALL", "/*", "request.pipeline", "Global middleware stack (observability, request id, headers, access log, CORS, sessionMiddleware, audit request capture)."),
  support("ALL", "/v1/*", "request.preclaim_scope", "preclaimScopeMiddleware: denies provisional agent users outside their bootstrap scope."),
  support("ALL", "/api/auth/scim/v2/*", "scim.diagnostics", "SCIM diagnostics middleware (timing logs only); concrete SCIM v2 routes are declared in ./org.ts."),
  support("ALL", "/api/auth/sso/saml2/callback/*", "sso.saml_callback.policy", "samlResponsePolicyMiddleware before better-auth; the endpoint itself is declared with the better-auth endpoints."),
  support("ALL", "/api/auth/sso/saml2/sp/acs/*", "sso.saml_acs.policy", "samlResponsePolicyMiddleware before better-auth ACS; the endpoint itself is declared with the better-auth endpoints."),
  support("ALL", "/v1/auth/desktop-handoff/exchange", "desktop_handoff.cors", "Reflecting CORS middleware for the grant exchange (only when !env.corsHandledByEdge)."),

  // app.fetch re-dispatch
  route("ALL", "/v1/orgs/:orgId/*", "proxy", "legacy_org.proxy", "request.proxy", "organization", "orgId", "delegatedRoute legacy org proxy re-dispatches through app.fetch; the destination route records."),

  // MCP consumption transports (MCP_CONSUMPTION_EXCLUSIONS only)
  mcp("ALL", "/mcp", "mcp.transport"),
  mcp("ALL", "/mcp/agent", "mcp_agent.transport"),
  mcp("ALL", "/mcp/agent/connections/:connectionId", "mcp_agent.connection.proxy"),
  mcp("ALL", "/mcp/admin", "mcp_admin.transport"),
  mcp("GET", "/mcp/.well-known/oauth-protected-resource", "mcp.protected_resource.read"),
  mcp("GET", "/mcp/agent/.well-known/oauth-protected-resource", "mcp_agent.protected_resource.read"),
  mcp("GET", "/mcp/admin/.well-known/oauth-protected-resource", "mcp_admin.protected_resource.read"),

  // Operational probes (OPERATIONAL_EXCLUSIONS only): excluded from audit logs
  operational("/", "service.root"),
  operational("/health", "health.check"),
  operational("/ready", "readiness.check"),

  // Public discovery and metadata
  readOnly("/.well-known/oauth-authorization-server", "discovery.oauth_authorization_server.read", "platform.discovery", "discovery_document", null),
  readOnly("/.well-known/oauth-authorization-server/api/auth", "discovery.oauth_authorization_server.issuer_suffix.read", "platform.discovery", "discovery_document", null),
  readOnly("/api/auth/.well-known/oauth-authorization-server", "discovery.oauth_authorization_server.issuer_prefix.read", "platform.discovery", "discovery_document", null),
  readOnly("/.well-known/openid-configuration", "discovery.openid_configuration.read", "platform.discovery", "discovery_document", null),
  readOnly("/.well-known/openid-configuration/api/auth", "discovery.openid_configuration.issuer_suffix.read", "platform.discovery", "discovery_document", null),
  readOnly("/api/auth/.well-known/openid-configuration", "discovery.openid_configuration.issuer_prefix.read", "platform.discovery", "discovery_document", null),
  readOnly("/.well-known/oauth-protected-resource", "discovery.oauth_protected_resource.read", "platform.discovery", "discovery_document", null),
  readOnly("/.well-known/oauth-protected-resource/mcp", "discovery.oauth_protected_resource.mcp.read", "platform.discovery", "discovery_document", null, "Root-anchored RFC 9728 path; not in MCP_CONSUMPTION_EXCLUSIONS."),
  readOnly("/.well-known/oauth-protected-resource/mcp/agent", "discovery.oauth_protected_resource.mcp_agent.read", "platform.discovery", "discovery_document", null, "Root-anchored RFC 9728 path; not in MCP_CONSUMPTION_EXCLUSIONS."),
  readOnly("/.well-known/oauth-protected-resource/mcp/admin", "discovery.oauth_protected_resource.mcp_admin.read", "platform.discovery", "discovery_document", null, "Root-anchored RFC 9728 path; not in MCP_CONSUMPTION_EXCLUSIONS."),
  readOnly("/oauth/client-metadata.json", "discovery.oauth_client_metadata.read", "platform.discovery", "discovery_document", null),
  readOnly("/docs", "api_docs.read", "platform.discovery", "api_document", null),
  readOnly("/openapi.json", "api_docs.openapi.read", "platform.discovery", "api_document", null),
  readOnly("/v1/app-version", "app_version.read", "platform.discovery", "app_version", null),
  readOnly("/v1/orgs/sso/singleton", "auth.sso_singleton.read", "platform.discovery", "deployment", null),
  readOnly("/v1/auth/bootstrap/status", "auth.bootstrap.status.read", "platform.discovery", "deployment", null),
  readOnly("/v1/features", "feature.deployment.list", "platform.discovery", "feature", null, "Public deployment-wide feature state (kill switch and operator locks, never organization overrides) for people without an organization; side-effect free."),

  // OAuth authorization server (better-auth endpoints registered by Den)
  handler("GET", "/api/auth/oauth2/authorize", "tenant_change", "oauth.authorize", "oauth.authorization", "oauth_client", "Den route forwarding to better-auth. When the signed-in user has an MCP consent organization (postLogin.consentReferenceId, the session's active organization) the request is attributed there after the endpoint ran (phase after, src/audit/better-auth.ts) once their active membership is verified; actor = user + memberId. Issuing the authorization code is request evidence only (never the code). No session, no MCP scope or a failed request: platform evidence. The request policy hook may update oauthClient.scopes on this GET."),
  platform("POST", "/api/auth/oauth2/register", "oauth_client.register", "platform.auth", "oauth_client", null, "Public RFC 7591 registration; response carries client credentials (never captured)."),
  platform("POST", "/register", "oauth_client.register_root", "platform.auth", "oauth_client", null, "Root alias of /api/auth/oauth2/register (handled directly, not app.fetch)."),

  // Raw better-auth SCIM management (always 401/403)
  handler("POST", "/api/auth/scim/generate-token", "tenant_change", "scim_raw.token.generate", "platform.auth.raw_mutation", "scim_connection", `Den-shadowed raw better-auth route; use /v1/scim/token. ${RAW_REFUSED}`),
  platform("GET", "/api/auth/scim/list-provider-connections", "scim_raw.provider_connection.list", "platform.auth", "scim_connection", null, "Blocked: always 401/403."),
  platform("GET", "/api/auth/scim/get-provider-connection", "scim_raw.provider_connection.read", "platform.auth", "scim_connection", null, "Blocked: always 401/403."),
  handler("POST", "/api/auth/scim/delete-provider-connection", "tenant_change", "scim_raw.provider_connection.delete", "platform.auth.raw_mutation", "scim_connection", `Den-shadowed raw better-auth route; use DELETE /v1/scim. ${RAW_REFUSED}`),

  // Raw better-auth custom-role management. dynamicAccessControl is off, so better-auth no
  // longer registers these endpoints; Den shadows them (routes/auth/raw-role-refusals.ts) so
  // denied attempts stay in the tenant security audit (always 403).
  handler("POST", "/api/auth/organization/create-role", "tenant_change", "auth.organization.role.create", "platform.auth.raw_mutation", "role", `Den-shadowed raw better-auth route; custom organization roles are not supported (permission sets are managed through /v1/permissions). ${RAW_REFUSED}`),
  handler("POST", "/api/auth/organization/update-role", "tenant_change", "auth.organization.role.update", "platform.auth.raw_mutation", "role", `Den-shadowed raw better-auth route; custom organization roles are not supported (permission sets are managed through /v1/permissions). ${RAW_REFUSED}`),
  handler("POST", "/api/auth/organization/delete-role", "tenant_change", "auth.organization.role.delete", "platform.auth.raw_mutation", "role", `Den-shadowed raw better-auth route; custom organization roles are not supported (permission sets are managed through /v1/permissions). ${RAW_REFUSED}`),

  // Auth helpers
  platform("GET", "/v1/auth/login-options", "auth.login_options.read", "platform.auth", "login_options", null, "Public, bot-protected; reveals account sign-in methods."),
  platform("GET", "/v1/orgs/sso/resolve", "auth.sso.resolve", "platform.auth", "login_options", null, "Public, bot-protected email -> SSO routing."),
  handler("GET", "/v1/orgs/invitations/preview", "tenant_read", "invitation.preview", "invitation.read", "invitation", "Public preview by invitation id/token. The token proves the invitation's organization: once the invitation is found the handler attributes the served read there (category read, off by default), actor unknown. The token is never recorded (no resource id). Unknown tokens (404) stay platform evidence."),
  platform("POST", "/v1/auth/bootstrap/verify", "auth.bootstrap.verify", "platform.auth", "deployment", null, "One-time deployment bootstrap code."),
  handler("POST", "/v1/auth/desktop-handoff", "tenant_change", "auth.desktop_handoff.create", "session.lifecycle", "desktop_handoff_grant", "Hands over the caller's web session. Org = the session's active organization (or the organization approving the Cloud web return URL) once the user's active membership there is verified: the handler attributes before any write (intent fails closed) and appends desktop_handoff.created (target the handed-over session id, expiresAt, returnUrlApproved; never the grant, which is a bearer secret) into the request operation. A session without an organization keeps platform request evidence and desktop_handoff.created fans out to every active membership.", "audit/domain/sessions.ts"),
  userScoped("POST", "/v1/auth/desktop-handoff/exchange", "auth.desktop_handoff.exchange", "platform.auth", "desktop_handoff_grant", "audit/domain/sessions.ts", "Exchanges a one-time grant for the EXISTING web session (no new session row, so no second session.created): session.handed_off (method desktop_handoff, the shared session id) in the session's organization once the user's active membership there is verified, or every active membership when the session has none. The grant and session token are never recorded."),
  platform("POST", "/v1/auth/desktop-handoff/status", "auth.desktop_handoff.status.read", "platform.auth", "desktop_handoff_grant", null, "Public poll by grant (a bearer secret, never recorded); returns pending/consumed/unknown only. Not marked readOnly: it is a POST and increments the handoff-status rate-limit counter. No tenant is trustworthy before the grant is consumed."),
  platform("GET", "/v1/auth/device/:userCode", "auth.device_code.lookup", "platform.auth", "device_code", null, ":userCode is the device-flow verification code (a short-lived secret) and is deliberately not used as the resource id."),
  platform("GET", "/v1/email/unsubscribe", "email_preference.unsubscribe_link", "platform.user", "email_preference", null, "HMAC token link; performs the unsubscribe (not a read). User-level."),
  platform("POST", "/v1/email/unsubscribe", "email_preference.unsubscribe", "platform.user", "email_preference", null, "HMAC token; user-level."),
  platform("GET", "/v1/dev/emails", "dev_email.list", "platform.dev", "dev_email", null, "devMode only (404 otherwise); exposes OTP codes and links."),
  platform("GET", "/v1/dev/emails/last", "dev_email.last.read", "platform.dev", "dev_email", null, "devMode only (404 otherwise)."),

  // Session-only user routes and org creation
  readOnly("/v1/me", "user.read", "platform.user", "user", null),
  userScoped("PATCH", "/v1/me/profile", "user.profile.update", "platform.user", "user", "audit/domain/account.ts", "Direct database update (no better-auth hook): the handler appends account.profile_updated (name before/after) to every organization where the user is an active member."),
  platform("GET", "/v1/me/orgs", "user.organization.list", "platform.user", "organization", null, "Lists the caller's memberships; may hydrate the session active org."),
  userScoped("POST", "/v1/me/active-organization", "session.active_organization.update", "platform.user", "auth_session", "audit/domain/sessions.ts", "The handler appends session.organization_entered in the destination organization only (membership verified); the previous organization is never recorded and an unchanged organization records nothing. Automatic active-organization repair (GET /v1/me/orgs, resolveUserOrganizationsMiddleware) is not a user switch and records nothing."),
  platform("POST", "/v1/me/send-download-link", "user.download_link.send", "platform.user", "user", null, "Sends a download link email to the caller (Resend)."),
  platform("POST", "/v1/org", "organization.create", "platform.user", "organization", null, "Creates a new org; no tenant exists before the handler and the new org has no audit rollout."),
  platform("POST", "/v1/bootstrap/workspace", "workspace.bootstrap.create", "workspace.bootstrap", "workspace_bootstrap", null, "Public, rate limited; creates a provisional org and returns a preclaim assertion."),

  // Scheduled maintenance (bearer DEN_MAINTENANCE_TOKEN; 404 when unset)
  platform("POST", "/internal/audit/usage/refresh", "audit.usage.refresh", "platform.maintenance", "audit_usage", null, "Called by the den-audit-usage cron (Helm CronJob, Render cron job). Recomputes every organization's audit_state totals from stored rows; no organization activity, so platform evidence only."),

  // Global platform admin
  platform("GET", "/v1/admin/overview", "platform.overview.read", "platform.admin", "platform_report", null, ADMIN),
  platform("GET", "/v1/admin/metrics", "platform.metrics.read", "platform.admin", "platform_report", null, ADMIN),
  platform("GET", "/v1/admin/free-auto/usage", "platform.free_auto_usage.read", "platform.admin", "platform_report", null, ADMIN),
  platform("GET", "/v1/admin/organizations", "platform.organization.list", "platform.admin", "organization", null, ADMIN),
  platform("GET", "/v1/admin/users", "platform.user.list", "platform.admin", "user", null, ADMIN),
  platform("GET", "/v1/admin/users/:userId/inference-usage", "platform.user.inference_usage.read", "platform.admin", "user", "userId", ADMIN),
  platform("POST", "/v1/admin/users/:userId/inference-usage/reset", "platform.user.inference_usage.reset", "platform.admin", "user", "userId", ADMIN),
  platform("DELETE", "/v1/admin/users/:userId", "platform.user.delete", "platform.admin", "user", "userId", `${ADMIN} Deletes the user across orgs (Google revoke, Stripe seat sync per org). Each affected organization also gets member.removed change evidence (origin platform_admin, actor the admin) through the members emitter, appended after the soft removal commits (routes/admin/index.ts).`),
  platform("POST", "/v1/admin/admins", "platform.admin_allowlist.add", "platform.admin", "admin_allowlist", null, ADMIN),
  platform("DELETE", "/v1/admin/admins/:adminId", "platform.admin_allowlist.remove", "platform.admin", "admin_allowlist", "adminId", ADMIN),
  platform("GET", "/v1/admin/features", "platform.feature.list", "platform.admin", "feature", null, ADMIN),
  platform("PUT", "/v1/admin/features/:key", "platform.feature.rollout.update", "platform.admin", "feature", "key", `${ADMIN} Turns one feature on or off for everyone on the deployment and/or sets its kill switch; no organization's data changes, so platform evidence only (target the feature key). The admin MCP tool den_set_feature_rollout makes the same change and writes the same kind of platform evidence (method SERVICE, route service:feature.rollout.set).`),
]
