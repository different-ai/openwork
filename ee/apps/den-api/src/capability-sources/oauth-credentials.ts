import { and, eq, gt, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  ConnectedAccountTable,
  MemberTable,
  OrgOAuthClientTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { requestRead } from "../request-reads.js"

/**
 * Generic, provider-agnostic reads/writes for the two credential tables.
 * These are the only functions that touch OrgOAuthClientTable /
 * ConnectedAccountTable directly — every provider (native or external MCP)
 * goes through this same, single implementation.
 */

export type OrgOAuthClientRow = typeof OrgOAuthClientTable.$inferSelect
export type ConnectedAccountRow = typeof ConnectedAccountTable.$inferSelect
export type ConnectedAccountBrowserSession = Pick<typeof AuthSessionTable.$inferSelect, "id" | "token" | "userId">

type OrganizationId = DenTypeId<"organization">
type OrgMembershipId = DenTypeId<"member">

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

export function parseGrantedOAuthScopes(scope: string | undefined): string[] | null {
  return scope === undefined ? null : scope.split(" ").filter(Boolean)
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

/** Shared within the request. A writer reading back its own row uses readOrgOAuthClient. */
export function getOrgOAuthClient(organizationId: OrganizationId, providerId: string): Promise<OrgOAuthClientRow | null> {
  return requestRead(`org-oauth-client:${organizationId}:${providerId}`, () => readOrgOAuthClient(organizationId, providerId))
}

async function readOrgOAuthClient(organizationId: OrganizationId, providerId: string): Promise<OrgOAuthClientRow | null> {
  const rows = await db
    .select()
    .from(OrgOAuthClientTable)
    .where(and(eq(OrgOAuthClientTable.organizationId, organizationId), eq(OrgOAuthClientTable.providerId, providerId)))
    .limit(1)
  return rows[0] ? normalizeOrgOAuthClientRow(rows[0]) : null
}

export async function deleteOrgOAuthClient(organizationId: OrganizationId, providerId: string): Promise<void> {
  await db.delete(OrgOAuthClientTable).where(and(
    eq(OrgOAuthClientTable.organizationId, organizationId),
    eq(OrgOAuthClientTable.providerId, providerId),
  ))
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
  return (await readOrgOAuthClient(input.organizationId, input.providerId))!
}

/**
 * getConnectedAccount for listings and status checks, shared within the request.
 * Code that refreshes or uses a token keeps calling getConnectedAccount, which
 * always reads fresh: a refresh that lost a race re-reads without writing.
 */
export function getConnectedAccountForListing(input: Parameters<typeof getConnectedAccount>[0]): Promise<ConnectedAccountRow | null> {
  return requestRead(`connected-account:${input.organizationId}:${input.orgMembershipId}:${input.providerId}`, () => getConnectedAccount(input))
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
    browserSession?: ConnectedAccountBrowserSession
  },
): Promise<ConnectedAccountRow | null> {
  return db.transaction(async (tx) => {
    const activeMembers = await tx
      .select({ id: MemberTable.id, userId: MemberTable.userId })
      .from(MemberTable)
      .where(and(
        eq(MemberTable.id, input.orgMembershipId),
        eq(MemberTable.organizationId, input.organizationId),
        isNull(MemberTable.removedAt),
      ))
      .limit(1)
      .for("update")
    const activeMember = activeMembers[0]
    if (!activeMember || (input.browserSession && activeMember.userId !== input.browserSession.userId)) return null

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

    // The remote token exchange can outlive browser sign-out or session expiry.
    // Recheck the same signed-cookie session under lock before saving any grant.
    if (input.browserSession) {
      const [liveSession] = await tx
        .select({ expiresAt: AuthSessionTable.expiresAt })
        .from(AuthSessionTable)
        .where(and(
          eq(AuthSessionTable.id, input.browserSession.id),
          eq(AuthSessionTable.token, input.browserSession.token),
          eq(AuthSessionTable.userId, input.browserSession.userId),
          gt(AuthSessionTable.expiresAt, new Date()),
        ))
        .limit(1)
        .for("update")
      if (!liveSession || liveSession.expiresAt.getTime() <= Date.now()) return null
    }

    await tx
      .update(ConnectedAccountTable)
      .set({
        ...connectedAccountChanges(input),
        // Only a completed authorization advances the member's connection marker.
        // Keep it distinct even if two completions share a millisecond.
        ...(input.expectedPendingCodeVerifier !== undefined
          ? { connectedAt: new Date(Math.max(Date.now(), existing.connectedAt.getTime() + 1)) }
          : {}),
      })
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
 * Slack also requires the initiating member's live authorizing browser session;
 * signed OAuth state alone must never authorize storing the returned grant.
 */
export async function completeConnectedAccountForActiveMember(
  input: ConnectedAccountUpsertInput & {
    expectedAccountId: ConnectedAccountRow["id"]
    expectedPendingCodeVerifier: string
    browserSession?: ConnectedAccountBrowserSession
  },
): Promise<ConnectedAccountRow | null> {
  if (input.providerId === "slack" && !input.browserSession) return null
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
