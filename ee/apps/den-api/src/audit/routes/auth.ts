import type { AuditRouteClass, AuditRouteDeclaration, AuditRouteMethod } from "./types.js"

// Better-auth endpoints reachable over HTTP: every auth.api entry with a `path` and no
// options.metadata.SERVER_ONLY, one declaration per (method, path). They are dispatched by
// the `* /api/auth/*` catch-all (routes/auth/index.ts), so app.routes only reports
// "/api/auth/*"; the generic audit middleware resolves these declarations by the concrete
// request path (better-auth's ctx.path, e.g. "/sso/callback/:providerId", prefixed with "/api/auth").
//
// "handler" attribution here means a better-auth hook (src/audit/better-auth.ts, wired in
// src/auth.ts: hooks.before when the session and membership are verified before the endpoint
// runs, else hooks.after using ctx.context.returned / ctx.context.newSession) calls
// attributeCurrentAuditRequest through the request's AsyncLocalStorage state. Requests that fail
// before attribution (401/403/404) fall to the platform store. Rows attributed in hooks.after
// run after better-auth committed: intent and outcome are appended together and a failed
// append logs [audit-outcome-lost] instead of returning 503 (the session or row already exists).
//
// Excluded — registered as concrete Den Hono routes and declared with them, so the catch-all
// never serves them: GET /api/auth/oauth2/authorize, POST /api/auth/oauth2/register,
// POST /api/auth/scim/generate-token, POST /api/auth/scim/delete-provider-connection,
// GET /api/auth/scim/get-provider-connection, GET /api/auth/scim/list-provider-connections,
// POST /api/auth/scim/v2/Users, PUT|PATCH|DELETE /api/auth/scim/v2/Users/:userId,
// GET|POST /api/auth/scim/v2/Groups, GET|PUT|PATCH|DELETE /api/auth/scim/v2/Groups/:groupId,
// GET /api/auth/scim/v2/ResourceTypes, GET /api/auth/scim/v2/Schemas.

const CREDENTIAL = "Security-relevant credential event."
const TOKEN = "Security-relevant: issues credentials; token values are never recorded."
const SESSION_REVOKE = "Security-relevant: revokes sessions."
const USER_ONLY = "User-scoped: actor is the authenticated user when a session exists; never attributed to an organization."
const ANONYMOUS = "Unauthenticated protocol endpoint; actor unknown unless a session exists."

type Extra = Readonly<{ notes?: string; changeEvidence?: string }>

function declare(method: AuditRouteMethod, path: string, cls: AuditRouteClass, action: string, kind: string, type: string, idParam: string | null, attribution: "handler" | "user_memberships" | "none", extra: Extra): AuditRouteDeclaration {
  return { method, path: `/api/auth${path}`, class: cls, action, kind, resource: { type, idParam }, attribution, ...extra }
}

function platform(method: AuditRouteMethod, path: string, action: string, kind: string, type: string, idParam: string | null, notes: string): AuditRouteDeclaration {
  return declare(method, path, "platform", action, kind, type, idParam, "none", { notes })
}

/** Side-effect-free GET (session/metadata read): successes need the platformAuditReads feature. */
function readOnly(path: string, action: string, kind: string, type: string, idParam: string | null, notes: string): AuditRouteDeclaration {
  return { ...platform("GET", path, action, kind, type, idParam, notes), readOnly: true }
}

const RAW_REFUSED = "Before the refusal, hooks.before (auditBetterAuthRefusal) attributes the attempt to the organization the body names (organizationId), else the cookie session's active organization, ONLY when the session user is an active member there (attribution refusal: no .requested intent is written, so audit can never turn the 403 into a 503): <action>.attempted, outcome denied, reasonCode raw_endpoint_refused, category security when selected. No session, an unflagged organization or one the user is not a member of: platform evidence only."

function refused(path: string, action: string, type: string, denRoute: string): AuditRouteDeclaration {
  return declare("POST", path, "tenant_change", action, "platform.auth.raw_mutation", type, null, "handler", { notes: `Refused by hooks.before (getRawBetterAuthMutationDenial, 403 for every external caller); ${denRoute} performs this server-side. ${RAW_REFUSED}` })
}

