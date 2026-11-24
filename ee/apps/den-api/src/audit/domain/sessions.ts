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

function sessionOrganization(session: unknown): string | undefined {
  return stringOf(session, "activeOrganizationId") ?? undefined
}

function isExpired(expiresAt: string | null) {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now()
}

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

export async function recordSessionHandedOff(session: Readonly<{ id: string; userId: string; expiresAt: Date; activeOrganizationId: string | null }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const sessionId = auditResourceId(session.id)
  await recordAuditForUserMemberships({
    userId: session.userId, organizationId: session.activeOrganizationId ?? undefined, action: "session.handed_off", kind: "session.lifecycle", category: "change", actor: "member", scope: sessionId,
    resources: sessionResources(sessionId), changes: auditChanges(null, { method: "desktop_handoff", expiresAt: session.expiresAt.toISOString() }),
    idempotencyDiscriminator: sessionId,
  })
}

export async function recordDesktopHandoffCreated(input: Readonly<{ userId: string; sessionId: string; organizationId: string | null; expiresAt: Date; returnUrlApproved: boolean }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const sessionId = auditResourceId(input.sessionId)
  await recordAuditForUserMemberships({
    userId: input.userId, organizationId: input.organizationId ?? undefined, action: "desktop_handoff.created", kind: "session.lifecycle", category: "change", actor: "member", scope: sessionId,
    resources: sessionResources(sessionId), changes: auditChanges(null, { expiresAt: input.expiresAt.toISOString(), returnUrlApproved: input.returnUrlApproved }),
    idempotencyDiscriminator: sessionId,
  })
}

export function auditSessionRevokeReason(context: unknown): string {
  const path = stringOf(context, "path")
  return (path && REVOKE_REASONS[path]) ?? "other"
}

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

export type DirectlyDeletedSession = Readonly<{ id: string; userId: string; expiresAt: Date; activeOrganizationId: string | null }>

export function sessionRevokedEvent(input: Readonly<{ organizationId: string; memberId: string | null; session: DirectlyDeletedSession; reasonCode: string; requestId: string | null }>): AuditChangeEventInput {
  const sessionId = auditResourceId(input.session.id)
  return {
    action: "session.revoked",
    resources: [targetResource("session", sessionId), ...(input.memberId ? [relatedResource("member", input.memberId)] : []), organizationParent(input.organizationId)],
    changes: auditChanges({ expiresAt: input.session.expiresAt.toISOString() }, null), reasonCode: input.reasonCode,
    ...(input.requestId ? { idempotencyKey: `${input.requestId}:session.revoked:${sessionId}` } : {}),
  }
}

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
  email?: string | null
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

export async function findAuditUserIdByEmail(email: string): Promise<string | null> {
  const [user] = await db.select({ id: AuthUserTable.id }).from(AuthUserTable).where(eq(AuthUserTable.email, normalizeLoginEmail(email))).limit(1)
  return user?.id ?? null
}

async function recordSignInFailedNow(input: AuditSignInFailure, requestId: string | null): Promise<void> {
  const userId = input.userId ?? (input.email ? await findAuditUserIdByEmail(input.email) : null)
  if (!userId) return
  const targetUserId = userId
  const { outcome, reasonCode } = failureOf(input.error)
  await recordAuditForUserMemberships({
    userId: targetUserId, action: "session.sign_in_failed", kind: "session.authentication", category: "security", outcome, actor: "unknown", reasonCode, requestId,
    resources: (membership) => [targetResource("user", targetUserId), relatedResource("member", membership.memberId), organizationParent(membership.organizationId)],
    changes: { before: null, after: { method: input.method }, changedFields: [] },
  })
}

export function recordSignInFailed(input: AuditSignInFailure): void {
  if (!env.auditCaptureEnabled) return
  const requestId = currentAuditRequestId()
  void recordSignInFailedNow(input, requestId).catch((error: unknown) => {
    logger.warn("failed sign-in audit not recorded", { request_id: requestId, error_name: error instanceof Error ? error.name : typeof error })
  })
}
