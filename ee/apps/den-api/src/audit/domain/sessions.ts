import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeLoginEmail } from "../../auth-login-options.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { appLogger } from "../../observability/logger.js"
import { recordAuditForUserMemberships, standaloneOrganizationAuditCapture, type AuditUserMembership } from "../fanout.js"
import { appendAuditEventInOwnTransaction, auditResourceId, currentAuditChangeCapture, currentAuditRequestId, logAuditOutcomeLost, type AuditChangeEventInput } from "../request-capture.js"
import { appendDomainChangesAfterCommit } from "./legacy.js"
import { auditChanges, fieldOf, organizationParent, relatedResource, stringOf, targetResource, timeOf } from "./snapshot.js"

// session.created / session.handed_off / session.revoked /
// session.organization_entered / desktop_handoff.created (change) and
// session.sign_in_failed (security). Session events land in the session's
// active organization after the owner's active membership there is verified
// (src/audit/fanout.ts), or in every active membership when the session has
// no organization (it can act in all of them); organization-scoped credential
// revocation lands in the affected organization; failed sign-ins fan out to
// every active membership of the targeted account. Never the session token, IP, user agent,
// submitted email, password, OTP or any hash of them.
// Chokepoints (src/auth.ts): databaseHooks.session.create.after (every sign-in
// path creating a session row), databaseHooks.session.delete.after (fires per
// row for single and bulk deletes: sign-out, revoke-session(s),
// revoke-other-sessions, password change), the org switch handlers, and
// hooks.after for failed sign-ins.

export type AuditSessionMethod = "password" | "email_otp" | `social:${string}` | "sso" | "device" | "desktop_handoff" | "other"

const logger = appLogger.child({ component: "audit_session_events" })
const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,64}$/
const SSO_PATHS = new Set(["/sso/callback/:providerId", "/sso/callback", "/sso/saml2/sp/acs/:providerId", "/sso/saml2/callback/:providerId"])
const REVOKE_REASONS: Readonly<Record<string, string>> = {
  "/sign-out": "sign_out", "/revoke-session": "session_revoked", "/revoke-sessions": "all_sessions_revoked", "/revoke-other-sessions": "other_sessions_revoked",
  "/change-password": "password_changed", "/reset-password": "password_reset", "/email-otp/reset-password": "password_reset", "/oauth2/end-session": "end_session",
  "/sso/saml2/sp/slo/:providerId": "saml_logout", "/sso/saml2/logout/:providerId": "saml_logout",
}

function socialMethod(providerId: string | null): AuditSessionMethod {
  return providerId && PROVIDER_ID.test(providerId) ? `social:${providerId}` : "social:unknown"
}

/** Sign-in method of the better-auth endpoint that created the session (databaseHooks context). */
export function auditSessionMethod(context: unknown): AuditSessionMethod {
  const path = stringOf(context, "path")
  if (path === "/sign-in/email" || path === "/sign-up/email") return "password"
  if (path === "/sign-in/email-otp" || path === "/email-otp/verify-email") return "email_otp"
  if (path === "/callback/:id") return socialMethod(stringOf(fieldOf(context, "params"), "id"))
  if (path === "/sign-in/social") return socialMethod(stringOf(fieldOf(context, "body"), "provider"))
  if (path && SSO_PATHS.has(path)) return "sso"
  if (path === "/device/token") return "device"
  return "other"
}

function sessionResources(sessionId: string) {
  return (membership: AuditUserMembership) => [targetResource("session", sessionId), relatedResource("member", membership.memberId), organizationParent(membership.organizationId)]
}

/** The session's active organization, or undefined: no organization fans the event out to every active membership. */
function sessionOrganization(session: unknown): string | undefined {
  return stringOf(session, "activeOrganizationId") ?? undefined
}

function isExpired(expiresAt: string | null) {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now()
}

/**
 * databaseHooks.session.create.after: `session.created` in the new session's
 * active organization. A session without one (a member of several
 * organizations signing in) can act in all of them, so the event fans out to
 * every organization where the user is an active member.
 */
