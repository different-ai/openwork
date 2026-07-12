import { and, eq, inArray, or } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ExternalMcpConnectionAccessGrantTable,
  ExternalMcpConnectionTable,
  OrgOAuthClientTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

/**
 * CRUD for ExternalMcpConnectionTable and its access grants — the "add any
 * MCP server" concept. This is the only module that touches these tables
 * directly; the connector (external-mcp-client.ts) and routes go through
 * these functions.
 */

export type ExternalMcpConnectionRow = typeof ExternalMcpConnectionTable.$inferSelect
export type ExternalMcpConnectionAccessGrantRow = typeof ExternalMcpConnectionAccessGrantTable.$inferSelect

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">
type TeamId = DenTypeId<"team">
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

export type ExternalMcpAccessInput = {
  orgWide: boolean
  memberIds: OrgMembershipId[]
  teamIds: TeamId[]
}

export async function createExternalMcpConnection(input: {
  organizationId: OrganizationId
  name: string
  url: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  apiKey?: string | null
  createdByOrgMembershipId: OrgMembershipId
  access: ExternalMcpAccessInput
}): Promise<ExternalMcpConnectionRow> {
  const id = createDenTypeId("externalMcpConnection")
  await db.insert(ExternalMcpConnectionTable).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    url: input.url,
    authType: input.authType,
    credentialMode: input.credentialMode,
    apiKey: input.apiKey ?? null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  await replaceExternalMcpConnectionAccess({
    organizationId: input.organizationId,
    connectionId: id,
    access: input.access,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  const created = await getExternalMcpConnection({ organizationId: input.organizationId, connectionId: id })
  if (!created) throw new Error("Failed to create external MCP connection.")
  return created
}

export async function listExternalMcpConnectionAccess(connectionId: ExternalMcpConnectionId): Promise<ExternalMcpConnectionAccessGrantRow[]> {
  return db
    .select()
    .from(ExternalMcpConnectionAccessGrantTable)
    .where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, connectionId))
}

/** Full-replace semantics (mirrors the LLM-provider access pattern): the caller sends the complete desired access set. */
export async function replaceExternalMcpConnectionAccess(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  access: ExternalMcpAccessInput
  createdByOrgMembershipId: OrgMembershipId
}): Promise<void> {
  await db
    .delete(ExternalMcpConnectionAccessGrantTable)
    .where(eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, input.connectionId))

  const rows: (typeof ExternalMcpConnectionAccessGrantTable.$inferInsert)[] = []
  if (input.access.orgWide) {
    rows.push({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId: input.organizationId,
      externalMcpConnectionId: input.connectionId,
      orgWide: true,
      createdByOrgMembershipId: input.createdByOrgMembershipId,
    })
  } else {
    for (const memberId of new Set(input.access.memberIds)) {
      rows.push({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: input.organizationId,
        externalMcpConnectionId: input.connectionId,
        orgMembershipId: memberId,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
      })
    }
    for (const teamId of new Set(input.access.teamIds)) {
      rows.push({
        id: createDenTypeId("externalMcpConnectionAccessGrant"),
        organizationId: input.organizationId,
        externalMcpConnectionId: input.connectionId,
        teamId,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
      })
    }
  }
  if (rows.length > 0) {
    await db.insert(ExternalMcpConnectionAccessGrantTable).values(rows)
  }
}

/**
 * The one access predicate: a member can USE a connection when a grant is
 * org-wide, names them directly, or names one of their teams. Access is
 * never implicit — zero grants means zero non-admin access.
 */
export async function listUsableExternalMcpConnections(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}): Promise<ExternalMcpConnectionRow[]> {
  const grantFilter = input.teamIds.length > 0
    ? or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, input.orgMembershipId),
        inArray(ExternalMcpConnectionAccessGrantTable.teamId, input.teamIds),
      )
    : or(
        eq(ExternalMcpConnectionAccessGrantTable.orgWide, true),
        eq(ExternalMcpConnectionAccessGrantTable.orgMembershipId, input.orgMembershipId),
      )

  const rows = await db
    .selectDistinct({ connection: ExternalMcpConnectionTable })
    .from(ExternalMcpConnectionTable)
    .innerJoin(
      ExternalMcpConnectionAccessGrantTable,
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, ExternalMcpConnectionTable.id),
    )
    .where(and(eq(ExternalMcpConnectionTable.organizationId, input.organizationId), grantFilter))
  return rows.map((row) => row.connection)
}

export async function memberCanUseExternalMcpConnection(input: {
  connectionId: ExternalMcpConnectionId
  orgMembershipId: OrgMembershipId
  teamIds: TeamId[]
}): Promise<boolean> {
  const grants = await listExternalMcpConnectionAccess(input.connectionId)
  const teamIds = new Set<string>(input.teamIds)
  return grants.some((grant) =>
    grant.orgWide
    || grant.orgMembershipId === input.orgMembershipId
    || (grant.teamId ? teamIds.has(grant.teamId) : false))
}

export async function deleteExternalMcpConnection(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        eq(ExternalMcpConnectionTable.id, input.connectionId),
      ))
      .limit(1)
      .for("update")
    const existing = rows[0]
    if (!existing) return false
    // The enterprise adapter takes the same connection-row lock before any
    // credential commit. Deletion and credential persistence therefore have
    // one deterministic winner; a completed delete cannot be followed by a
    // late token write or orphaned account/client row.
    await tx.delete(ExternalMcpConnectionAccessGrantTable).where(
      eq(ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, existing.id),
    )
    await tx.delete(ConnectedAccountTable).where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.providerId, existing.id),
    ))
    await tx.delete(OrgOAuthClientTable).where(and(
      eq(OrgOAuthClientTable.organizationId, input.organizationId),
      eq(OrgOAuthClientTable.providerId, existing.id),
    ))
    await tx.delete(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, existing.id))
    return true
  })
}

export async function saveExternalMcpPendingCodeVerifier(input: {
  connectionId: ExternalMcpConnectionId
  codeVerifier: string | null
}): Promise<void> {
  await db
    .update(ExternalMcpConnectionTable)
    .set({ pendingCodeVerifier: input.codeVerifier })
    .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
}

export async function clearExternalMcpTokens(input: {
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
      connectedAt: null,
    })
    .where(eq(ExternalMcpConnectionTable.id, existing.id))
  return true
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
  await clearExternalMcpTokens(input)
  await db
    .update(ExternalMcpConnectionTable)
    .set({
      pendingCodeVerifier: null,
    })
    .where(eq(ExternalMcpConnectionTable.id, existing.id))
  return true
}
