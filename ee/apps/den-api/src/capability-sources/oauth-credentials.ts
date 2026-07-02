import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
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

export async function getOrgOAuthClient(organizationId: OrganizationId, providerId: string): Promise<OrgOAuthClientRow | null> {
  const rows = await db
    .select()
    .from(OrgOAuthClientTable)
    .where(and(eq(OrgOAuthClientTable.organizationId, organizationId), eq(OrgOAuthClientTable.providerId, providerId)))
    .limit(1)
  return rows[0] ?? null
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
  return rows[0] ?? null
}

/** Upsert used both to stash a pending PKCE verifier before redirect, and to save real tokens after exchange. */
export async function upsertConnectedAccount(input: {
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
}): Promise<ConnectedAccountRow> {
  const existing = await getConnectedAccount(input)
  if (existing) {
    await db
      .update(ConnectedAccountTable)
      .set({
        ...(input.externalAccountId !== undefined ? { externalAccountId: input.externalAccountId } : {}),
        ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
        ...(input.accessToken !== undefined ? { accessToken: input.accessToken } : {}),
        ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
        ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.pendingCodeVerifier !== undefined ? { pendingCodeVerifier: input.pendingCodeVerifier } : {}),
      })
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
