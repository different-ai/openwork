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
import { attributeCurrentAuditRequest, auditServiceAttribution, auditSessionUserAttribution, currentAuditChangeCapture, currentAuditRequestId, currentAuditRequestKey, type AuditRequestAttribution } from "./request-capture.js"

export type BetterAuthHookSession = Readonly<{ userId: string; email: string | null; sessionId: string | null; activeOrganizationId: string | null; activeTeamId: string | null }> | null
type HookInput = Readonly<{
  path: string
  request: Request | undefined
  body: unknown
  query: unknown
  session: () => Promise<BetterAuthHookSession>
}>
type HookResult = { ok: true } | { ok: false }
type ExistingOrganization = Readonly<{ id: string }>

const logger = appLogger.child({ component: "better_auth_audit" })
const ORG_READS = new Set([
  "/organization/get-full-organization", "/organization/get-organization", "/organization/list-members", "/organization/list-invitations", "/organization/get-active-member",
  "/organization/get-active-member-role", "/organization/list-roles", "/organization/get-role", "/organization/list-teams", "/organization/list-team-members",
])
const CONSENT_SESSION_ORG = new Set(["/oauth2/consent", "/oauth2/continue"])
const CONSENT_BY_ID = new Set(["/oauth2/update-consent", "/oauth2/delete-consent"])
const SCIM_READS = new Set(["/scim/v2/Users", "/scim/v2/Users/:userId"])
const SSO_CALLBACKS = new Set(["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId"])
const NO_ATTRIBUTION: HookResult = { ok: true }

export const BETTER_AUTH_AUDIT_BEFORE_PATHS: ReadonlySet<string> = new Set(["/organization/leave", "/organization/set-active", "/organization/reject-invitation", ...ORG_READS, ...CONSENT_SESSION_ORG, ...CONSENT_BY_ID, ...SCIM_READS])
export const BETTER_AUTH_AUDIT_AFTER_PATHS: ReadonlySet<string> = new Set(["/organization/leave", "/organization/reject-invitation", "/sso/get-provider", "/oauth2/token", "/oauth2/authorize", "/oauth2/revoke", ...SSO_CALLBACKS])

type LeavingMember = NonNullable<Awaited<ReturnType<typeof activeMember>>>
const leavingMembers = new WeakMap<Request, LeavingMember>()
type RejectedInvitation = Readonly<{ id: string; organizationId: string; status: string }>
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

async function existingOrganization(where: Readonly<{ id: string | null }> | Readonly<{ slug: string | null }>): Promise<ExistingOrganization | null> {
  const columns = { id: OrganizationTable.id }
  let row: ExistingOrganization | undefined
  if ("id" in where) {
    const id = organizationIdOrNull(where.id)
    if (!id) return null
    ;[row] = await db.select(columns).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1)
  } else {
    if (!where.slug) return null
    ;[row] = await db.select(columns).from(OrganizationTable).where(eq(OrganizationTable.slug, where.slug)).limit(1)
  }
  return row ?? null
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

async function attribute(organization: ExistingOrganization, input: Pick<AuditRequestAttribution, "actor" | "principalKey" | "phase">): Promise<HookResult> {
  const result = await attributeCurrentAuditRequest({ organizationId: organization.id, ...input })
  return result.ok ? { ok: true } : { ok: false }
}

