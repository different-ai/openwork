import { randomUUID } from "node:crypto"
import { fingerprintOrganizationReadinessIdentity, fingerprintReadinessIdentity, latestMemberReady, visibleReadiness, type VisibleReadiness } from "./external-mcp-readiness-identity.js"
export { visibleReadiness } from "./external-mcp-readiness-identity.js"
import { and, eq, inArray, isNotNull } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, ExternalMcpConnectionTable, type ExternalMcpReadinessCheck } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import { getConnectedAccount } from "./oauth-credentials.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"

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
