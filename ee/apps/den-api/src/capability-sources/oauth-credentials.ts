import { createHash } from "node:crypto"
import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ExternalMcpConnectionTable,
  MemberTable,
  OrgOAuthClientTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

/**
 * Generic, provider-agnostic reads/writes for the two credential tables.
 * These are the only functions that touch OrgOAuthClientTable /
 * ConnectedAccountTable directly — every provider (native or external MCP)
 * goes through this same, single implementation.
 */

export type OrgOAuthClientRow = typeof OrgOAuthClientTable.$inferSelect
export type ConnectedAccountRow = typeof ConnectedAccountTable.$inferSelect

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">
type ExternalMcpConnectionId = DenTypeId<"externalMcpConnection">
const EXTERNAL_MCP_DCR_LEASE_MS = 60_000
const EXTERNAL_MCP_DCR_WAIT_MS = 45_000

function stateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeOAuthClientExtra(value: unknown): Record<string, unknown> | null {
  const parsed = parsedJson(value)
  return isRecord(parsed) ? parsed : null
}

export function normalizeConnectedAccountScopes(value: unknown): string[] | null {
  const parsed = parsedJson(value)
  if (!Array.isArray(parsed) || !parsed.every((scope) => typeof scope === "string")) return null
  return parsed
}

function normalizeOrgOAuthClientRow(row: OrgOAuthClientRow): OrgOAuthClientRow {
  return { ...row, extra: normalizeOAuthClientExtra(row.extra) }
}

function normalizeConnectedAccountRow(row: ConnectedAccountRow): ConnectedAccountRow {
  return { ...row, scopes: normalizeConnectedAccountScopes(row.scopes) }
}

export type ConnectedAccountUpsertInput = {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  providerId: string
  externalAccountId?: string | null
  scopes?: string[] | null
  accessToken?: string | null
  refreshToken?: string | null
  tokenType?: string | null
  expiresAt?: Date | null
  pendingCodeVerifier?: string | null
}

function connectedAccountChanges(input: ConnectedAccountUpsertInput) {
  return {
    ...(input.externalAccountId !== undefined ? { externalAccountId: input.externalAccountId } : {}),
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    ...(input.accessToken !== undefined ? { accessToken: input.accessToken } : {}),
    ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
    ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.pendingCodeVerifier !== undefined ? { pendingCodeVerifier: input.pendingCodeVerifier } : {}),
  }
}

export async function getOrgOAuthClient(organizationId: OrganizationId, providerId: string): Promise<OrgOAuthClientRow | null> {
  const rows = await db
    .select()
    .from(OrgOAuthClientTable)
    .where(and(eq(OrgOAuthClientTable.organizationId, organizationId), eq(OrgOAuthClientTable.providerId, providerId)))
    .limit(1)
  return rows[0] ? normalizeOrgOAuthClientRow(rows[0]) : null
}

