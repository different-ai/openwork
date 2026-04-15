import { and, asc, desc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { AuthApiKeyTable, AuthUserTable, MemberTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

export const DEN_API_KEY_HEADER = "x-api-key"
export const DEN_API_KEY_DEFAULT_PREFIX = "den_"
export const DEN_API_KEY_RATE_LIMIT_MAX = 600
export const DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS = 60_000

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
    .where(eq(MemberTable.organizationId, organizationId))
    .orderBy(asc(MemberTable.createdAt))

  if (members.length === 0) {
    return []
  }

  const memberByUserId = new Map(members.map((member) => [member.userId, member]))

  const apiKeys = await db
    .select()
    .from(AuthApiKeyTable)
    .where(inArray(AuthApiKeyTable.referenceId, members.map((member) => member.userId)))
    .orderBy(desc(AuthApiKeyTable.createdAt))

  return apiKeys
    .map((apiKey) => {
      const owner = memberByUserId.get(apiKey.referenceId as UserId)
      const metadata = parseApiKeyMetadata(apiKey.metadata)

      if (!owner || !metadata || metadata.organizationId !== organizationId || metadata.orgMembershipId !== owner.memberId) {
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

export async function getOrganizationApiKeyById(input: {
  organizationId: OrganizationId
  apiKeyId: ApiKeyId
}) {
  const keys = await listOrganizationApiKeys(input.organizationId)
  return keys.find((apiKey) => apiKey.id === input.apiKeyId) ?? null
}

export async function deleteOrganizationApiKey(input: {
  organizationId: OrganizationId
  apiKeyId: ApiKeyId
}) {
  const apiKey = await getOrganizationApiKeyById(input)
  if (!apiKey) {
    return null
  }

  await db
    .delete(AuthApiKeyTable)
    .where(and(eq(AuthApiKeyTable.id, input.apiKeyId), eq(AuthApiKeyTable.referenceId, apiKey.owner.userId)))

  return apiKey
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
