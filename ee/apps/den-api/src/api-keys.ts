import { and, asc, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthApiKeyTable, AuthUserTable, MemberTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { apiKeyAuditColumns, apiKeyDeletedEvent, apiKeyRevokedEvent, type ApiKeyRevocationReason } from "./audit/domain/api-keys.js"
import { appendDomainChanges } from "./audit/domain/legacy.js"
import { currentAuditChangeCapture, fenceAuditChanges, logAuditOutcomeLost, type AuditChangeCapture } from "./audit/request-capture.js"
import { db } from "./db.js"

export const DEN_API_KEY_HEADER = "x-api-key"
export const DEN_API_KEY_DEFAULT_PREFIX = "den_"
export const DEN_API_KEY_RATE_LIMIT_MAX = 600
export const DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS = 60_000
export const DEN_API_KEY_EXPIRES_IN_DAYS = 90
export const DEN_API_KEY_EXPIRES_IN_SECONDS = DEN_API_KEY_EXPIRES_IN_DAYS * 24 * 60 * 60

type UserId = typeof AuthUserTable.$inferSelect.id
type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type OrganizationMemberId = typeof MemberTable.$inferSelect.id
type ApiKeyId = typeof AuthApiKeyTable.$inferSelect.id

export type DenApiKeyMetadata = {
  organizationId: OrganizationId
  orgMembershipId: OrganizationMemberId
  issuedByUserId: UserId
  issuedByOrgMembershipId: OrganizationMemberId
}

export type DenApiKeySession = {
  id: ApiKeyId
  configId: string
  referenceId: string
  metadata: DenApiKeyMetadata | null
}

export type OrganizationApiKeySummary = {
  id: ApiKeyId
  configId: string
  name: string | null
  start: string | null
  prefix: string | null
  enabled: boolean
  rateLimitEnabled: boolean
  rateLimitMax: number | null
  rateLimitTimeWindow: number | null
  lastRequest: Date | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
  owner: {
    userId: UserId
    memberId: OrganizationMemberId
    name: string
    email: string
    image: string | null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseApiKeyMetadata(value: unknown): DenApiKeyMetadata | null {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          return null
        }
      })()
    : value

  if (!isRecord(parsed)) {
    return null
  }

  const organizationId = typeof parsed.organizationId === "string" ? parsed.organizationId : null
  const orgMembershipId = typeof parsed.orgMembershipId === "string" ? parsed.orgMembershipId : null
  const issuedByUserId = typeof parsed.issuedByUserId === "string" ? parsed.issuedByUserId : null
  const issuedByOrgMembershipId = typeof parsed.issuedByOrgMembershipId === "string" ? parsed.issuedByOrgMembershipId : null

  if (!organizationId || !orgMembershipId || !issuedByUserId || !issuedByOrgMembershipId) {
    return null
  }

  return {
    organizationId: organizationId as OrganizationId,
    orgMembershipId: orgMembershipId as OrganizationMemberId,
    issuedByUserId: issuedByUserId as UserId,
    issuedByOrgMembershipId: issuedByOrgMembershipId as OrganizationMemberId,
  }
}

export function buildOrganizationApiKeyMetadata(input: {
  organizationId: OrganizationId
  orgMembershipId: OrganizationMemberId
  issuedByUserId: UserId
  issuedByOrgMembershipId: OrganizationMemberId
}): DenApiKeyMetadata {
  return {
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    issuedByUserId: input.issuedByUserId,
    issuedByOrgMembershipId: input.issuedByOrgMembershipId,
  }
}

export function apiKeyMetadataMatchesOrganizationMember(input: {
  metadata: DenApiKeyMetadata | null
  organizationId: OrganizationId
  orgMembershipId: OrganizationMemberId
}) {
  return input.metadata?.organizationId === input.organizationId && input.metadata.orgMembershipId === input.orgMembershipId
}

export async function getApiKeySessionById(apiKeyId: string): Promise<DenApiKeySession | null> {
  const rows = await db
    .select({
      id: AuthApiKeyTable.id,
      configId: AuthApiKeyTable.configId,
      referenceId: AuthApiKeyTable.referenceId,
      metadata: AuthApiKeyTable.metadata,
    })
    .from(AuthApiKeyTable)
    .where(eq(AuthApiKeyTable.id, apiKeyId))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return null
  }

  return {
    id: row.id,
    configId: row.configId,
    referenceId: row.referenceId,
    metadata: parseApiKeyMetadata(row.metadata),
  }
}