async function attributeVerifiedMember(organization: ExistingOrganization | null, userId: string, phase: "before" | "after" = "before") {
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
    const organization = token ? await existingOrganization({ id: scimTokenOrganizationId(token) }) : null
    if (!token || !organization) return NO_ATTRIBUTION
    const { resolveScimProviderFromBearerToken } = await import("../scim.js")
    const provider = await resolveScimProviderFromBearerToken(token)
    if (!provider || organizationIdOrNull(provider.organizationId) !== organization.id) return NO_ATTRIBUTION
    return attribute(organization, auditServiceAttribution("scim", provider.providerId))
  }
  if (path === "/organization/leave") {
    const organization = await existingOrganization({ id: stringField(input.body, "organizationId") })
    const session = organization ? await input.session() : null
    if (!session) return NO_ATTRIBUTION
    const { result, member } = await attributeVerifiedMember(organization, session.userId)
    if (member && input.request && result.ok) leavingMembers.set(input.request, member)
    return result
  }
  if (path === "/organization/reject-invitation") {
    const invitationId = stringField(input.body, "invitationId")
    let id: ReturnType<typeof normalizeDenTypeId<"invitation">>
    try { id = normalizeDenTypeId("invitation", invitationId ?? "") } catch { return NO_ATTRIBUTION }
    const [invitation] = await db.select({ id: InvitationTable.id, organizationId: InvitationTable.organizationId, email: InvitationTable.email, status: InvitationTable.status })
      .from(InvitationTable).innerJoin(OrganizationTable, eq(OrganizationTable.id, InvitationTable.organizationId)).where(eq(InvitationTable.id, id)).limit(1)
    if (!invitation || invitation.status !== "pending") return NO_ATTRIBUTION
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
    const organization = await existingOrganization(organizationId ? { id: organizationId } : { slug: stringField(input.body, "organizationSlug") })
    const session = organization ? await input.session() : null
    return session ? (await attributeVerifiedMember(organization, session.userId)).result : NO_ATTRIBUTION
  }
  if (ORG_READS.has(path)) {
    const organizationId = stringField(input.query, "organizationId")
    const slug = path === "/organization/get-full-organization" || path === "/organization/get-organization" ? stringField(input.query, "organizationSlug") : null
    const session = organizationId || slug ? null : await input.session()
    const organization = await existingOrganization(organizationId ? { id: organizationId } : slug ? { slug } : { id: session?.activeOrganizationId ?? null })
    const user = organization ? session ?? await input.session() : null
    return user ? (await attributeVerifiedMember(organization, user.userId)).result : NO_ATTRIBUTION
  }
  if (CONSENT_SESSION_ORG.has(path)) {
    const session = await input.session()
    if (!session) return NO_ATTRIBUTION
    return (await attributeVerifiedMember(await existingOrganization({ id: session.activeOrganizationId }), session.userId)).result
  }
  if (CONSENT_BY_ID.has(path)) {
    const consentId = stringField(input.body, "id")
    if (!consentId) return NO_ATTRIBUTION
    let id: ReturnType<typeof normalizeDenTypeId<"oauthConsent">>
    try { id = normalizeDenTypeId("oauthConsent", consentId) } catch { return NO_ATTRIBUTION }
    const [consent] = await db.select({ userId: OAuthConsentTable.userId, organizationId: OrganizationTable.id })
      .from(OAuthConsentTable).innerJoin(OrganizationTable, eq(OrganizationTable.id, OAuthConsentTable.referenceId)).where(eq(OAuthConsentTable.id, id)).limit(1)
    if (!consent) return NO_ATTRIBUTION
    const session = await input.session()
    if (!session || consent.userId !== session.userId) return NO_ATTRIBUTION
    return (await attributeVerifiedMember({ id: consent.organizationId }, session.userId)).result
  }
  return NO_ATTRIBUTION
}

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
    if (!provider) return
    const member = await activeMember(provider.organizationId, input.newSessionUserId)
    const attribution = auditSessionUserAttribution(input.newSessionUserId, member?.id)
    if (attribution) await attribute({ id: provider.organizationId }, { ...attribution, phase: "after" })
    return
  }
  if (path === "/sso/get-provider" && !isFailure(input.returned)) {
    const organization = await existingOrganization({ id: stringField(input.returned, "organizationId") })
    const session = organization ? await input.session() : null
    if (session) await attributeVerifiedMember(organization, session.userId, "after")
  }
}

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

type SessionStash = Readonly<{ userId: string | null; sessionId: string | null; previousOrganizationId: string | null; previousTeamId: string | null; resetUserId: string | null }>
const sessionStashes = new WeakMap<Request, SessionStash>()

export const BETTER_AUTH_SESSION_BEFORE_PATHS: ReadonlySet<string> = new Set(["/organization/set-active", "/organization/set-active-team", "/reset-password"])
export const BETTER_AUTH_SESSION_AFTER_PATHS: ReadonlySet<string> = new Set([
  "/organization/set-active", "/organization/set-active-team", "/change-password", "/reset-password", "/email-otp/reset-password",
  "/sign-in/email", "/sign-in/email-otp", "/email-otp/check-verification-otp", "/get-access-token", "/refresh-token",
])

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

type OAuthIssuanceNote = Readonly<{ clientId: string; userId: string | null; referenceId: string | null; scopes: readonly string[]; grantType: string | null; resource: string | null; grantId: string | null }>
type OAuthRevocationNote = Readonly<{ clientId: string; userId: string; referenceId: string; scopes: readonly string[]; tokenType: "access_token" | "refresh_token" }>
type ConsentReferenceNote = Readonly<{ userId: string; referenceId: string }>
const oauthIssuances = new WeakMap<object, OAuthIssuanceNote>()
const oauthRevocations = new WeakMap<object, OAuthRevocationNote>()
const consentReferences = new WeakMap<object, ConsentReferenceNote>()

export function noteOAuthTokenIssuance(note: OAuthIssuanceNote): void {
  const key = env.auditCaptureEnabled ? currentAuditRequestKey() : null
  if (key) oauthIssuances.set(key, note)
}

export function noteOAuthConsentReference(note: ConsentReferenceNote): void {
  const key = env.auditCaptureEnabled ? currentAuditRequestKey() : null
  if (key) consentReferences.set(key, note)
}

export function noteOAuthRevocation(note: OAuthRevocationNote): void {
  const key = env.auditCaptureEnabled ? currentAuditRequestKey() : null
  if (key) oauthRevocations.set(key, note)
}

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
  const organization = await existingOrganization({ id: referenceId })
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

export const RAW_ENDPOINT_REFUSED = "raw_endpoint_refused"

export async function rawRefusalAttribution(input: Readonly<{ userId: string | null; requestedOrganizationId: string | null; activeOrganizationId: string | null }>): Promise<AuditRequestAttribution | null> {
  if (!env.auditCaptureEnabled || !input.userId) return null
  try {
    const organization = await existingOrganization({ id: input.requestedOrganizationId ?? input.activeOrganizationId })
    if (!organization) return null
    const member = await activeMember(organization.id, input.userId)
    const attribution = member ? auditSessionUserAttribution(input.userId, member.id) : null
    return attribution ? { organizationId: organization.id, ...attribution, refusal: { reasonCode: RAW_ENDPOINT_REFUSED } } : null
  } catch (error) {
    logger.warn("better-auth refusal attribution lookup failed; continuing without attribution", { error_name: errorName(error) })
    return null
  }
}

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