const SESSIONS = "audit/domain/sessions.ts"
const ACCOUNT = "audit/domain/account.ts"
const SESSION_CREATED = "databaseHooks.session.create.after appends session.created (method, expiresAt) in the new session's activeOrganizationId once the user's active membership there is verified; a session without an organization (a member of several organizations) can act in all of them, so it fans out to every organization where the user is an active member."
const SESSION_REVOKED = "databaseHooks.session.delete.after appends session.revoked per deleted session (bulk deletes fire per row; expired rows swept on read are skipped) in that session's organization once the owner's active membership is verified, or every active membership when the session had no organization."
const SIGN_IN_FAILED = "On failure for an EXISTING account, hooks.after appends session.sign_in_failed (security; actor unknown; target the account's user; reasonCode from the better-auth error code) to every active membership, detached after the response is decided (status, body and timing unchanged; nothing for unknown emails; the submitted email/password/OTP is never stored). Trade-off: anyone guessing a member's email can generate these events (no rate limit)."
const FAN_OUT = "fans out to every organization where the user is an active member (own operation per organization, shared request id)."

/**
 * Platform request evidence; the domain emitter appends change/security events
 * about the user into the user's verified memberships (attribution user_memberships).
 */
function userScoped(method: AuditRouteMethod, path: string, action: string, kind: string, type: string, idParam: string | null, changeEvidence: string, notes: string): AuditRouteDeclaration {
  return declare(method, path, "platform", action, kind, type, idParam, "user_memberships", { changeEvidence, notes })
}

function tenant(method: AuditRouteMethod, path: string, cls: AuditRouteClass, action: string, kind: string, type: string, idParam: string | null, extra: Extra): AuditRouteDeclaration {
  return declare(method, path, cls, action, kind, type, idParam, "handler", extra)
}

const ORG_READ = "hooks.before (audit/better-auth.ts): org = query organizationId (get-full-organization: organizationSlug lookup), else the session's activeOrganizationId, used only once the cookie session user's active membership in it is confirmed; actor = session user + memberId."
const SCIM_READ = "hooks.before: the organization part of the SCIM bearer only selects the audit flag read; for a flagged organization the token is verified through resolveScimProviderFromBearerToken -> provider.organizationId (must match); actor service scim:<providerId>. Invalid tokens stay unattributed (platform store)."
const SSO_CALLBACK = "hooks.after, phase after, only when ctx.context.newSession exists: org = sso_provider.organizationId of the :providerId that validated the assertion; actor = newSession user (+ member id once JIT provisioning made one). Failed callbacks stay platform (provider id is caller-controlled until validated). The created session also records session.created (method sso) through databaseHooks.session.create.after in the session's own activeOrganizationId (its own operation; may differ from the provider's organization)."
const OAUTH_TOKENS = "audit/domain/oauth-tokens.ts"
const OAUTH_AUTHORIZE = "When the signed-in user has an MCP consent organization (postLogin.consentReferenceId = the session's active organization, noted for the request) the request is attributed there after the endpoint ran (phase after) once their active membership is verified; actor = user + memberId. The authorization code is request evidence only and never recorded. Non-MCP (OIDC) authorization, no session or failures: platform evidence."
const OAUTH_TOKEN = "authorization_code and refresh_token grants: the access-token claims extension (src/auth.ts) notes client id, user, consent referenceId (the token's org claim), scopes, grant type, MCP resource and grant (consent) id for the request; on success hooks.after attributes the request to that organization (phase after: the organization is only known once the token exists) once the user's active membership is verified, and appends oauth_token.issued (clientId, scopes, grantType, resource; target the grant, else the client; actor = the token's user + memberId). Never token values, codes, client secrets or hashes. Tokens without an organization (non-MCP OIDC sign-in), the RFC 7523 jwt-bearer grant Den answers itself and failures stay platform evidence. The claims extension runs for JWT access tokens (every MCP token carries an audience); opaque tokens are not noted."
const OAUTH_REVOKE = "hooks.before looks up the stored refresh or opaque access token row by the same storage hash better-auth uses (nothing is kept) and notes its client, user, referenceId and scopes; on success hooks.after attributes the request to that organization (phase after, so a revocation never waits on audit) once the user's active membership is verified and appends oauth_token.revoked (tokenType, clientId, scopes). JWT access tokens are stateless (not looked up), tokens without an organization and failures stay platform evidence."
const SAML_SLO = "Kept platform: Den does not set saml.enableSingleLogout, so better-auth answers 400 SINGLE_LOGOUT_NOT_ENABLED before it reads or validates the provider; the provider id is caller-controlled and unvalidated, so attributing it would let anyone write into any organization's log. If SLO is enabled later, the ended sessions record session.revoked (reasonCode saml_logout) through databaseHooks.session.delete.after."
const CONSENT = "hooks.before: org = consentReferenceId (consent/continue: the session's activeOrganizationId chosen on /mcp/select-organization; update/delete: the consent row's referenceId for the caller's own consent), used only after the session user's active membership is confirmed; actor = session user + memberId."

