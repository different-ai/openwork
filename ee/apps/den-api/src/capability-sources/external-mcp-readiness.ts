import { randomUUID } from "node:crypto"
import { fingerprintOrganizationReadinessIdentity, fingerprintReadinessIdentity, latestMemberReady, visibleReadiness, type VisibleReadiness } from "./external-mcp-readiness-identity.js"
export { visibleReadiness } from "./external-mcp-readiness-identity.js"
import { and, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, ExternalMcpConnectionTable, type ExternalMcpReadinessCheck, type ExternalMcpReadinessFailure } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import { EXTERNAL_MCP_SLACK_MCP_ACCESS_DISABLED_CODE, slackAppSettingsUrl, type ExternalMcpDiagnostic } from "./external-mcp-diagnostics.js"
import { getConnectedAccount } from "./oauth-credentials.js"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"

export const READINESS_FAILURE_REASONS = {
  sign_in_required: "Sign in to check this connection.",
  setup_required: "Finish setting up this connection.",
  provider_setup_required: "The service needs a setting changed before it can connect. Ask whoever manages the service's app to check its settings.",
  unavailable: "The service didn't respond. Try again later.",
  timed_out: "The check timed out. Try again.",
  sign_in_rejected: "The service rejected the sign-in. Sign in again.",
  settings_changed: "Connection settings changed during the check. Check again.",
  tools_unreadable: "The service answered but its tools couldn't be read. Check the connection address and settings.",
} satisfies Record<ExternalMcpReadinessFailure, string>

/** Why a readiness check of a working sign-in did not pass. */
export function readinessFailureForDiagnostic(diagnostic: ExternalMcpDiagnostic): ExternalMcpReadinessFailure {
  if (diagnostic.code === EXTERNAL_MCP_SLACK_MCP_ACCESS_DISABLED_CODE) return "provider_setup_required"
  if (diagnostic.category === "provider_unavailable" || diagnostic.category === "oauth_provider_unavailable") return "unavailable"
  if (diagnostic.category === "request_timeout" || diagnostic.category === "lifecycle_deadline") return "timed_out"
  if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) return "sign_in_rejected"
  return "tools_unreadable"
}

/** Why a sign-in that came back to Den did not leave a working connection. */
function connectAttemptFailure(diagnostic: ExternalMcpDiagnostic): ExternalMcpReadinessFailure {
  const failure = readinessFailureForDiagnostic(diagnostic)
  if (failure !== "tools_unreadable" && failure !== "sign_in_rejected") return failure
  if (diagnostic.phase.startsWith("AUTH_") || diagnostic.phase === "CONFIGURATION" || diagnostic.phase === "CONTINUITY_REFRESH") {
    // Signing in again only helps when the person signing in can fix it.
    return diagnostic.actionOwner === "member" ? "sign_in_rejected" : "setup_required"
  }
  return failure
}

/**
 * The stored fields of a failed check or sign-in attempt. Only server-written
 * copy is kept: the diagnostic message for a code whose message Den writes
 * itself, otherwise the fixed reason for the failure. Never provider prose.
 */
export function failedReadinessFields(diagnostic: ExternalMcpDiagnostic, failure: ExternalMcpReadinessFailure) {
  const serverWritten = diagnostic.code === EXTERNAL_MCP_SLACK_MCP_ACCESS_DISABLED_CODE
  const providerSettingsUrl = serverWritten ? slackAppSettingsUrl(diagnostic.providerSettingsUrl) : undefined
  return {
    failure,
    reason: serverWritten ? diagnostic.message : READINESS_FAILURE_REASONS[failure],
    code: diagnostic.code,
    referenceId: diagnostic.referenceId,
    ...(providerSettingsUrl ? { providerSettingsUrl } : {}),
  }
}

/**
 * Records why a sign-in that returned to Den failed, so the apps can show it
 * instead of waiting for a connection that will not appear. Per-member
 * connections keep it on the member's connected-account row, which carries
 * no credential here (it is created without one when missing); shared
 * connections keep it on the connection. Nothing is recorded while a working
 * credential remains: a failed re-sign-in must not hide a connection that
 * still works. The fingerprint binds it to the current sign-in state, so a
 * later sign-in or check replaces it.
 */
export async function recordFailedConnectAttempt(input: {
  connection: ExternalMcpConnectionRow
  memberId: DenTypeId<"member">
  diagnostic: ExternalMcpDiagnostic
}): Promise<boolean> {
  const { connection, memberId, diagnostic } = input
  const checkedAt = new Date().toISOString()
  const fields = failedReadinessFields(diagnostic, connectAttemptFailure(diagnostic))
  if (connection.credentialMode === "per_member") {
    const account = await getConnectedAccount({ organizationId: connection.organizationId, orgMembershipId: memberId, providerId: connection.id })
    if (account?.accessToken) return false
    const fingerprint = readinessFingerprint(connection, account)
    const check: ExternalMcpReadinessCheck = {
      status: "could_not_verify",
      checkedAt,
      lastSuccessfulAt: visibleReadiness(account?.readinessCheck ?? null, fingerprint)?.lastSuccessfulAt ?? null,
      ...fields,
      fingerprint,
    }
    if (account) {
      await db.update(ConnectedAccountTable).set({ readinessCheck: check }).where(and(
        eq(ConnectedAccountTable.id, account.id),
        isNull(ConnectedAccountTable.accessToken),
      ))
    } else {
      // A concurrent sign-in that created the row first wins.
      await db.insert(ConnectedAccountTable).ignore().values({
        id: createDenTypeId("connectedAccount"),
        organizationId: connection.organizationId,
        orgMembershipId: memberId,
        providerId: connection.id,
        readinessCheck: check,
      })
    }
    return true
  }
  if (connection.accessToken) return false
  const fingerprint = readinessFingerprint(connection)
  const check: ExternalMcpReadinessCheck = {
    status: "could_not_verify",
    checkedAt,
    lastSuccessfulAt: visibleReadiness(connection.readinessCheck, fingerprint)?.lastSuccessfulAt ?? null,
    ...fields,
    fingerprint,
  }
  await db.update(ExternalMcpConnectionTable).set({ readinessCheck: check }).where(and(
    eq(ExternalMcpConnectionTable.organizationId, connection.organizationId),
    eq(ExternalMcpConnectionTable.id, connection.id),
    isNull(ExternalMcpConnectionTable.accessToken),
  ))
  return true
}

