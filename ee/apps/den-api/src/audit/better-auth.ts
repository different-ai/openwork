import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { InvitationTable, MemberTable, OAuthConsentTable, OrganizationTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { ORGANIZATION_AUDIT_ACTIONS } from "../audit-events.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { scimTokenOrganizationId } from "../scim-token-storage.js"
import { recordPasswordChanged, recordProviderTokenAccessed } from "./domain/account.js"
import { invitationRejectedEvent } from "./domain/invitations.js"
import { memberRemovedEvent } from "./domain/members.js"
import { oauthTokenIssuedEvent, oauthTokenRevokedEvent } from "./domain/oauth-tokens.js"
import { findAuditUserIdByEmail, recordSessionOrganizationEntered, recordSignInFailed } from "./domain/sessions.js"
import { appendDomainChangesAfterCommit, finishLegacyAuditAction } from "./domain/legacy.js"
import { attributeCurrentAuditRequest, auditLogsFeatureEnabled, auditServiceAttribution, auditSessionUserAttribution, currentAuditChangeCapture, currentAuditRequestId, currentAuditRequestKey, type AuditRequestAttribution } from "./request-capture.js"

// Tenant attribution for the org-attributable better-auth endpoints declared in
// ./routes/auth.ts (served by the `* /api/auth/*` catch-all). hooks.before
// attributes when the organization and the caller's active membership can be
// verified before the endpoint runs (true intent-before); hooks.after only
// where the organization is known from the endpoint's own verified result
// (SSO callbacks/ACS, sso/get-provider) with phase "after".
// Cost and availability: nothing runs while deployment capture is off; the
// candidate organization's auditLogs feature is read first and member,
// consent-owner and SCIM-token lookups only run for an organization with the
// feature on (attribution then rereads it fresh for that organization). A lookup error means "no attribution" (platform store, logged
// at warn); only a failed intent append refuses the endpoint (503).
// The organization is never taken from a request value alone: a body/query
// organization id counts only once the session user's active membership in it
// is confirmed. attributeCurrentAuditRequest itself refuses to act for Den
// routes that call auth.api server-side.

export type BetterAuthHookSession = Readonly<{ userId: string; email: string | null; sessionId: string | null; activeOrganizationId: string | null; activeTeamId: string | null }> | null
type HookInput = Readonly<{
  path: string
  request: Request | undefined
  body: unknown
  query: unknown
  /** Lazy: only read once a flagged organization needs the session user. */
  session: () => Promise<BetterAuthHookSession>
}>
type HookResult = { ok: true } | { ok: false }
type FlaggedOrganization = Readonly<{ id: string }>

const logger = appLogger.child({ component: "better_auth_audit" })
const ORG_READS = new Set([
  "/organization/get-full-organization", "/organization/list-members", "/organization/list-invitations", "/organization/get-active-member",
  "/organization/get-active-member-role", "/organization/list-roles", "/organization/get-role", "/organization/list-teams", "/organization/list-team-members",
])
const CONSENT_SESSION_ORG = new Set(["/oauth2/consent", "/oauth2/continue"])
const CONSENT_BY_ID = new Set(["/oauth2/update-consent", "/oauth2/delete-consent"])
const SCIM_READS = new Set(["/scim/v2/Users", "/scim/v2/Users/:userId"])
const SSO_CALLBACKS = new Set(["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId"])
const NO_ATTRIBUTION: HookResult = { ok: true }

/** Endpoint paths (better-auth ctx.path) handled by auditBetterAuthBefore / auditBetterAuthAfter. */
export const BETTER_AUTH_AUDIT_BEFORE_PATHS: ReadonlySet<string> = new Set(["/organization/leave", "/organization/set-active", "/organization/reject-invitation", ...ORG_READS, ...CONSENT_SESSION_ORG, ...CONSENT_BY_ID, ...SCIM_READS])
export const BETTER_AUTH_AUDIT_AFTER_PATHS: ReadonlySet<string> = new Set(["/organization/leave", "/organization/reject-invitation", "/sso/get-provider", "/oauth2/token", "/oauth2/authorize", "/oauth2/revoke", ...SSO_CALLBACKS])

type LeavingMember = NonNullable<Awaited<ReturnType<typeof activeMember>>>
/** Member row captured before organization/leave deletes it (keyed by the request object). */
const leavingMembers = new WeakMap<Request, LeavingMember>()
type RejectedInvitation = Readonly<{ id: string; organizationId: string; status: string }>
/** Invitation verified before organization/reject-invitation changes it (keyed by the request object). */
const rejectingInvitations = new WeakMap<Request, RejectedInvitation>()

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value
  return typeof field === "string" && field.trim() ? field.trim() : null
}