export async function recordSessionCreated(session: unknown, method: AuditSessionMethod): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const userId = stringOf(session, "userId")
  const sessionId = auditResourceId(stringOf(session, "id"))
  if (!userId) return
  await recordAuditForUserMemberships({
    userId, organizationId: sessionOrganization(session), action: "session.created", kind: "session.lifecycle", category: "change", actor: "member", scope: sessionId,
    resources: sessionResources(sessionId), changes: auditChanges(null, { method, expiresAt: timeOf(session, "expiresAt") }),
    idempotencyDiscriminator: `${sessionId}:${method}`,
  })
}

/**
 * Desktop handoff exchange: the desktop receives an EXISTING web session, so
 * no second session.created; `session.handed_off` (method desktop_handoff) in
 * the session's organization, or every active membership when it has none.
 */
export async function recordSessionHandedOff(session: Readonly<{ id: string; userId: string; expiresAt: Date; activeOrganizationId: string | null }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const sessionId = auditResourceId(session.id)
  await recordAuditForUserMemberships({
    userId: session.userId, organizationId: session.activeOrganizationId ?? undefined, action: "session.handed_off", kind: "session.lifecycle", category: "change", actor: "member", scope: sessionId,
    resources: sessionResources(sessionId), changes: auditChanges(null, { method: "desktop_handoff", expiresAt: session.expiresAt.toISOString() }),
    idempotencyDiscriminator: sessionId,
  })
}

/**
 * POST /v1/auth/desktop-handoff: `desktop_handoff.created` (the grant itself is
 * a bearer secret: never recorded; the handed-over session is the target).
 * With an organization the request is attributed there first, so the event
 * joins its operation; without one it fans out to every active membership.
 */
export async function recordDesktopHandoffCreated(input: Readonly<{ userId: string; sessionId: string; organizationId: string | null; expiresAt: Date; returnUrlApproved: boolean }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const sessionId = auditResourceId(input.sessionId)
  await recordAuditForUserMemberships({
    userId: input.userId, organizationId: input.organizationId ?? undefined, action: "desktop_handoff.created", kind: "session.lifecycle", category: "change", actor: "member", scope: sessionId,
    resources: sessionResources(sessionId), changes: auditChanges(null, { expiresAt: input.expiresAt.toISOString(), returnUrlApproved: input.returnUrlApproved }),
    idempotencyDiscriminator: sessionId,
  })
}

/** reasonCode of a better-auth session delete (databaseHooks context path). */
export function auditSessionRevokeReason(context: unknown): string {
  const path = stringOf(context, "path")
  return (path && REVOKE_REASONS[path]) ?? "other"
}

/**
 * databaseHooks.session.delete.after: `session.revoked` in the deleted
 * session's active organization (every active membership when it has none).
 * Expired rows swept on read are not revocations.
 */
export async function recordSessionRevoked(session: unknown, reasonCode: string): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const userId = stringOf(session, "userId")
  const expiresAt = timeOf(session, "expiresAt")
  if (!userId || isExpired(expiresAt)) return
  const sessionId = auditResourceId(stringOf(session, "id"))
  await recordAuditForUserMemberships({
    userId, organizationId: sessionOrganization(session), action: "session.revoked", kind: "session.lifecycle", category: "change", actor: "member", scope: sessionId,
    resources: sessionResources(sessionId), changes: auditChanges({ expiresAt }, null), reasonCode,
    idempotencyDiscriminator: sessionId,
  })
}

/** A session row deleted by Den directly (no better-auth delete hook fires). */
export type DirectlyDeletedSession = Readonly<{ id: string; userId: string; expiresAt: Date; activeOrganizationId: string | null }>

/**
 * One session.revoked change event for a row Den deleted directly. Same
 * idempotency key as the better-auth hook path, so the two can never record
 * one row twice within a request operation.
 */