export async function upsertOrgOAuthClient(input: {
  organizationId: OrganizationId
  providerId: string
  clientId: string
  clientSecret?: string | null
  extra?: Record<string, unknown> | null
  createdByOrgMembershipId: OrgMembershipId
}): Promise<OrgOAuthClientRow> {
  const existing = await getOrgOAuthClient(input.organizationId, input.providerId)
  if (existing) {
    await db
      .update(OrgOAuthClientTable)
      .set({
        clientId: input.clientId,
        ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
        ...(input.extra !== undefined ? { extra: input.extra } : {}),
        revision: sql`${OrgOAuthClientTable.revision} + 1`,
      })
      .where(eq(OrgOAuthClientTable.id, existing.id))
    return (await getOrgOAuthClient(input.organizationId, input.providerId))!
  }

  const id = createDenTypeId("orgOAuthClient")
  await db.insert(OrgOAuthClientTable).values({
    id,
    organizationId: input.organizationId,
    providerId: input.providerId,
    clientId: input.clientId,
    clientSecret: input.clientSecret ?? null,
    extra: input.extra ?? null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  return (await getOrgOAuthClient(input.organizationId, input.providerId))!
}

export async function getOrgOAuthClientRevision(input: {
  organizationId: OrganizationId
  providerId: string
  clientId: OrgOAuthClientRow["id"]
  revision: number
}): Promise<OrgOAuthClientRow | null> {
  const rows = await db
    .select()
    .from(OrgOAuthClientTable)
    .where(and(
      eq(OrgOAuthClientTable.organizationId, input.organizationId),
      eq(OrgOAuthClientTable.providerId, input.providerId),
      eq(OrgOAuthClientTable.id, input.clientId),
      eq(OrgOAuthClientTable.revision, input.revision),
    ))
    .limit(1)
  return rows[0] ? normalizeOrgOAuthClientRow(rows[0]) : null
}

export async function getOrClaimExternalMcpClientRegistration(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  signedState: string
  now?: () => Date
  waitMs?: number
}): Promise<{ status: "existing"; client: OrgOAuthClientRow } | { status: "claimed" }> {
  const ownerHash = stateHash(input.signedState)
  const now = input.now ?? (() => new Date())
  const deadline = Date.now() + (input.waitMs ?? EXTERNAL_MCP_DCR_WAIT_MS)
  while (true) {
    const result = await db.transaction(async (tx) => {
      const connections = await tx
        .select()
        .from(ExternalMcpConnectionTable)
        .where(and(
          eq(ExternalMcpConnectionTable.id, input.connectionId),
          eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
        ))
        .limit(1)
        .for("update")
      const connection = connections[0]
      if (!connection) throw new Error("Unknown external MCP connection.")

      const clients = await tx
        .select()
        .from(OrgOAuthClientTable)
        .where(and(
          eq(OrgOAuthClientTable.organizationId, input.organizationId),
          eq(OrgOAuthClientTable.providerId, input.connectionId),
        ))
        .limit(1)
      if (clients[0]) return { status: "existing" as const, client: normalizeOrgOAuthClientRow(clients[0]) }

      const current = now()
      const leaseActive = connection.oauthRegistrationLeaseHash
        && connection.oauthRegistrationLeaseExpiresAt
        && connection.oauthRegistrationLeaseExpiresAt.getTime() > current.getTime()
      if (leaseActive && connection.oauthRegistrationLeaseHash !== ownerHash) {
        return { status: "waiting" as const }
      }
      await tx
        .update(ExternalMcpConnectionTable)
        .set({
          oauthRegistrationLeaseHash: ownerHash,
          oauthRegistrationLeaseExpiresAt: new Date(current.getTime() + EXTERNAL_MCP_DCR_LEASE_MS),
        })
        .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
      return { status: "claimed" as const }
    })
    if (result.status !== "waiting") return result
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the MCP OAuth client registration lease.")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function saveExternalMcpRegisteredClient(input: {
  organizationId: OrganizationId
  connectionId: ExternalMcpConnectionId
  signedState: string
  clientId: string
  clientSecret?: string | null
  safeExtra?: Record<string, unknown> | null
  createdByOrgMembershipId: OrgMembershipId
  now?: Date
}): Promise<OrgOAuthClientRow> {
  const ownerHash = stateHash(input.signedState)
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const connections = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.id, input.connectionId),
        eq(ExternalMcpConnectionTable.organizationId, input.organizationId),
      ))
      .limit(1)
      .for("update")
    const connection = connections[0]
    if (
      !connection
      || connection.oauthRegistrationLeaseHash !== ownerHash
      || !connection.oauthRegistrationLeaseExpiresAt
      || connection.oauthRegistrationLeaseExpiresAt.getTime() <= now.getTime()
    ) throw new Error("The MCP OAuth client registration lease is missing or expired.")

    const existing = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, input.connectionId),
      ))
      .limit(1)
    if (existing[0]) {
      if (existing[0].clientId !== input.clientId) {
        throw new Error("A different MCP OAuth client registration already won this connection.")
      }
    } else {
      await tx.insert(OrgOAuthClientTable).values({
        id: createDenTypeId("orgOAuthClient"),
        organizationId: input.organizationId,
        providerId: input.connectionId,
        clientId: input.clientId,
        clientSecret: input.clientSecret ?? null,
        extra: input.safeExtra ?? null,
        createdByOrgMembershipId: input.createdByOrgMembershipId,
        revision: 1,
      })
    }
    await tx
      .update(ExternalMcpConnectionTable)
      .set({ oauthRegistrationLeaseHash: null, oauthRegistrationLeaseExpiresAt: null })
      .where(eq(ExternalMcpConnectionTable.id, input.connectionId))
    const saved = await tx
      .select()
      .from(OrgOAuthClientTable)
      .where(and(
        eq(OrgOAuthClientTable.organizationId, input.organizationId),
        eq(OrgOAuthClientTable.providerId, input.connectionId),
      ))
      .limit(1)
    if (!saved[0]) throw new Error("Failed to save the MCP OAuth client registration.")
    return normalizeOrgOAuthClientRow(saved[0])
  })
}

export async function getConnectedAccount(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  providerId: string
}): Promise<ConnectedAccountRow | null> {
  const rows = await db
    .select()
    .from(ConnectedAccountTable)
    .where(and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
      eq(ConnectedAccountTable.providerId, input.providerId),
    ))
    .limit(1)
  return rows[0] ? normalizeConnectedAccountRow(rows[0]) : null
}