function organizationIdOrNull(value: string | null | undefined) {
  if (!value) return null
  try { return normalizeDenTypeId("organization", value) } catch { return null }
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error
}

/** The existing organization (by id or slug) when its auditLogs feature is on. */
async function flaggedOrganization(where: Readonly<{ id: string | null }> | Readonly<{ slug: string | null }>): Promise<FlaggedOrganization | null> {
  const columns = { id: OrganizationTable.id }
  let row: FlaggedOrganization | undefined
  if ("id" in where) {
    const id = organizationIdOrNull(where.id)
    if (!id) return null
    ;[row] = await db.select(columns).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1)
  } else {
    if (!where.slug) return null
    ;[row] = await db.select(columns).from(OrganizationTable).where(eq(OrganizationTable.slug, where.slug)).limit(1)
  }
  return row && await auditLogsFeatureEnabled(row.id) ? row : null
}

async function activeMember(organizationId: string | null, userId: string) {
  const orgId = organizationIdOrNull(organizationId)
  if (!orgId) return null
  let user: ReturnType<typeof normalizeDenTypeId<"user">>
  try { user = normalizeDenTypeId("user", userId) } catch { return null }
  const [member] = await db
    .select({ id: MemberTable.id, userId: MemberTable.userId, role: MemberTable.role, joinedAt: MemberTable.joinedAt, inviteId: MemberTable.inviteId, organizationId: MemberTable.organizationId })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, orgId), eq(MemberTable.userId, user), isNull(MemberTable.removedAt)))
    .limit(1)
  return member ?? null
}

async function attribute(organization: FlaggedOrganization, input: Pick<AuditRequestAttribution, "actor" | "principalKey" | "phase">): Promise<HookResult> {
  const result = await attributeCurrentAuditRequest({ organizationId: organization.id, ...input })
  return result.ok ? { ok: true } : { ok: false }
}

/** Attribute to a flagged organization only when the session user is an active member of it. */
async function attributeVerifiedMember(organization: FlaggedOrganization | null, userId: string, phase: "before" | "after" = "before") {
  if (!organization) return { result: NO_ATTRIBUTION, member: null }
  const member = await activeMember(organization.id, userId)
  if (!member) return { result: NO_ATTRIBUTION, member: null }
  const attribution = auditSessionUserAttribution(userId, member.id)
  if (!attribution) return { result: NO_ATTRIBUTION, member: null }
  return { result: await attribute(organization, { ...attribution, phase }), member }
}

function bearerToken(request: Request | undefined) {
  const match = /^Bearer\s+(.+)$/i.exec(request?.headers.get("authorization")?.trim() ?? "")
  return match?.[1]?.trim() || null
}

