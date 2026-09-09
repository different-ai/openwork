import { createHmac, randomUUID } from "node:crypto"
import { and, desc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionTable, McpConnectionAttemptTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { connectionDiagnosticSchema, type ConnectionAttempt, type ConnectionDiagnostic } from "@openwork/types/connection-setup"
import { db } from "../db.js"
import { env } from "../env.js"
import { verifyOAuthStateToken } from "./generic-oauth.js"
import { externalMcpIdentityBinding, type ExternalMcpConnectionRow } from "./external-mcp-connections.js"

const stateHash = (state: string) => createHmac("sha256", env.betterAuthSecret).update("openwork:connection-attempt:v1\0").update(state).digest("hex")

/** Created only after discovery settles, before the URL is returned to the browser. */
export async function createConnectionAttempt(connection: ExternalMcpConnectionRow, state: string): Promise<string> {
  const payload = verifyOAuthStateToken({ token: state, secret: env.betterAuthSecret })
  if (!payload || payload.providerId !== connection.id || payload.organizationId !== connection.organizationId) throw new Error("Invalid connection attempt")
  const id = randomUUID()
  await db.transaction(async tx => {
    // Serialize starts and bound retained history for this member and connection.
    const [current] = await tx.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, connection.id)).for("update")
    if (!current || externalMcpIdentityBinding(current) !== externalMcpIdentityBinding(connection)) throw new Error("Connection changed while starting sign-in")
    const retained = await tx.select({ id: McpConnectionAttemptTable.id }).from(McpConnectionAttemptTable).where(and(
      eq(McpConnectionAttemptTable.organizationId, connection.organizationId),
      eq(McpConnectionAttemptTable.orgMembershipId, payload.orgMembershipId),
      eq(McpConnectionAttemptTable.connectionId, connection.id),
    )).orderBy(desc(McpConnectionAttemptTable.createdAt))
    const removed = retained.slice(7).map(row => row.id)
    if (removed.length) await tx.delete(McpConnectionAttemptTable).where(inArray(McpConnectionAttemptTable.id, removed))
    await tx.insert(McpConnectionAttemptTable).values({ id, organizationId: connection.organizationId, orgMembershipId: payload.orgMembershipId, connectionId: connection.id,
      identityBinding: externalMcpIdentityBinding(connection), stateHash: stateHash(state), status: "pending", expiresAt: new Date(payload.exp * 1000) })
  })
  return id
}

/** Call only after the callback's signed state, connection identity and access checks. */
export async function finishConnectionAttempt(state: string, diagnostic?: ConnectionDiagnostic): Promise<void> {
  await db.update(McpConnectionAttemptTable).set({ status: diagnostic ? "failed" : "authorized", diagnostic: diagnostic ? connectionDiagnosticSchema.parse(diagnostic) : null }).where(and(
    eq(McpConnectionAttemptTable.stateHash, stateHash(state)), eq(McpConnectionAttemptTable.status, "pending"),
  ))
}

export async function readConnectionAttempt(connection: ExternalMcpConnectionRow, memberId: DenTypeId<"member">, id: string): Promise<ConnectionAttempt | null> {
  const [row] = await db.select().from(McpConnectionAttemptTable).where(and(
    eq(McpConnectionAttemptTable.id, id), eq(McpConnectionAttemptTable.organizationId, connection.organizationId),
    eq(McpConnectionAttemptTable.orgMembershipId, memberId), eq(McpConnectionAttemptTable.connectionId, connection.id),
  )).limit(1)
  if (!row) return null
  const state = row.identityBinding !== externalMcpIdentityBinding(connection) ? "configuration_changed"
    : row.status === "pending" && row.expiresAt.getTime() <= Date.now() ? "expired" : row.status
  return { id: row.id, connectionId: row.connectionId, state, startedAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), diagnostic: row.diagnostic }
}