export function sessionRevokedEvent(input: Readonly<{ organizationId: string; memberId: string | null; session: DirectlyDeletedSession; reasonCode: string; requestId: string | null }>): AuditChangeEventInput {
  const sessionId = auditResourceId(input.session.id)
  return {
    action: "session.revoked",
    resources: [targetResource("session", sessionId), ...(input.memberId ? [relatedResource("member", input.memberId)] : []), organizationParent(input.organizationId)],
    changes: auditChanges({ expiresAt: input.session.expiresAt.toISOString() }, null), reasonCode: input.reasonCode,
    ...(input.requestId ? { idempotencyKey: `${input.requestId}:session.revoked:${sessionId}` } : {}),
  }
}

/**
 * Organization-scoped credential revocation (member removed, role or
 * permissions changed, ownership transferred): Den deletes every session of
 * the user directly, outside better-auth. `session.revoked` per live session
 * in the AFFECTED organization only. With the current request captured for
 * that organization the events join its operation (actor = whoever made the
 * change); otherwise an own operation with system actor
 * den-api.credential-revocation. Appended after the deletes committed (the
 * revocation never waits on, or rolls back for, audit): a failure logs
 * [audit-outcome-lost].
 */
export async function recordOrganizationSessionsRevoked(input: Readonly<{ organizationId: string; memberId: string | null; userId: string; sessions: readonly DirectlyDeletedSession[]; reasonCode: string }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const live = input.sessions.filter((session) => !isExpired(session.expiresAt.toISOString()))
  if (live.length === 0) return
  const requestId = currentAuditRequestId()
  const requestCapture = currentAuditChangeCapture(input.organizationId)
  const organizationId = requestCapture?.context.organizationId ?? input.organizationId
  const events = live.map((session) => sessionRevokedEvent({ organizationId, memberId: input.memberId, session, reasonCode: input.reasonCode, requestId }))
  if (requestCapture) {
    await appendDomainChangesAfterCommit(requestCapture, "session.revoked", async () => events)
    return
  }
  try {
    const capture = await standaloneOrganizationAuditCapture({
      organizationId, actor: { type: "system", id: CREDENTIAL_REVOCATION_ACTOR }, principalKey: `system:${CREDENTIAL_REVOCATION_ACTOR}`,
      kind: "session.lifecycle", scope: auditResourceId(input.userId), category: "change", requestId,
    })
    if (!capture) return
    for (const event of events) await appendAuditEventInOwnTransaction(capture, { ...event, category: "change", outcome: "succeeded" }, "succeeded")
  } catch (error) {
    logAuditOutcomeLost({ requestId, organizationId, action: "session.revoked", error })
  }
}

const CREDENTIAL_REVOCATION_ACTOR = "den-api.credential-revocation"

/**
 * User-wide direct deletions by a Den process (bootstrap agent cleanup):
 * `session.revoked` fanned out to every organization where the user is still
 * an active member, system actor, own operation per organization.
 */
export async function recordUserSessionsRevokedBySystem(input: Readonly<{ userId: string; sessions: readonly DirectlyDeletedSession[]; reasonCode: string; system: string }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  for (const session of input.sessions) {
    if (isExpired(session.expiresAt.toISOString())) continue
    const sessionId = auditResourceId(session.id)
    await recordAuditForUserMemberships({
      userId: input.userId, action: "session.revoked", kind: "session.lifecycle", category: "change", actor: { system: input.system }, scope: sessionId,
      resources: sessionResources(sessionId), changes: auditChanges({ expiresAt: session.expiresAt.toISOString() }, null), reasonCode: input.reasonCode,
      idempotencyDiscriminator: sessionId,
    })
  }
}

/**
 * POST /v1/me/active-organization, better-auth organization/set-active and
 * organization/set-active-team: `session.organization_entered` in the
 * destination organization only. The previous organization is never recorded
 * (the destination's admins must not learn other memberships).
 */