async function attributeBefore(input: HookInput): Promise<HookResult> {
  const { path } = input
  if (SCIM_READS.has(path)) {
    const token = bearerToken(input.request)
    // The token's organization part only selects the flag read; the provider
    // lookup verifies the token before it names the tenant.
    const organization = token ? await flaggedOrganization({ id: scimTokenOrganizationId(token) }) : null
    if (!token || !organization) return NO_ATTRIBUTION
    const { resolveScimProviderFromBearerToken } = await import("../scim.js")
    const provider = await resolveScimProviderFromBearerToken(token)
    if (!provider || organizationIdOrNull(provider.organizationId) !== organization.id) return NO_ATTRIBUTION
    return attribute(organization, auditServiceAttribution("scim", provider.providerId))
  }
  if (path === "/organization/leave") {
    const organization = await flaggedOrganization({ id: stringField(input.body, "organizationId") })
    const session = organization ? await input.session() : null
    if (!session) return NO_ATTRIBUTION
    const { result, member } = await attributeVerifiedMember(organization, session.userId)
    if (member && input.request && result.ok) leavingMembers.set(input.request, member)
    return result
  }
  if (path === "/organization/reject-invitation") {
    // The invitee is not a member yet: the invitation row names the
    // organization and better-auth's own check (session email equals the
    // invitation email) is repeated here before attributing to that user.
    const invitationId = stringField(input.body, "invitationId")
    let id: ReturnType<typeof normalizeDenTypeId<"invitation">>
    try { id = normalizeDenTypeId("invitation", invitationId ?? "") } catch { return NO_ATTRIBUTION }
    const [invitation] = await db.select({ id: InvitationTable.id, organizationId: InvitationTable.organizationId, email: InvitationTable.email, status: InvitationTable.status })
      .from(InvitationTable).innerJoin(OrganizationTable, eq(OrganizationTable.id, InvitationTable.organizationId)).where(eq(InvitationTable.id, id)).limit(1)
    if (!invitation || invitation.status !== "pending" || !(await auditLogsFeatureEnabled(invitation.organizationId))) return NO_ATTRIBUTION
    const session = await input.session()
    if (!session?.email || session.email.toLowerCase() !== invitation.email.toLowerCase()) return NO_ATTRIBUTION
    const attribution = auditSessionUserAttribution(session.userId, null)
    if (!attribution) return NO_ATTRIBUTION
    const result = await attribute({ id: invitation.organizationId }, attribution)
    if (result.ok && input.request) rejectingInvitations.set(input.request, { id: invitation.id, organizationId: invitation.organizationId, status: invitation.status })
    return result
  }
  if (path === "/organization/set-active") {
    const organizationId = stringField(input.body, "organizationId")
    const organization = await flaggedOrganization(organizationId ? { id: organizationId } : { slug: stringField(input.body, "organizationSlug") })
    const session = organization ? await input.session() : null
    return session ? (await attributeVerifiedMember(organization, session.userId)).result : NO_ATTRIBUTION
  }
  if (ORG_READS.has(path)) {
    const organizationId = stringField(input.query, "organizationId")
    const slug = path === "/organization/get-full-organization" ? stringField(input.query, "organizationSlug") : null
    const session = organizationId || slug ? null : await input.session()
    const organization = await flaggedOrganization(organizationId ? { id: organizationId } : slug ? { slug } : { id: session?.activeOrganizationId ?? null })
    const user = organization ? session ?? await input.session() : null
    return user ? (await attributeVerifiedMember(organization, user.userId)).result : NO_ATTRIBUTION
  }
  if (CONSENT_SESSION_ORG.has(path)) {
    // consentReferenceId (auth.ts postLogin) is the session's active organization.
    const session = await input.session()
    if (!session) return NO_ATTRIBUTION
    return (await attributeVerifiedMember(await flaggedOrganization({ id: session.activeOrganizationId }), session.userId)).result
  }
  if (CONSENT_BY_ID.has(path)) {
    const consentId = stringField(input.body, "id")
    if (!consentId) return NO_ATTRIBUTION
    let id: ReturnType<typeof normalizeDenTypeId<"oauthConsent">>
    try { id = normalizeDenTypeId("oauthConsent", consentId) } catch { return NO_ATTRIBUTION }
    // The consent's organization is unknown before the consent row: one joined
    // read returns its owner and existing organization, then its feature state.
    const [consent] = await db.select({ userId: OAuthConsentTable.userId, organizationId: OrganizationTable.id })
      .from(OAuthConsentTable).innerJoin(OrganizationTable, eq(OrganizationTable.id, OAuthConsentTable.referenceId)).where(eq(OAuthConsentTable.id, id)).limit(1)
    if (!consent || !(await auditLogsFeatureEnabled(consent.organizationId))) return NO_ATTRIBUTION
    const session = await input.session()
    if (!session || consent.userId !== session.userId) return NO_ATTRIBUTION
    return (await attributeVerifiedMember({ id: consent.organizationId }, session.userId)).result
  }
  return NO_ATTRIBUTION
}

