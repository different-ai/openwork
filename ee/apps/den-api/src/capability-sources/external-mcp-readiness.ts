import { createHash } from "node:crypto"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ConnectedAccountTable, ExternalMcpConnectionTable, type ExternalMcpReadinessCheck } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import { getConnectedAccount } from "./oauth-credentials.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"

// A successful probe of someone else's account never makes this member Ready.
// Configuration/key changes invalidate the stored result without deleting history.
export function readinessFingerprint(connection: ExternalMcpConnectionRow, account?: Awaited<ReturnType<typeof getConnectedAccount>>) {
  return createHash("sha256").update(JSON.stringify([
    connection.url, connection.authType, connection.credentialMode, connection.apiKeyAuthScheme,
    connection.oauthConfiguration?.authorizationServerIssuer, connection.oauthConfiguration?.requestedScopes,
    connection.oauthConfiguration?.callbackMode, connection.oauthIssuerReviewRequiredAt,
    connection.credentialMode === "shared" ? [connection.apiKey, connection.accessToken] : account?.accessToken,
  ])).digest("hex")
}

export function visibleReadiness(check: ExternalMcpReadinessCheck | null, fingerprint: string) {
  if (!check || check.fingerprint !== fingerprint) return null
  return { status: check.status, checkedAt: check.checkedAt, lastSuccessfulAt: check.lastSuccessfulAt, reason: check.reason }
}

export async function saveReadinessCheck(connection: ExternalMcpConnectionRow, memberId: DenTypeId<"member">, check: ExternalMcpReadinessCheck) {
  if (connection.credentialMode === "per_member") {
    await db.update(ConnectedAccountTable).set({ readinessCheck: check }).where(and(
      eq(ConnectedAccountTable.organizationId, connection.organizationId),
      eq(ConnectedAccountTable.providerId, connection.id),
      eq(ConnectedAccountTable.orgMembershipId, memberId),
    ))
  } else {
    await db.update(ExternalMcpConnectionTable).set({ readinessCheck: check }).where(and(
      eq(ExternalMcpConnectionTable.organizationId, connection.organizationId),
      eq(ExternalMcpConnectionTable.id, connection.id),
    ))
  }
}