export async function recordSessionOrganizationEntered(input: Readonly<{ userId: string; organizationId: string; sessionId: string | null; teamId?: string | null }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const sessionId = auditResourceId(input.sessionId)
  const teamId = input.teamId ? auditResourceId(input.teamId) : null
  await recordAuditForUserMemberships({
    userId: input.userId, organizationId: input.organizationId, action: "session.organization_entered", kind: "session.lifecycle", category: "change", actor: "member", scope: sessionId,
    resources: (membership) => [...sessionResources(sessionId)(membership), ...(teamId ? [relatedResource("team", teamId)] : [])],
    changes: auditChanges(null, teamId ? { via: "active_team", teamId } : { via: "active_organization" }),
    idempotencyDiscriminator: `${sessionId}:${teamId ?? "organization"}`,
  })
}

export type AuditSignInFailure = Readonly<{
  /** Submitted email; only used to find the account, never stored. */
  email?: string | null
  /** Account already known server-side (e.g. from a reset-password token). */
  userId?: string | null
  method: "password" | "email_otp" | "password_reset" | "email_otp_password_reset"
  error: unknown
}>

const REASON_BY_CODE: Readonly<Record<string, string>> = {
  INVALID_EMAIL_OR_PASSWORD: "invalid_credentials", INVALID_PASSWORD: "invalid_credentials", EMAIL_NOT_VERIFIED: "email_not_verified",
  INVALID_OTP: "invalid_otp", OTP_EXPIRED: "otp_expired", TOO_MANY_ATTEMPTS: "too_many_attempts", INVALID_TOKEN: "invalid_token",
  PASSWORD_TOO_SHORT: "validation_failed", PASSWORD_TOO_LONG: "validation_failed", CREDENTIAL_ACCOUNT_NOT_FOUND: "no_password_set",
}

function failureOf(error: unknown): { outcome: "denied" | "failed"; reasonCode: string } {
  const status = fieldOf(error, "statusCode")
  const code = stringOf(fieldOf(error, "body"), "code")
  const reasonCode = (code && REASON_BY_CODE[code]) ?? (status === 401 || status === 403 ? "sign_in_denied" : "sign_in_failed")
  return { outcome: status === 401 || status === 403 || reasonCode === "invalid_credentials" || reasonCode === "invalid_otp" ? "denied" : "failed", reasonCode }
}

/** Account id for a submitted email (lookup only; the email is never stored). */
export async function findAuditUserIdByEmail(email: string): Promise<string | null> {
  const [user] = await db.select({ id: AuthUserTable.id }).from(AuthUserTable).where(eq(AuthUserTable.email, normalizeLoginEmail(email))).limit(1)
  return user?.id ?? null
}

async function recordSignInFailedNow(input: AuditSignInFailure, requestId: string | null): Promise<void> {
  const userId = input.userId ?? (input.email ? await findAuditUserIdByEmail(input.email) : null)
  // No account: nothing is recorded anywhere (existence is never revealed).
  if (!userId) return
  const targetUserId = userId
  const { outcome, reasonCode } = failureOf(input.error)
  await recordAuditForUserMemberships({
    userId: targetUserId, action: "session.sign_in_failed", kind: "session.authentication", category: "security", outcome, actor: "unknown", reasonCode, requestId,
    resources: (membership) => [targetResource("user", targetUserId), relatedResource("member", membership.memberId), organizationParent(membership.organizationId)],
    changes: { before: null, after: { method: input.method }, changedFields: [] },
  })
}

/**
 * hooks.after once the failure response is decided: runs detached so neither
 * the status, the body nor the response timing depends on whether the account
 * exists or is a member of a flagged organization. Known trade-off: anyone who
 * guesses a member's email can append these events (no rate limit).
 */
export function recordSignInFailed(input: AuditSignInFailure): void {
  if (!env.auditCaptureEnabled) return
  const requestId = currentAuditRequestId()
  void recordSignInFailedNow(input, requestId).catch((error: unknown) => {
    logger.warn("failed sign-in audit not recorded", { request_id: requestId, error_name: error instanceof Error ? error.name : typeof error })
  })
}