/**
 * hooks.before (HTTP requests only). `{ ok: false }` means the intent append
 * failed: the caller must refuse the endpoint (503) without running it. A
 * lookup failure is "no attribution" and never refuses the endpoint.
 */
export async function auditBetterAuthBefore(input: HookInput): Promise<HookResult> {
  if (!env.auditCaptureEnabled) return NO_ATTRIBUTION
  try {
    return await attributeBefore(input)
  } catch (error) {
    logger.warn("better-auth audit attribution lookup failed; continuing without attribution", { auth_path: input.path, error_name: errorName(error) })
    return NO_ATTRIBUTION
  }
}

function isFailure(returned: unknown) {
  return returned instanceof Error || returned instanceof Response
}

/**
 * hooks.after. Never refuses (the effect already happened): a lost intent or
 * outcome is logged [audit-outcome-lost] by request capture.
 */
export async function auditBetterAuthAfter(input: HookInput & Readonly<{ params: unknown; returned: unknown; newSessionUserId: string | null }>): Promise<void> {
  const { path } = input
  if (path === "/organization/leave") {
    const member = input.request ? leavingMembers.get(input.request) : undefined
    if (input.request) leavingMembers.delete(input.request)
    if (!member || isFailure(input.returned)) return
    await recordLeaveRemoval(member)
    return
  }
  if (path === "/organization/reject-invitation") {
    const invitation = input.request ? rejectingInvitations.get(input.request) : undefined
    if (input.request) rejectingInvitations.delete(input.request)
    if (!invitation || failedResult(input.returned)) return
    const capture = currentAuditChangeCapture(invitation.organizationId)
    await appendDomainChangesAfterCommit(capture, "invitation.rejected", async () => [invitationRejectedEvent({ organizationId: invitation.organizationId, invitationId: invitation.id, beforeStatus: invitation.status })])
    return
  }
  if (!env.auditCaptureEnabled) return
  if (path === "/oauth2/token" || path === "/oauth2/authorize" || path === "/oauth2/revoke") {
    await auditOAuthAfter(path, input.returned)
    return
  }
  if (SSO_CALLBACKS.has(path) && input.newSessionUserId) {
    const providerId = stringField(input.params, "providerId")
    if (!providerId) return
    const [provider] = await db.select({ organizationId: OrganizationTable.id })
      .from(SsoProviderTable).innerJoin(OrganizationTable, eq(OrganizationTable.id, SsoProviderTable.organizationId)).where(eq(SsoProviderTable.providerId, providerId)).limit(1)
    if (!provider || !(await auditLogsFeatureEnabled(provider.organizationId))) return
    // The provider that validated the assertion names the organization; the
    // new session's user is the actor (a member once JIT provisioning ran).
    const member = await activeMember(provider.organizationId, input.newSessionUserId)
    const attribution = auditSessionUserAttribution(input.newSessionUserId, member?.id)
    if (attribution) await attribute({ id: provider.organizationId }, { ...attribution, phase: "after" })
    return
  }
  if (path === "/sso/get-provider" && !isFailure(input.returned)) {
    const organization = await flaggedOrganization({ id: stringField(input.returned, "organizationId") })
    const session = organization ? await input.session() : null
    if (session) await attributeVerifiedMember(organization, session.userId, "after")
  }
}

/**
 * organization/leave is an alternate member-removal path (legacy
 * organization.member.removed): with change capture active, append
 * member.removed after better-auth's delete committed; otherwise the legacy row.
 */