export async function listOrganizationApiKeys(organizationId: OrganizationId): Promise<OrganizationApiKeySummary[]> {
  const members = await db
    .select({
      memberId: MemberTable.id,
      userId: MemberTable.userId,
      userName: AuthUserTable.name,
      userEmail: AuthUserTable.email,
      userImage: AuthUserTable.image,
    })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
    .orderBy(asc(MemberTable.createdAt))

  if (members.length === 0) {
    return []
  }

  const joinedMembers = members.filter((member): member is typeof member & { userId: UserId } => Boolean(member.userId))
  const memberByUserId = new Map(joinedMembers.map((member) => [member.userId, member]))

  const apiKeys = await db
    .select()
    .from(AuthApiKeyTable)
    .where(inArray(AuthApiKeyTable.referenceId, joinedMembers.map((member) => member.userId)))
    .orderBy(desc(AuthApiKeyTable.createdAt))

  return apiKeys
    .map((apiKey) => {
      const owner = memberByUserId.get(apiKey.referenceId as UserId)
      const metadata = parseApiKeyMetadata(apiKey.metadata)

      if (!owner || !apiKeyMetadataMatchesOrganizationMember({ metadata, organizationId, orgMembershipId: owner.memberId })) {
        return null
      }

      return {
        id: apiKey.id,
        configId: apiKey.configId,
        name: apiKey.name,
        start: apiKey.start,
        prefix: apiKey.prefix,
        enabled: apiKey.enabled,
        rateLimitEnabled: apiKey.rateLimitEnabled,
        rateLimitMax: apiKey.rateLimitMax,
        rateLimitTimeWindow: apiKey.rateLimitTimeWindow,
        lastRequest: apiKey.lastRequest,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
        updatedAt: apiKey.updatedAt,
        owner: {
          userId: owner.userId,
          memberId: owner.memberId,
          name: owner.userName,
          email: owner.userEmail,
          image: owner.userImage,
        },
      } satisfies OrganizationApiKeySummary
    })
    .filter((apiKey): apiKey is OrganizationApiKeySummary => apiKey !== null)
}

export async function revokeOrganizationApiKeysForMember(input: {
  organizationId: OrganizationId
  orgMembershipId: OrganizationMemberId
  userId: UserId | null
  reason?: ApiKeyRevocationReason
}) {
  if (!input.userId) {
    return 0
  }
  const userId = input.userId
  const matches = (apiKey: { metadata: string | null }) => apiKeyMetadataMatchesOrganizationMember({
    metadata: parseApiKeyMetadata(apiKey.metadata),
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
  })

  // Implicit revocation is an alternate path to the api_key resource: with the
  // request's change capture active each newly disabled key gets api_key.revoked
  // in the same transaction. Revocation must never be lost to an audit failure,
  // so that falls back to the plain update below with [audit-outcome-lost].
  const capture = currentAuditChangeCapture(input.organizationId)
  if (capture) {
    try {
      return await db.transaction(async (tx) => {
        await fenceAuditChanges(tx, capture)
        const rows = (await tx.select({ ...apiKeyAuditColumns, metadata: AuthApiKeyTable.metadata }).from(AuthApiKeyTable).where(eq(AuthApiKeyTable.referenceId, userId)).for("update")).filter(matches)
        if (rows.length === 0) return 0
        await tx.update(AuthApiKeyTable).set({ enabled: false }).where(inArray(AuthApiKeyTable.id, rows.map((row) => row.id)))
        const owner = { userId, memberId: input.orgMembershipId }
        await appendDomainChanges(tx, capture, rows.map((row) => apiKeyRevokedEvent(input.organizationId, row, owner, input.reason ?? "member_access_changed")))
        return rows.length
      })
    } catch (error) {
      logAuditOutcomeLost({ requestId: capture.context.requestId, organizationId: capture.context.organizationId, action: "api_key.revoked", error })
    }
  }

  const apiKeys = await db
    .select({
      id: AuthApiKeyTable.id,
      metadata: AuthApiKeyTable.metadata,
    })
    .from(AuthApiKeyTable)
    .where(eq(AuthApiKeyTable.referenceId, userId))

  const apiKeyIds = apiKeys.filter(matches).map((apiKey) => apiKey.id)

  if (apiKeyIds.length === 0) {
    return 0
  }

  await db
    .update(AuthApiKeyTable)
    .set({ enabled: false })
    .where(inArray(AuthApiKeyTable.id, apiKeyIds))

  return apiKeyIds.length
}

export async function getOrganizationApiKeyById(input: {
  organizationId: OrganizationId
  apiKeyId: ApiKeyId
}) {
  const keys = await listOrganizationApiKeys(input.organizationId)
  return keys.find((apiKey) => apiKey.id === input.apiKeyId) ?? null
}

/**
 * Deletes one organization API key. With change capture the delete and its
 * api_key.deleted event commit in one transaction (organization share fence
 * first, then the key row); `auditEventIds` lists the appended events.
 */
export async function deleteOrganizationApiKey(input: {
  organizationId: OrganizationId
  apiKeyId: ApiKeyId
}, capture: AuditChangeCapture | null = null) {
  const apiKey = await getOrganizationApiKeyById(input)
  if (!apiKey) {
    return null
  }

  const auditEventIds = await db.transaction(async (tx) => {
    await fenceAuditChanges(tx, capture)
    const scope = and(eq(AuthApiKeyTable.id, input.apiKeyId), eq(AuthApiKeyTable.referenceId, apiKey.owner.userId))
    const [row] = capture ? await tx.select(apiKeyAuditColumns).from(AuthApiKeyTable).where(scope).limit(1).for("update") : []
    await tx.delete(AuthApiKeyTable).where(scope)
    return row ? appendDomainChanges(tx, capture, [apiKeyDeletedEvent(input.organizationId, row, { userId: apiKey.owner.userId, memberId: apiKey.owner.memberId })]) : []
  })

  return { ...apiKey, auditEventIds }
}

export function isScopedApiKeyForOrganization(input: {
  apiKey: DenApiKeySession | null
  organizationId: string
}) {
  return input.apiKey?.metadata?.organizationId === input.organizationId
}

export function getApiKeyScopedOrganizationId(apiKey: DenApiKeySession | null): DenTypeId<"organization"> | null {
  return apiKey?.metadata?.organizationId ?? null
}