export const authAuditRoutes: readonly AuditRouteDeclaration[] = [
  // Sign-in / sign-up / sign-out
  userScoped("POST", "/sign-in/email", "auth.sign_in.email", "platform.auth", "session", null, SESSIONS, `${CREDENTIAL} ${SESSION_CREATED} ${SIGN_IN_FAILED}`),
  userScoped("POST", "/sign-in/email-otp", "auth.sign_in.email_otp", "platform.auth", "session", null, SESSIONS, `${CREDENTIAL} ${SESSION_CREATED} ${SIGN_IN_FAILED}`),
  userScoped("POST", "/sign-in/social", "auth.sign_in.social", "platform.auth", "session", null, `${SESSIONS}, ${ACCOUNT}`, `${ANONYMOUS} Usually starts the social OAuth redirect (the session is created at /callback/:id); the idToken variant creates the session here: ${SESSION_CREATED} Implicit account linking appends account.identity_linked (databaseHooks.account.create.after), which ${FAN_OUT}`),
  platform("POST", "/sign-in/sso", "auth.sign_in.sso.start", "platform.sso", "sso_connection", null, `${ANONYMOUS} Org/provider named by an unauthenticated caller (hooks.before authorizeOrganizationSsoSignIn); tenant attribution happens at the validated callback.`),
  userScoped("POST", "/sign-up/email", "auth.sign_up.email", "platform.auth", "user", null, SESSIONS, `${CREDENTIAL} Creates a user and session; may complete the initial-admin bootstrap. Auto sign-in: ${SESSION_CREATED} A brand-new user usually has no membership yet, so nothing is stored.`),
  userScoped("POST", "/sign-out", "auth.sign_out", "platform.session", "session", null, SESSIONS, `${SESSION_REVOKE} ${SESSION_REVOKED}`),
  // Sessions
  readOnly("/get-session", "auth.session.get", "platform.session", "session", null, USER_ONLY),
  platform("POST", "/get-session", "auth.session.get.post", "platform.session", "session", null, USER_ONLY),
  readOnly("/list-sessions", "auth.session.list", "platform.session", "session", null, USER_ONLY),
  userScoped("POST", "/revoke-session", "auth.session.revoke", "platform.session", "session", null, SESSIONS, `${SESSION_REVOKE} ${SESSION_REVOKED}`),
  userScoped("POST", "/revoke-sessions", "auth.session.revoke_all", "platform.session", "session", null, SESSIONS, `${SESSION_REVOKE} ${SESSION_REVOKED}`),
  userScoped("POST", "/revoke-other-sessions", "auth.session.revoke_others", "platform.session", "session", null, SESSIONS, `${SESSION_REVOKE} ${SESSION_REVOKED}`),
  platform("POST", "/update-session", "auth.session.update", "platform.session", "session", null, `${USER_ONLY} No session.updated event: Den declares no session field with input enabled (activeOrganizationId/activeTeamId are input: false), so this endpoint can only answer 400 "No fields to update" or touch updatedAt.`),
  // User account
  userScoped("POST", "/update-user", "auth.user.update", "platform.account", "user", null, ACCOUNT, `Alternate route to PATCH /v1/me/profile. databaseHooks.user.update.before/after append account.profile_updated (name before/after, image as a changed marker) and ${FAN_OUT}`),
  userScoped("POST", "/change-email", "auth.user.email.change", "platform.account", "user", null, ACCOUNT, `${CREDENTIAL} When the email is updated here (or later at /verify-email), databaseHooks.user.update appends account.email_changed (changed marker only, never the addresses) and ${FAN_OUT}`),
  userScoped("POST", "/change-password", "auth.user.password.change", "platform.account", "user", null, `${ACCOUNT}, ${SESSIONS}`, `${CREDENTIAL} hooks.after on success appends account.password_changed (method only, never values) and ${FAN_OUT} With revokeOtherSessions the deleted sessions record session.revoked and the replacement session session.created (method other).`),
  platform("POST", "/verify-password", "auth.user.password.verify", "platform.account", "user", null, `${CREDENTIAL} Metadata scope "server" but HTTP-reachable.`),
  userScoped("POST", "/delete-user", "auth.user.delete", "platform.account", "user", null, ACCOUNT, `${CREDENTIAL} Disabled in Den (user.deleteUser is not enabled, so better-auth answers 404). If enabled, databaseHooks.user.delete.before appends account.deleted while the memberships still exist and ${FAN_OUT} Per-organization member.removed evidence would then still be missing (member rows are not removed through the members emitter on this path).`),
  userScoped("GET", "/delete-user/callback", "auth.user.delete.confirm", "platform.account", "user", null, ACCOUNT, `${CREDENTIAL} Token-confirmed deletion; the token is never recorded. Disabled like /delete-user; same account.deleted hook.`),
  userScoped("POST", "/link-social", "auth.account.link", "platform.account", "account", null, ACCOUNT, `${CREDENTIAL} The link completes at /callback/:id: databaseHooks.account.create.after appends account.identity_linked (providerId, method) and ${FAN_OUT}`),
  userScoped("POST", "/unlink-account", "auth.account.unlink", "platform.account", "account", null, ACCOUNT, `${CREDENTIAL} databaseHooks.account.delete.after appends account.identity_unlinked (providerId) and ${FAN_OUT}`),
  readOnly("/list-accounts", "auth.account.list", "platform.account", "account", null, USER_ONLY),
  platform("GET", "/account-info", "auth.account.info.read", "platform.account", "account", null, USER_ONLY),
  userScoped("POST", "/get-access-token", "auth.account.access_token.get", "platform.account", "account", null, ACCOUNT, `${TOKEN} Returns the linked provider's access token. hooks.after appends account.provider_token.accessed (category access, providerId only, outcome from the response) for the session user and ${FAN_OUT}`),
  userScoped("POST", "/refresh-token", "auth.account.access_token.refresh", "platform.account", "account", null, ACCOUNT, `${TOKEN} Refreshes the linked provider's tokens. Same account.provider_token.accessed fan-out (reasonCode refreshed).`),
  // Email verification and password reset
  platform("POST", "/send-verification-email", "auth.email_verification.send", "platform.account", "user", null, USER_ONLY),
  userScoped("GET", "/verify-email", "auth.email_verification.verify", "platform.account", "user", null, `${ACCOUNT}, ${SESSIONS}`, `${ANONYMOUS} Verification token is never recorded. Confirming a change-email link updates the email: account.email_changed (marker only) ${FAN_OUT} Auto sign-in: ${SESSION_CREATED}`),
  platform("POST", "/request-password-reset", "auth.password_reset.request", "platform.account", "user", null, ANONYMOUS),
  platform("GET", "/reset-password/:token", "auth.password_reset.callback", "platform.account", "user", null, `${ANONYMOUS} :token is a secret and deliberately not used as the resource id.`),
  userScoped("POST", "/reset-password", "auth.password_reset.complete", "platform.account", "user", null, `${ACCOUNT}, ${SESSIONS}`, `${CREDENTIAL} ${ANONYMOUS} hooks.before resolves the account the reset token names (lookup only; the token is never stored). Success: account.password_changed (method reset_password) ${FAN_OUT} Failure with a valid token (password length): session.sign_in_failed as below; an invalid token names no account and records nothing. ${SIGN_IN_FAILED}`),
  platform("POST", "/forget-password/email-otp", "auth.password_reset.email_otp.request", "platform.account", "user", null, ANONYMOUS),
  platform("POST", "/email-otp/send-verification-otp", "auth.email_otp.send", "platform.account", "verification", null, ANONYMOUS),
  userScoped("POST", "/email-otp/check-verification-otp", "auth.email_otp.check", "platform.account", "verification", null, SESSIONS, `${ANONYMOUS} ${SIGN_IN_FAILED}`),
  userScoped("POST", "/email-otp/verify-email", "auth.email_otp.verify_email", "platform.account", "user", null, SESSIONS, `${ANONYMOUS} Auto sign-in after verification: ${SESSION_CREATED}`),
  platform("POST", "/email-otp/request-password-reset", "auth.email_otp.password_reset.request", "platform.account", "user", null, ANONYMOUS),
  userScoped("POST", "/email-otp/reset-password", "auth.email_otp.password_reset.complete", "platform.account", "user", null, `${ACCOUNT}, ${SESSIONS}`, `${CREDENTIAL} ${ANONYMOUS} Success: account.password_changed (method email_otp_reset) ${FAN_OUT} ${SIGN_IN_FAILED}`),
  platform("POST", "/email-otp/request-email-change", "auth.email_otp.email_change.request", "platform.account", "user", null, USER_ONLY),
  userScoped("POST", "/email-otp/change-email", "auth.email_otp.email_change.complete", "platform.account", "user", null, ACCOUNT, `${CREDENTIAL} databaseHooks.user.update appends account.email_changed (changed marker only) and ${FAN_OUT}`),
  // Social callback, JWT, misc
  userScoped("GET", "/callback/:id", "auth.social.callback", "platform.auth", "social_provider", "id", `${SESSIONS}, ${ACCOUNT}`, `${TOKEN} Social OAuth callback creates the user/session: ${SESSION_CREATED} (method social:<providerId>). A newly linked identity appends account.identity_linked and ${FAN_OUT}`),
  userScoped("POST", "/callback/:id", "auth.social.callback.form_post", "platform.auth", "social_provider", "id", `${SESSIONS}, ${ACCOUNT}`, `${TOKEN} form_post variant of the social callback; same session.created / account.identity_linked hooks.`),
  readOnly("/jwks", "auth.jwks.read", "platform.auth", "jwks", null, ANONYMOUS),
  platform("GET", "/token", "auth.jwt.issue", "platform.auth", "jwt", null, `${TOKEN} ${USER_ONLY} The JWT plugin's session token carries the user payload and no organization claim (getDenJwtOptions defines no payload), so there is no org to attribute.`),
  readOnly("/error", "auth.error_page.read", "platform.auth", "error_page", null, ANONYMOUS),
  readOnly("/ok", "auth.ok.read", "platform.auth", "health", null, ANONYMOUS),
  // OAuth provider protocol and client self-management (oauthClient rows carry no org)
  tenant("POST", "/oauth2/authorize", "tenant_change", "auth.oauth.authorize.post", "oauth.authorization", "oauth_client", null, { notes: `GET /api/auth/oauth2/authorize is a Den route (same attribution). ${OAUTH_AUTHORIZE} hooks.before may widen oauthClient scopes.` }),
  tenant("POST", "/oauth2/token", "tenant_change", "auth.oauth.token.issue", "oauth.token", "oauth_token", null, { changeEvidence: OAUTH_TOKENS, notes: `${TOKEN} ${OAUTH_TOKEN}` }),
  platform("POST", "/oauth2/introspect", "auth.oauth.token.introspect", "platform.oauth", "oauth_token", null, ANONYMOUS),
  tenant("POST", "/oauth2/revoke", "tenant_change", "auth.oauth.token.revoke", "oauth.token", "oauth_token", null, { changeEvidence: OAUTH_TOKENS, notes: `${SESSION_REVOKE} ${OAUTH_REVOKE}` }),
  platform("GET", "/oauth2/userinfo", "auth.oauth.userinfo.read", "platform.oauth", "user", null, "Bearer-authenticated user info."),
  platform("POST", "/oauth2/userinfo", "auth.oauth.userinfo.read_post", "platform.oauth", "user", null, "Bearer-authenticated user info (POST variant)."),
  userScoped("GET", "/oauth2/end-session", "auth.oauth.session.end", "platform.oauth", "session", null, SESSIONS, `${SESSION_REVOKE} RP-initiated logout. The id_token_hint carries no organization claim (customAccessTokenClaims only shapes access tokens), so the request stays platform evidence; the ended session records session.revoked (reasonCode end_session) through databaseHooks.session.delete.after in its own organization (or every active membership).`),
  readOnly("/oauth2/public-client", "auth.oauth.public_client.read", "platform.oauth", "oauth_client", null, ANONYMOUS),
  platform("POST", "/oauth2/public-client-prelogin", "auth.oauth.public_client.prelogin_read", "platform.oauth", "oauth_client", null, ANONYMOUS),
  platform("POST", "/oauth2/create-client", "auth.oauth.client.create", "platform.oauth", "oauth_client", null, `${TOKEN} ${USER_ONLY} Alternate client creation path to POST /api/auth/oauth2/register.`),
  platform("POST", "/oauth2/update-client", "auth.oauth.client.update", "platform.oauth", "oauth_client", null, USER_ONLY),
  platform("POST", "/oauth2/delete-client", "auth.oauth.client.delete", "platform.oauth", "oauth_client", null, USER_ONLY),
  platform("POST", "/oauth2/client/rotate-secret", "auth.oauth.client.secret.rotate", "platform.oauth", "oauth_client", null, `${TOKEN} ${USER_ONLY}`),
  readOnly("/oauth2/get-client", "auth.oauth.client.read", "platform.oauth", "oauth_client", null, USER_ONLY),
  readOnly("/oauth2/get-clients", "auth.oauth.client.list", "platform.oauth", "oauth_client", null, USER_ONLY),
  readOnly("/oauth2/get-consent", "auth.oauth.consent.read", "platform.oauth", "oauth_consent", null, `${USER_ONLY} The user's own consent rows across orgs.`),
  readOnly("/oauth2/get-consents", "auth.oauth.consent.list", "platform.oauth", "oauth_consent", null, `${USER_ONLY} The user's own consent rows across orgs.`),
  tenant("POST", "/oauth2/consent", "tenant_change", "auth.oauth.consent.grant", "oauth.consent", "oauth_consent", null, { notes: `${TOKEN} ${CONSENT}` }),
  tenant("POST", "/oauth2/continue", "tenant_change", "auth.oauth.authorization.continue", "oauth.consent", "oauth_consent", null, { notes: `Continues authorization after org selection (postLogin). ${CONSENT}` }),
  tenant("POST", "/oauth2/update-consent", "tenant_change", "auth.oauth.consent.update", "oauth.consent", "oauth_consent", null, { notes: `Changes MCP scopes granted for the consented org. ${CONSENT}` }),
  tenant("POST", "/oauth2/delete-consent", "tenant_change", "auth.oauth.consent.revoke", "oauth.consent", "oauth_consent", null, { notes: `Revokes an MCP grant for the consented org. ${CONSENT}` }),
  // Device authorization
  platform("GET", "/device", "auth.device.verify", "platform.device", "device_code", null, ANONYMOUS),
  platform("POST", "/device/code", "auth.device.code.issue", "platform.device", "device_code", null, ANONYMOUS),
  userScoped("POST", "/device/token", "auth.device.token.issue", "platform.device", "device_code", null, SESSIONS, `${TOKEN} Session org is staged from the Den decision (stageDeviceSessionOrganization); the poller has no verified tenant actor, so request evidence stays platform. ${SESSION_CREATED} (method device)`),
  platform("POST", "/device/approve", "auth.device.approve", "platform.device", "device_code", null, `${TOKEN} ${USER_ONLY} Kept platform: the raw endpoint stages no organization (it writes status/userId only; device_code.organizationId is set solely by Den POST /v1/auth/device/decision, which is already attributed to the chosen member's organization before the code is decided). A code decided through Den is no longer pending, so this endpoint cannot act on a staged organization.`),
  platform("POST", "/device/deny", "auth.device.deny", "platform.device", "device_code", null, `${USER_ONLY} Kept platform: denial binds no organization (Den POST /v1/auth/device/decision is the org-aware path).`),
  // Organization plugin: user-scoped
  platform("POST", "/organization/create", "auth.organization.create", "platform.organization", "organization", null, "Creates a new org that has no audit policy yet; alternate route to POST /v1/org."),
  readOnly("/organization/list", "auth.organization.list", "platform.organization", "organization", null, USER_ONLY),
  readOnly("/organization/list-user-invitations", "auth.organization.user_invitation.list", "platform.organization", "invitation", null, USER_ONLY),
  readOnly("/organization/list-user-teams", "auth.organization.user_team.list", "platform.organization", "team", null, USER_ONLY),
  readOnly("/organization/get-invitation", "auth.organization.invitation.read", "platform.organization", "invitation", null, `${USER_ONLY} Invitee view; the caller is not yet a member.`),
  platform("POST", "/organization/check-slug", "auth.organization.slug.check", "platform.organization", "organization", null, USER_ONLY),
  platform("POST", "/organization/has-permission", "auth.organization.permission.check", "platform.organization", "organization", null, `${USER_ONLY} Read-only check over POST.`),
  tenant("POST", "/organization/reject-invitation", "tenant_change", "auth.organization.invitation.reject", "invitation.management", "invitation", null, { changeEvidence: "audit/domain/invitations.ts", notes: "Invitee (not yet a member) rejects. hooks.before verifies the pending invitation and better-auth's own check (cookie session email equals the invitation email, case-insensitive) and attributes to the invitation's organization (intent before; actor = the invitee user, no memberId). On success hooks.after appends invitation.rejected (status pending → rejected only; never the email or join token) in a fresh transaction. Anything unverified stays platform evidence." }),
  userScoped("POST", "/organization/set-active-team", "auth.organization.active_team.set", "platform.organization", "team", null, SESSIONS, "Session preference. On success hooks.after appends session.organization_entered (via active_team, team related) in the team's organization once the user's active membership is verified; unchanged team or clearing it records nothing. The previous team/organization is never recorded."),
  // Organization plugin: org-attributable
  tenant("POST", "/organization/leave", "tenant_change", "auth.organization.leave", "organization.membership", "member", null, {
    changeEvidence: "audit/domain/members.ts",
    notes: "Alternate route to member removal (legacy organization.member.removed). hooks.before attributes once the session user's active membership in body.organizationId is confirmed (flagged organizations only; intent before the delete, 503 only when the intent append fails) and keeps the member row; hooks.after appends member.removed (memberRemovedEvent, reasonCode member_left) in a fresh transaction after better-auth's delete, or writes the legacy row when change capture is off for that flagged organization. Unflagged organizations and deployment capture off: no lookup and no record (as before this change).",
  }),
  tenant("POST", "/organization/set-active", "tenant_change", "auth.organization.active.set", "organization.session", "organization", null, { changeEvidence: SESSIONS, notes: "Alternate route to POST /v1/me/active-organization. hooks.before attributes once the session user's active membership in body.organizationId (or organizationSlug) is confirmed; clearing the active organization (null) is not attributed. On success hooks.after appends session.organization_entered (via active_organization) in the destination organization only, inside the request operation when it is captured; the previous organization is never recorded and an unchanged organization records nothing." }),
  tenant("GET", "/organization/get-full-organization", "tenant_read", "auth.organization.read", "organization.read", "organization", null, { notes: ORG_READ }),
  tenant("GET", "/organization/list-members", "tenant_read", "auth.organization.member.list", "organization.read", "member", null, { notes: ORG_READ }),
  tenant("GET", "/organization/list-invitations", "tenant_read", "auth.organization.invitation.list", "organization.read", "invitation", null, { notes: ORG_READ }),
  tenant("GET", "/organization/get-active-member", "tenant_read", "auth.organization.active_member.read", "organization.read", "member", null, { notes: ORG_READ }),
  tenant("GET", "/organization/get-active-member-role", "tenant_read", "auth.organization.active_member_role.read", "organization.read", "member", null, { notes: ORG_READ }),
  tenant("GET", "/organization/list-teams", "tenant_read", "auth.organization.team.list", "organization.read", "team", null, { notes: ORG_READ }),
  tenant("GET", "/organization/list-team-members", "tenant_read", "auth.organization.team_member.list", "organization.read", "team", null, { notes: ORG_READ }),
  // Organization plugin: refused raw mutations
  refused("/organization/update", "auth.organization.update", "organization", "Den PATCH /v1/org"),
  refused("/organization/delete", "auth.organization.delete", "organization", "Den DELETE /v1/org"),
  refused("/organization/update-member-role", "auth.organization.member.role.update", "member", "Den POST /v1/members/:memberId/role"),
  refused("/organization/remove-member", "auth.organization.member.remove", "member", "Den DELETE /v1/members/:memberId"),
  refused("/organization/create-team", "auth.organization.team.create", "team", "Den POST /v1/teams"),
  refused("/organization/update-team", "auth.organization.team.update", "team", "Den PATCH /v1/teams/:teamId"),
  refused("/organization/remove-team", "auth.organization.team.remove", "team", "Den DELETE /v1/teams/:teamId"),
  refused("/organization/add-team-member", "auth.organization.team_member.add", "team", "Den PATCH /v1/teams/:teamId (organizationHooks also deny team mutations)"),
  refused("/organization/remove-team-member", "auth.organization.team_member.remove", "team", "Den PATCH /v1/teams/:teamId (organizationHooks also deny team mutations)"),
  refused("/organization/invite-member", "auth.organization.invitation.create", "invitation", "Den POST /v1/invitations"),
  refused("/organization/cancel-invitation", "auth.organization.invitation.cancel", "invitation", "Den POST /v1/invitations/:invitationId/cancel"),
  refused("/organization/accept-invitation", "auth.organization.invitation.accept", "invitation", "Den POST /v1/orgs/invitations/accept"),
  // API keys (Den keys are org keys managed through /v1/api-keys)
  refused("/api-key/create", "auth.api_key.create", "api_key", "Den POST /v1/api-keys (auth.api.createApiKey)"),
  refused("/api-key/update", "auth.api_key.update", "api_key", "No Den update route (keys are rotated by delete + create); nothing"),
  refused("/api-key/delete", "auth.api_key.delete", "api_key", "Den DELETE /v1/api-keys/:apiKeyId"),
  readOnly("/api-key/get", "auth.api_key.read", "platform.api_key", "api_key", null, `${USER_ONLY} Keys the caller owns may span orgs; GET /v1/api-keys is the org-attributed listing.`),
  readOnly("/api-key/list", "auth.api_key.list", "platform.api_key", "api_key", null, `${USER_ONLY} Keys the caller owns may span orgs; GET /v1/api-keys is the org-attributed listing.`),
  // SSO
  refused("/sso/register", "auth.sso.provider.register", "sso_connection", "Den POST /v1/sso/oidc | /v1/sso/saml (auth.api.registerSSOProvider)"),
  refused("/sso/update-provider", "auth.sso.provider.update", "sso_connection", "Den POST /v1/sso/oidc | /v1/sso/saml"),
  refused("/sso/delete-provider", "auth.sso.provider.delete", "sso_connection", "Den DELETE /v1/sso"),
  refused("/sso/request-domain-verification", "auth.sso.domain_verification.request", "sso_connection", "Den POST /v1/sso/request-domain-verification"),
  refused("/sso/verify-domain", "auth.sso.domain.verify", "sso_connection", "Den POST /v1/sso/verify-domain"),
  tenant("GET", "/sso/get-provider", "tenant_read", "auth.sso.provider.read", "sso.configuration", "sso_connection", null, { notes: "hooks.after on success: org = returned provider's organizationId once the session user's active membership is confirmed; actor = session user + memberId. Den GET /v1/sso is the primary surface." }),
  readOnly("/sso/providers", "auth.sso.provider.list", "platform.sso", "sso_connection", null, `${USER_ONLY} Lists providers across every org the caller administers.`),
  readOnly("/sso/saml2/sp/metadata", "auth.sso.saml.sp_metadata.read", "platform.sso", "sso_connection", null, ANONYMOUS),
  tenant("GET", "/sso/callback/:providerId", "tenant_change", "auth.sso.oidc.callback", "sso.sign_in", "sso_connection", "providerId", { changeEvidence: SESSIONS, notes: `${TOKEN} ${SSO_CALLBACK} hooks.after also completes SSO test intents here.` }),
  tenant("GET", "/sso/callback", "tenant_change", "auth.sso.oidc.callback_shared", "sso.sign_in", "sso_connection", null, { changeEvidence: SESSIONS, notes: `${TOKEN} Shared redirect URI: the provider is only inside better-auth's validated state, which the hook does not see, so it is not attributed and records in the platform store (limitation). The created session still records session.created (method sso) in its own organization.` }),
  tenant("GET", "/sso/saml2/sp/acs/:providerId", "tenant_change", "auth.sso.saml.acs.redirect_binding", "sso.sign_in", "sso_connection", "providerId", { changeEvidence: SESSIONS, notes: `${TOKEN} ${SSO_CALLBACK}` }),
  tenant("POST", "/sso/saml2/sp/acs/:providerId", "tenant_change", "auth.sso.saml.acs.post_binding", "sso.sign_in", "sso_connection", "providerId", { changeEvidence: SESSIONS, notes: `${TOKEN} samlResponsePolicyMiddleware runs first. ${SSO_CALLBACK} hooks.after also completes SSO test intents here.` }),
  platform("GET", "/sso/saml2/sp/slo/:providerId", "auth.sso.saml.slo.redirect_binding", "platform.sso", "sso_connection", "providerId", `${SESSION_REVOKE} ${SAML_SLO}`),
  platform("POST", "/sso/saml2/sp/slo/:providerId", "auth.sso.saml.slo.post_binding", "platform.sso", "sso_connection", "providerId", `${SESSION_REVOKE} ${SAML_SLO}`),
  platform("POST", "/sso/saml2/logout/:providerId", "auth.sso.saml.logout.initiate", "platform.sso", "sso_connection", "providerId", `${SESSION_REVOKE} SP-initiated SAML logout. ${SAML_SLO}`),
  // SCIM v2 endpoints not shadowed by Den routes
  tenant("GET", "/scim/v2/Users", "tenant_read", "scim_user.list", "scim.provisioning", "scim_user", null, { notes: SCIM_READ }),
  tenant("GET", "/scim/v2/Users/:userId", "tenant_read", "scim_user.read", "scim.provisioning", "scim_user", "userId", { notes: SCIM_READ }),
  readOnly("/scim/v2/ServiceProviderConfig", "auth.scim.service_provider_config.read", "platform.scim", "scim_metadata", null, "Static unauthenticated SCIM metadata."),
  readOnly("/scim/v2/Schemas/:schemaId", "auth.scim.schema.read", "platform.scim", "scim_metadata", "schemaId", "Static unauthenticated SCIM metadata (Den serves the Group schema URN itself)."),
  readOnly("/scim/v2/ResourceTypes/:resourceTypeId", "auth.scim.resource_type.read", "platform.scim", "scim_metadata", "resourceTypeId", "Static unauthenticated SCIM metadata (Den serves ResourceTypes/Group itself)."),
]
