import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  MemberTable,
  OrgOAuthClientTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { requestRead, requestReadMany } from "../request-reads.js"
import { isSandboxMicrosoftClient, resolveSandboxMicrosoftEndpoints, type SandboxMicrosoftEndpoints } from "./sandbox-microsoft-endpoints.js"

export type OrgOAuthClientRow = typeof OrgOAuthClientTable.$inferSelect & {
  sandboxEndpoints?: SandboxMicrosoftEndpoints
}
export type ConnectedAccountRow = typeof ConnectedAccountTable.$inferSelect

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

async function normalizeOrgOAuthClientRow(row: OrgOAuthClientRow): Promise<OrgOAuthClientRow> {
  const normalized = { ...row, extra: normalizeOAuthClientExtra(row.extra) }
  if (!isSandboxMicrosoftClient(normalized.extra)) return normalized
  return { ...normalized, sandboxEndpoints: await resolveSandboxMicrosoftEndpoints(normalized.organizationId) }
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

function orgOAuthClientReadKey(organizationId: OrganizationId, providerId: string) {
  return `org-oauth-client:${organizationId}:${providerId}`
}

export function getOrgOAuthClient(organizationId: OrganizationId, providerId: string): Promise<OrgOAuthClientRow | null> {
  return requestRead(orgOAuthClientReadKey(organizationId, providerId), () => readOrgOAuthClient(organizationId, providerId))
}

export function getOrgOAuthClients(organizationId: OrganizationId, providerIds: readonly string[]): Promise<Map<string, OrgOAuthClientRow | null>> {
  return requestReadMany(providerIds, (providerId) => orgOAuthClientReadKey(organizationId, providerId), async (missing) => {
    const rows = await db
      .select()
      .from(OrgOAuthClientTable)
      .where(and(eq(OrgOAuthClientTable.organizationId, organizationId), inArray(OrgOAuthClientTable.providerId, missing)))
    return new Map(await Promise.all(rows.map(async (row) => [row.providerId, await normalizeOrgOAuthClientRow(row)] as const)))
  }, null)
}

export function getOrgOAuthClientFromPrimary(organizationId: OrganizationId, providerId: string): Promise<OrgOAuthClientRow | null> {
  return readOrgOAuthClient(organizationId, providerId, db.$primary)
}

async function readOrgOAuthClient(organizationId: OrganizationId, providerId: string, database: typeof db.$primary = db): Promise<OrgOAuthClientRow | null> {
  const rows = await database
    .select()
    .from(OrgOAuthClientTable)
    .where(and(eq(OrgOAuthClientTable.organizationId, organizationId), eq(OrgOAuthClientTable.providerId, providerId)))
    .limit(1)
  return rows[0] ? await normalizeOrgOAuthClientRow(rows[0]) : null
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
  id?: DenTypeId<"orgOAuthClient">
}): Promise<OrgOAuthClientRow> {
  const existing = await readOrgOAuthClient(input.organizationId, input.providerId, db.$primary)
  if (existing) {
    await db
      .update(OrgOAuthClientTable)
      .set({
        clientId: input.clientId,
        ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
        ...(input.extra !== undefined ? { extra: input.extra } : {}),
      })
      .where(eq(OrgOAuthClientTable.id, existing.id))
    return (await readOrgOAuthClient(input.organizationId, input.providerId, db.$primary))!
  }

  const id = input.id ?? createDenTypeId("orgOAuthClient")
  await db.insert(OrgOAuthClientTable).values({
    id,
    organizationId: input.organizationId,
    providerId: input.providerId,
    clientId: input.clientId,
    clientSecret: input.clientSecret ?? null,
    extra: input.extra ?? null,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
  })
  return (await readOrgOAuthClient(input.organizationId, input.providerId, db.$primary))!
}

export function getConnectedAccountForListing(input: Parameters<typeof getConnectedAccount>[0]): Promise<ConnectedAccountRow | null> {
  return requestRead(connectedAccountReadKey(input), () => readConnectedAccount(input, db))
}