async function recordLeaveRemoval(member: LeavingMember) {
  const capture = currentAuditChangeCapture(member.organizationId)
  const ids = await appendDomainChangesAfterCommit(capture, "member.removed", async () => [memberRemovedEvent({ organizationId: member.organizationId, member, removedByMemberId: member.id, reasonCode: "member_left" })])
  await finishLegacyAuditAction(capture, {
    organizationId: member.organizationId,
    actorUserId: member.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.memberRemoved,
    payload: { targetOrgMembershipId: member.id, targetUserId: member.userId, previousRole: member.role },
  }, ids)
}

// ---------------------------------------------------------------------------
// User-scoped session and account events (attribution "user_memberships"):
// request evidence of these endpoints stays in the platform store; the change
// and security events go to the user's verified memberships
// (src/audit/domain/sessions.ts, src/audit/domain/account.ts).

type SessionStash = Readonly<{ userId: string | null; sessionId: string | null; previousOrganizationId: string | null; previousTeamId: string | null; resetUserId: string | null }>
/** State read before the endpoint runs, keyed by the request object. */
const sessionStashes = new WeakMap<Request, SessionStash>()

/** Endpoint paths (ctx.path) handled by auditBetterAuthSessionBefore / auditBetterAuthSessionAfter. */
export const BETTER_AUTH_SESSION_BEFORE_PATHS: ReadonlySet<string> = new Set(["/organization/set-active", "/organization/set-active-team", "/reset-password"])
export const BETTER_AUTH_SESSION_AFTER_PATHS: ReadonlySet<string> = new Set([
  "/organization/set-active", "/organization/set-active-team", "/change-password", "/reset-password", "/email-otp/reset-password",
  "/sign-in/email", "/sign-in/email-otp", "/email-otp/check-verification-otp", "/get-access-token", "/refresh-token",
])

/**
 * hooks.before (HTTP requests, capture on): the session's current organization
 * and team (to skip no-op switches), or the account a reset-password token
 * names (looked up, never stored). Never refuses the endpoint.
 */
export async function auditBetterAuthSessionBefore(input: Readonly<{
  path: string
  request: Request
  session: () => Promise<BetterAuthHookSession>
  resetPasswordUserId: () => Promise<string | null>
}>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  try {
    if (input.path === "/reset-password") {
      sessionStashes.set(input.request, { userId: null, sessionId: null, previousOrganizationId: null, previousTeamId: null, resetUserId: await input.resetPasswordUserId() })
      return
    }
    const session = await input.session()
    if (session) sessionStashes.set(input.request, { userId: session.userId, sessionId: session.sessionId, previousOrganizationId: session.activeOrganizationId, previousTeamId: session.activeTeamId, resetUserId: null })
  } catch (error) {
    logger.warn("better-auth session audit lookup failed; continuing without it", { auth_path: input.path, error_name: errorName(error) })
  }
}

