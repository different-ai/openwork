import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

/**
 * CRUD for ExternalMcpConnectionTable — the "add any MCP server" concept.
 * This is the only module that touches this table directly; the connector
 * (external-mcp-client.ts) and routes go through these functions.
 */

export type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">

export async function listExternalMcpConnections(organizationId: OrganizationId): Promise<ExternalMcpConnectionRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.organizationId, organizationId))
}

export async function getExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<ExternalMcpConnectionRow | null> {
  const rows = await db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(and(
      eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
      eq(ExternalMcpConnectionTable.id, input.connectionId),
    ))
    .limit(1)
  return rows[0] ?? null
}

/** Unscoped lookup by id only — needed for the public OAuth callback, where identity comes from the signed state token, not an authenticated org context. */
export async function getExternalMcpConnectionById(connectionId: ExternalMcpConnectionId): Promise<ExternalMcpConnectionRow | null> {
  const rows = await db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.id, connectionId))
    .limit(1)
  return rows[0] ?? null
}

export async function createExternalMcpConnection(input: {
  organizationId: OrganizationId
  name: string
  url: string
  authType: "oauth" | "apikey" | "none"
  apiKey?: string | null
  createdByOrgMembershipId: OrgMembershipId
}): Promise<ExternalMcpConnectionRow> {
  const id = createDenTypeId("externalMcpConnection")
  await db.insert(ExternalMcpConnectionTable).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    url: input.url,
    authType: input.authType,
    apiKey: input.apiKey ?? null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  const created = await getExternalMcpConnection({ organizationId: input.organizationId, connectionId: id })
  if (!created) throw new Error("Failed to create external MCP connection.")
  return created
}

export async function deleteExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  const existing = await getExternalMcpConnection(input)
  if (!existing) return false
  await db.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, existing.id))
  return true
}

export async function saveExternalMcpPendingCodeVerifier(input: {
  connectionId: ExternalMcpConnectionId
  codeVerifier: string
}): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({ pendingCodeVerifier: input.codeVerifier })
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
}

export async function saveExternalMcpTokens(input: {
  connectionId: ExternalMcpConnectionId
  accessToken: string
  refreshToken?: string | null
  tokenType?: string | null
  scope?: string | null
  expiresAt?: Date | null
}): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      accessToken: input.accessToken,
      ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
      ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      pendingCodeVerifier: null,
      connectedAt: new Date(),
    })
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
}

export async function disconnectExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  const existing = await getExternalMcpConnection(input)
  if (!existing) return false
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      accessToken: null,
      refreshToken: null,
      tokenType: null,
      scope: null,
      expiresAt: null,
      pendingCodeVerifier: null,
      connectedAt: null,
    })
    .where(eq(ExternalMcpConnectionTable.id, existing.id))
  return true
}