/** Upsert used both to stash a pending PKCE verifier before redirect, and to save real tokens after exchange. */
export async function upsertConnectedAccount(input: ConnectedAccountUpsertInput): Promise<ConnectedAccountRow> {
  const existing = await getConnectedAccount(input)
  if (existing) {
    await db
      .update(ConnectedAccountTable)
      .set(connectedAccountChanges(input))
      .where(eq(ConnectedAccountTable.id, existing.id))
    return (await getConnectedAccount(input))!
  }

  const id = createDenTypeId("connectedAccount")
  await db.insert(ConnectedAccountTable).values({
    id,
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    providerId: input.providerId,
    externalAccountId: input.externalAccountId ?? null,
    scopes: input.scopes ?? null,
    accessToken: input.accessToken ?? null,
    refreshToken: input.refreshToken ?? null,
    tokenType: input.tokenType ?? null,
    expiresAt: input.expiresAt ?? null,
    pendingCodeVerifier: input.pendingCodeVerifier ?? null,
  })
  return (await getConnectedAccount(input))!
}

/**
 * Update-only credential persistence shared by callback completion and token
 * refresh. The member and exact account are locked before comparing secrets in
 * memory (encrypted DB columns cannot be used as equality predicates).
 */
async function updateExistingConnectedAccountForActiveMember(
  input: ConnectedAccountUpsertInput & {
    expectedAccountId: ConnectedAccountRow["id"]
    expectedAccessToken?: string
    expectedPendingCodeVerifier?: string
    expectedRefreshToken?: string
  },
): Promise<ConnectedAccountRow | null> {
  return db.transaction(async (tx) => {
    const activeMembers = await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(
        eq(MemberTable.id, input.orgMembershipId),
        eq(MemberTable.organizationId, input.organizationId),
        isNull(MemberTable.removedAt),
      ))
      .limit(1)
      .for("update")
    if (!activeMembers[0]) return null

    const existingRows = await tx
      .select()
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
        eq(ConnectedAccountTable.providerId, input.providerId),
      ))
      .limit(1)
      .for("update")
    const existing = existingRows[0]
    if (
      !existing
      || existing.id !== input.expectedAccountId
      || (input.expectedAccessToken !== undefined && existing.accessToken !== input.expectedAccessToken)
      || (input.expectedPendingCodeVerifier !== undefined && existing.pendingCodeVerifier !== input.expectedPendingCodeVerifier)
      || (input.expectedRefreshToken !== undefined && existing.refreshToken !== input.expectedRefreshToken)
    ) return null

    await tx
      .update(ConnectedAccountTable)
      .set(connectedAccountChanges(input))
      .where(eq(ConnectedAccountTable.id, existing.id))

    const saved = await tx
      .select()
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
        eq(ConnectedAccountTable.providerId, input.providerId),
      ))
      .limit(1)
    return saved[0] ? normalizeConnectedAccountRow(saved[0]) : null
  })
}

/**
 * A late callback can only finish the exact pending request it exchanged. A
 * disconnect, client rotation, newer connect attempt, or member removal wins
 * by deleting/changing the row before this update-only transaction commits.
 */
export async function completeConnectedAccountForActiveMember(
  input: ConnectedAccountUpsertInput & {
    expectedAccountId: ConnectedAccountRow["id"]
    expectedPendingCodeVerifier: string
  },
): Promise<ConnectedAccountRow | null> {
  return updateExistingConnectedAccountForActiveMember(input)
}

/** A remote refresh can update only the exact active grant it started from. */
export async function refreshConnectedAccountForActiveMember(
  input: ConnectedAccountUpsertInput & {
    expectedAccountId: ConnectedAccountRow["id"]
    expectedAccessToken: string
    expectedRefreshToken: string
  },
): Promise<ConnectedAccountRow | null> {
  return updateExistingConnectedAccountForActiveMember(input)
}

export async function disconnectAccount(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  providerId: string
}): Promise<boolean> {
  const existing = await getConnectedAccount(input)
  if (!existing) return false
  await db.delete(ConnectedAccountTable).where(eq(ConnectedAccountTable.id, existing.id))
  return true
}

export async function disconnectProviderAccountsForOrganization(input: {
  organizationId: OrganizationId
  providerId: string
}): Promise<void> {
  await db.delete(ConnectedAccountTable).where(and(
    eq(ConnectedAccountTable.organizationId, input.organizationId),
    eq(ConnectedAccountTable.providerId, input.providerId),
  ))
}