/** hooks.after (HTTP requests, capture on). Never refuses; failures are logged by the emitters. */
export async function auditBetterAuthSessionAfter(input: Readonly<{ path: string; request: Request; body: unknown; returned: unknown; sessionUserId: string | null; sessionId: string | null }>): Promise<void> {
  const stash = sessionStashes.get(input.request)
  sessionStashes.delete(input.request)
  if (!env.auditCaptureEnabled) return
  const { path, returned } = input
  const failed = isFailure(returned)
  const email = stringField(input.body, "email")
  if (path === "/sign-in/email" || path === "/sign-in/email-otp" || path === "/email-otp/check-verification-otp") {
    if (failed) recordSignInFailed({ email, method: path === "/sign-in/email" ? "password" : "email_otp", error: returned })
    return
  }
  if (path === "/reset-password") {
    const userId = stash?.resetUserId ?? null
    if (failed) recordSignInFailed({ userId, method: "password_reset", error: returned })
    else if (userId) await recordPasswordChanged(userId, "reset_password")
    return
  }
  if (path === "/email-otp/reset-password") {
    if (failed) recordSignInFailed({ email, method: "email_otp_password_reset", error: returned })
    else if (email) {
      const userId = await findAuditUserIdByEmail(email)
      if (userId) await recordPasswordChanged(userId, "email_otp_reset")
    }
    return
  }
  if (path === "/change-password") {
    const userId = stringField(Object.getOwnPropertyDescriptor(returned ?? {}, "user")?.value, "id") ?? input.sessionUserId
    if (!failed && userId) await recordPasswordChanged(userId, "change_password")
    return
  }
  if (path === "/get-access-token" || path === "/refresh-token") {
    if (input.sessionUserId) await recordProviderTokenAccessed({ userId: input.sessionUserId, providerId: stringField(input.body, "providerId"), refresh: path === "/refresh-token", error: failed ? returned : null })
    return
  }
  if (failed) return
  const userId = stash?.userId ?? input.sessionUserId
  const sessionId = stash?.sessionId ?? input.sessionId
  if (!userId) return
  if (path === "/organization/set-active") {
    const organizationId = organizationIdOrNull(stringField(returned, "id"))
    if (organizationId && organizationId !== organizationIdOrNull(stash?.previousOrganizationId)) await recordSessionOrganizationEntered({ userId, organizationId, sessionId })
    return
  }
  if (path === "/organization/set-active-team") {
    const teamId = stringField(returned, "id")
    const organizationId = organizationIdOrNull(stringField(returned, "organizationId"))
    if (teamId && organizationId && teamId !== stash?.previousTeamId) await recordSessionOrganizationEntered({ userId, organizationId, sessionId, teamId })
  }
}

// ---------------------------------------------------------------------------
// Organization-bound OAuth tokens (MCP consent referenceId = the token's org
// claim). The organization comes from better-auth's own hooks during the
// request (postLogin.consentReferenceId, the access-token claims extension) or,
// for revocation, the stored token row, kept in request-scoped notes; tokens
// are never decoded or stored. Attribution is "after" (the organization is
// only known once the effect ran, and a revocation must never wait on audit);
// tokens without an organization stay platform request evidence.

type OAuthIssuanceNote = Readonly<{ clientId: string; userId: string | null; referenceId: string | null; scopes: readonly string[]; grantType: string | null; resource: string | null; grantId: string | null }>
type OAuthRevocationNote = Readonly<{ clientId: string; userId: string; referenceId: string; scopes: readonly string[]; tokenType: "access_token" | "refresh_token" }>
type ConsentReferenceNote = Readonly<{ userId: string; referenceId: string }>
const oauthIssuances = new WeakMap<object, OAuthIssuanceNote>()
const oauthRevocations = new WeakMap<object, OAuthRevocationNote>()
const consentReferences = new WeakMap<object, ConsentReferenceNote>()

/** From the access-token claims extension (authorization_code / refresh_token grants). */
export function noteOAuthTokenIssuance(note: OAuthIssuanceNote): void {
  const key = env.auditCaptureEnabled ? currentAuditRequestKey() : null
  if (key) oauthIssuances.set(key, note)
}

/** From postLogin.consentReferenceId (authorize, consent, continue). */
export function noteOAuthConsentReference(note: ConsentReferenceNote): void {
  const key = env.auditCaptureEnabled ? currentAuditRequestKey() : null
  if (key) consentReferences.set(key, note)
}

/** From hooks.before on /oauth2/revoke: the stored row the presented token names (looked up by its storage hash, never kept). */
export function noteOAuthRevocation(note: OAuthRevocationNote): void {
  const key = env.auditCaptureEnabled ? currentAuditRequestKey() : null
  if (key) oauthRevocations.set(key, note)
}

/** Failure unless a 2xx/3xx result (better-call carries redirects as APIError with a 3xx status). */
function failedResult(returned: unknown): boolean {
  if (returned instanceof Response) return returned.status >= 400
  if (returned instanceof Error) {
    const status = Object.getOwnPropertyDescriptor(returned, "statusCode")?.value
    return typeof status !== "number" || status >= 400
  }
  return false
}

async function verifiedTokenMember(referenceId: string | null, userId: string | null) {
  if (!referenceId || !userId) return null
  const organization = await flaggedOrganization({ id: referenceId })
  if (!organization) return null
  const member = await activeMember(organization.id, userId)
  const attribution = member ? auditSessionUserAttribution(userId, member.id) : null
  return member && attribution ? { organization, member, attribution } : null
}

