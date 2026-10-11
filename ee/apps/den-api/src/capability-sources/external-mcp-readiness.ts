import { randomUUID } from "node:crypto"
import { fingerprintReadinessIdentity } from "./external-mcp-readiness-identity.js"
export { visibleReadiness } from "./external-mcp-readiness-identity.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
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