export function getConnectedAccountsForListing(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  providerIds: readonly string[]
}): Promise<Map<string, ConnectedAccountRow | null>> {
  return requestReadMany(input.providerIds, (providerId) => connectedAccountReadKey({ ...input, providerId }), async (missing) => {
    const rows = await db
      .select()
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, input.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
        inArray(ConnectedAccountTable.providerId, missing),
      ))
    return new Map(rows.map((row) => [row.providerId, normalizeConnectedAccountRow(row)]))
  }, null)
}

function connectedAccountReadKey(input: { organizationId: OrganizationId; orgMembershipId: OrgMembershipId; providerId: string }) {
  return `connected-account:${input.organizationId}:${input.orgMembershipId}:${input.providerId}`
}

export async function getConnectedAccount(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  providerId: string
}): Promise<ConnectedAccountRow | null> {
  return readConnectedAccount(input, db.$primary)
}

async function readConnectedAccount(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  providerId: string
}, database: typeof db.$primary): Promise<ConnectedAccountRow | null> {
  const rows = await database
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
      .set({
        ...connectedAccountChanges(input),
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

export async function completeConnectedAccountForActiveMember(
  input: ConnectedAccountUpsertInput & {
    expectedAccountId: ConnectedAccountRow["id"]
    expectedPendingCodeVerifier: string
  },
): Promise<ConnectedAccountRow | null> {
  return updateExistingConnectedAccountForActiveMember(input)
}

export async function refreshConnectedAccountForActiveMember(
  input: ConnectedAccountUpsertInput & {
    expectedAccountId: ConnectedAccountRow["id"]
    expectedAccessToken: string
    expectedRefreshToken: string
  },
): Promise<ConnectedAccountRow | null> {
  return updateExistingConnectedAccountForActiveMember(input)
}

export async function refreshConnectedAccountExclusively(input: {
  organizationId: OrganizationId
  orgMembershipId: OrgMembershipId
  providerId: string
  expectedAccountId: ConnectedAccountRow["id"]
  isAccessTokenFresh: (expiresAt: Date | null) => boolean
  refresh: (refreshToken: string) => Promise<{
    accessToken: string
    refreshToken?: string
    tokenType?: string
    expiresAt: Date | null
  } | null>
}): Promise<ConnectedAccountRow | null> {
  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(
        eq(MemberTable.id, input.orgMembershipId),
        eq(MemberTable.organizationId, input.organizationId),
        isNull(MemberTable.removedAt),
      ))
      .limit(1)
    if (!member) return null

    const accountKey = and(
      eq(ConnectedAccountTable.organizationId, input.organizationId),
      eq(ConnectedAccountTable.orgMembershipId, input.orgMembershipId),
      eq(ConnectedAccountTable.providerId, input.providerId),
    )
    const [account] = await tx.select().from(ConnectedAccountTable).where(accountKey).limit(1).for("update")
    if (!account || account.id !== input.expectedAccountId || !account.accessToken) return null
    if (input.isAccessTokenFresh(account.expiresAt)) return normalizeConnectedAccountRow(account)
    if (!account.refreshToken) return null

    const refreshed = await input.refresh(account.refreshToken)
    await tx
      .update(ConnectedAccountTable)
      .set(connectedAccountChanges({
        ...input,
        ...(refreshed ? {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? account.refreshToken,
          tokenType: refreshed.tokenType ?? account.tokenType,
          expiresAt: refreshed.expiresAt,
        } : { accessToken: null, refreshToken: null, expiresAt: null }),
      }))
      .where(eq(ConnectedAccountTable.id, account.id))
    if (!refreshed) return null

    const [saved] = await tx.select().from(ConnectedAccountTable).where(accountKey).limit(1)
    return saved ? normalizeConnectedAccountRow(saved) : null
  })
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