async function auditOAuthAfter(path: string, returned: unknown): Promise<void> {
  const key = currentAuditRequestKey()
  if (!key || failedResult(returned)) return
  if (path === "/oauth2/authorize") {
    const note = consentReferences.get(key)
    const verified = note ? await verifiedTokenMember(note.referenceId, note.userId) : null
    if (verified) await attribute(verified.organization, { ...verified.attribution, phase: "after" })
    return
  }
  const issued = path === "/oauth2/token"
  const issuance = issued ? oauthIssuances.get(key) : undefined
  const revocation = issued ? undefined : oauthRevocations.get(key)
  const note = issuance ?? revocation
  if (!note) return
  const verified = await verifiedTokenMember(note.referenceId, note.userId)
  if (!verified) return
  await attribute(verified.organization, { ...verified.attribution, phase: "after" })
  const base = { organizationId: verified.organization.id, memberId: verified.member.id, clientId: note.clientId, scopes: note.scopes }
  const event = issuance
    ? oauthTokenIssuedEvent({ ...base, grantType: issuance.grantType, resource: issuance.resource, grantId: issuance.grantId })
    : oauthTokenRevokedEvent({ ...base, grantType: null, resource: null, grantId: null, tokenType: revocation?.tokenType })
  const action = issued ? "oauth_token.issued" : "oauth_token.revoked"
  const requestId = currentAuditRequestId()
  await appendDomainChangesAfterCommit(currentAuditChangeCapture(verified.organization.id), action, async () => [event ? { ...event, ...(requestId ? { idempotencyKey: `${requestId}:${action}` } : {}) } : null])
}

// ---------------------------------------------------------------------------
// Raw better-auth organization mutations refused by hooks.before
// (getRawBetterAuthMutationDenial) and the Den-shadowed raw SCIM management
// routes. The refused attempt is attributed to the organization the request
// names (body organizationId, else the session's active organization) ONLY when
// the session user is an active member there; otherwise it stays platform
// evidence. No `.requested` intent is written (attribution `refusal`), so audit
// can never turn the 403 into a 503; the denied `.attempted` outcome carries
// reasonCode raw_endpoint_refused.

export const RAW_ENDPOINT_REFUSED = "raw_endpoint_refused"

/** The refusal attribution, or null (no session, unflagged organization, not an active member, lookup failure). */
export async function rawRefusalAttribution(input: Readonly<{ userId: string | null; requestedOrganizationId: string | null; activeOrganizationId: string | null }>): Promise<AuditRequestAttribution | null> {
  if (!env.auditCaptureEnabled || !input.userId) return null
  try {
    const organization = await flaggedOrganization({ id: input.requestedOrganizationId ?? input.activeOrganizationId })
    if (!organization) return null
    const member = await activeMember(organization.id, input.userId)
    const attribution = member ? auditSessionUserAttribution(input.userId, member.id) : null
    return attribution ? { organizationId: organization.id, ...attribution, refusal: { reasonCode: RAW_ENDPOINT_REFUSED } } : null
  } catch (error) {
    logger.warn("better-auth refusal attribution lookup failed; continuing without attribution", { error_name: errorName(error) })
    return null
  }
}

/** hooks.before, right before a raw mutation is refused. Never throws and never changes the refusal. */
export async function auditBetterAuthRefusal(input: Readonly<{ body: unknown; session: () => Promise<BetterAuthHookSession> }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  try {
    const session = await input.session()
    if (!session) return
    const attribution = await rawRefusalAttribution({ userId: session.userId, requestedOrganizationId: stringField(input.body, "organizationId"), activeOrganizationId: session.activeOrganizationId })
    if (attribution) await attributeCurrentAuditRequest(attribution)
  } catch (error) {
    logger.warn("better-auth refusal audit failed; refusing without attribution", { error_name: errorName(error) })
  }
}