// A successful probe of someone else's account never makes this member Ready.
// Configuration and credential revisions keep an old check from verifying a replacement.
export function readinessFingerprint(connection: ExternalMcpConnectionRow, account?: Awaited<ReturnType<typeof getConnectedAccount>>) {
  return fingerprintReadinessIdentity(connection, account)
}

export async function rotateReadinessCredentialBinding(connection: ExternalMcpConnectionRow, memberId: DenTypeId<"member">) {
  const changes = { readinessCredentialBinding: randomUUID(), readinessCheck: null }
  if (connection.credentialMode === "per_member") {
    await db.update(ConnectedAccountTable).set(changes).where(and(
      eq(ConnectedAccountTable.organizationId, connection.organizationId),
      eq(ConnectedAccountTable.providerId, connection.id),
      eq(ConnectedAccountTable.orgMembershipId, memberId),
    ))
  } else {
    await db.update(ExternalMcpConnectionTable).set(changes).where(and(
      eq(ExternalMcpConnectionTable.organizationId, connection.organizationId),
      eq(ExternalMcpConnectionTable.id, connection.id),
    ))
  }
}

async function saveConnectionLevelCheck(connection: ExternalMcpConnectionRow, check: ExternalMcpReadinessCheck) {
  await db.update(ExternalMcpConnectionTable).set({ readinessCheck: check }).where(and(
    eq(ExternalMcpConnectionTable.organizationId, connection.organizationId),
    eq(ExternalMcpConnectionTable.id, connection.id),
  ))
}

export async function saveReadinessCheck(connection: ExternalMcpConnectionRow, memberId: DenTypeId<"member">, check: ExternalMcpReadinessCheck) {
  if (connection.credentialMode === "per_member") {
    await db.update(ConnectedAccountTable).set({ readinessCheck: check }).where(and(
      eq(ConnectedAccountTable.organizationId, connection.organizationId),
      eq(ConnectedAccountTable.providerId, connection.id),
      eq(ConnectedAccountTable.orgMembershipId, memberId),
    ))
    // One member's working sign-in shows admins the connector itself works.
    // Only Ready is copied: one person's failure says nothing about everyone else.
    if (check.status === "ready") {
      await saveConnectionLevelCheck(connection, { ...check, fingerprint: fingerprintOrganizationReadinessIdentity(connection) })
    }
  } else {
    await saveConnectionLevelCheck(connection, check)
  }
}

/**
 * The connector's own stored status, without any network call. Shared
 * connections are checked with their one credential; per-member connections
 * hold the latest Ready check any member recorded for the current settings.
 */
export function storedOrganizationReadiness(connection: ExternalMcpConnectionRow): VisibleReadiness | null {
  return connection.credentialMode === "per_member"
    ? visibleReadiness(connection.readinessCheck, fingerprintOrganizationReadinessIdentity(connection))
    : visibleReadiness(connection.readinessCheck, fingerprintReadinessIdentity(connection))
}

/**
 * For per-member connections with no stored connector status, copy the most
 * recent Ready check any member already recorded (still valid for their
 * current sign-in and the connector's current settings) onto the connector.
 * One query for all connections; no outside service is called.
 */
export async function promoteMemberReadiness(connections: ExternalMcpConnectionRow[]): Promise<Map<string, VisibleReadiness>> {
  const promoted = new Map<string, VisibleReadiness>()
  const candidates = connections.filter((connection) => connection.credentialMode === "per_member" && !storedOrganizationReadiness(connection))
  const first = candidates[0]
  if (!first) return promoted
  const accounts = await db.select({
    providerId: ConnectedAccountTable.providerId,
    accessToken: ConnectedAccountTable.accessToken,
    externalAccountId: ConnectedAccountTable.externalAccountId,
    readinessCredentialBinding: ConnectedAccountTable.readinessCredentialBinding,
    readinessCheck: ConnectedAccountTable.readinessCheck,
  }).from(ConnectedAccountTable).where(and(
    eq(ConnectedAccountTable.organizationId, first.organizationId),
    inArray(ConnectedAccountTable.providerId, candidates.map((connection) => connection.id)),
    isNotNull(ConnectedAccountTable.readinessCheck),
  ))
  for (const connection of candidates) {
    const ready = latestMemberReady(connection, accounts.filter((account) => account.providerId === connection.id))
    if (!ready) continue
    await saveConnectionLevelCheck(connection, { ...ready, fingerprint: fingerprintOrganizationReadinessIdentity(connection) })
    promoted.set(connection.id, ready)
  }
  return promoted
}
