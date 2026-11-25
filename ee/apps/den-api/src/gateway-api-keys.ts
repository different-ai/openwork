import { and, count, desc, eq, gt, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, GatewayApiKeyTable, MemberTable } from "@openwork-ee/den-db/schema"
import {
  GATEWAY_API_KEY_MEMBER_LIMIT,
  readOrganizationAiGatewaySettings,
  type CreatedGatewayApiKey,
  type GatewayApiKey,
  type OrganizationGatewayApiKey,
} from "@openwork/types/den/gateway-api-keys"
import { createGatewayBearerKey, gatewayBearerKeyPrefix, gatewayBearerKeyStorageDigest } from "@openwork-ee/utils/gateway-bearer-key"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type MemberId = typeof MemberTable.$inferSelect.id
type ApiKeyRow = typeof GatewayApiKeyTable.$inferSelect

export class GatewayApiKeyLimitError extends Error {
  constructor() {
    super("gateway_api_key_limit")
  }
}

export function memberApiKeysAllowed(metadata: unknown): boolean {
  return readOrganizationAiGatewaySettings(metadata).memberApiKeys
}

export function gatewayApiBaseUrl(): string {
  return `${env.gatewayPublicBaseUrl.replace(/\/+$/, "")}/api/v1`
}

function toGatewayApiKey(row: Pick<ApiKeyRow, "id" | "name" | "key_prefix" | "created_at" | "last_used_at" | "expires_at">): GatewayApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
  }
}

export async function listMemberGatewayApiKeys(input: { organizationId: OrganizationId; memberId: MemberId }): Promise<GatewayApiKey[]> {
  const rows = await db.select().from(GatewayApiKeyTable)
    .where(and(
      eq(GatewayApiKeyTable.organization_id, input.organizationId),
      eq(GatewayApiKeyTable.org_membership_id, input.memberId),
      eq(GatewayApiKeyTable.status, "active"),
    ))
    .orderBy(desc(GatewayApiKeyTable.created_at))
  return rows.map(toGatewayApiKey)
}

export async function createMemberGatewayApiKey(input: { organizationId: OrganizationId; memberId: MemberId; name: string; expiresAt: Date | null }): Promise<CreatedGatewayApiKey> {
  return db.transaction(async (tx) => {
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt)))
      .for("update")
    if (!member) throw new Error("member_not_found")
    const [active] = await tx.select({ total: count() }).from(GatewayApiKeyTable)
      .where(and(
        eq(GatewayApiKeyTable.organization_id, input.organizationId),
        eq(GatewayApiKeyTable.org_membership_id, input.memberId),
        eq(GatewayApiKeyTable.status, "active"),
        or(isNull(GatewayApiKeyTable.expires_at), gt(GatewayApiKeyTable.expires_at, new Date())),
      ))
    if ((active?.total ?? 0) >= GATEWAY_API_KEY_MEMBER_LIMIT) throw new GatewayApiKeyLimitError()
    const key = createGatewayBearerKey()
    const now = new Date()
    const row = {
      id: createDenTypeId("gatewayApiKey"),
      organization_id: input.organizationId,
      org_membership_id: input.memberId,
      name: input.name,
      key_hash: await gatewayBearerKeyStorageDigest(key),
      key_prefix: gatewayBearerKeyPrefix(key),
      status: "active" as const,
      created_at: now,
      updated_at: now,
      last_used_at: null,
      expires_at: input.expiresAt,
    }
    await tx.insert(GatewayApiKeyTable).values(row)
    return { apiKey: toGatewayApiKey(row), key: key.value }
  })
}

export async function revokeGatewayApiKey(input: {
  organizationId: OrganizationId
  apiKeyId: ApiKeyRow["id"]
  revokedByMemberId: MemberId
  ownerMemberId?: MemberId
}): Promise<boolean> {
  const now = new Date()
  const result = await db.update(GatewayApiKeyTable)
    .set({ status: "revoked", revoked_at: now, revoked_by_org_membership_id: input.revokedByMemberId, updated_at: now })
    .where(and(
      eq(GatewayApiKeyTable.id, input.apiKeyId),
      eq(GatewayApiKeyTable.organization_id, input.organizationId),
      eq(GatewayApiKeyTable.status, "active"),
      input.ownerMemberId === undefined ? undefined : eq(GatewayApiKeyTable.org_membership_id, input.ownerMemberId),
    ))
  return affectedRows(result) > 0
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

export async function listOrganizationGatewayApiKeys(organizationId: OrganizationId): Promise<OrganizationGatewayApiKey[]> {
  const rows = await db.select({
    key: GatewayApiKeyTable,
    member: { id: MemberTable.id },
    user: { name: AuthUserTable.name, email: AuthUserTable.email, image: AuthUserTable.image },
  }).from(GatewayApiKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, GatewayApiKeyTable.org_membership_id), eq(MemberTable.organizationId, GatewayApiKeyTable.organization_id)))
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(GatewayApiKeyTable.organization_id, organizationId), eq(GatewayApiKeyTable.status, "active"), isNull(MemberTable.removedAt)))
    .orderBy(desc(GatewayApiKeyTable.created_at))
  return rows.map((row) => ({
    ...toGatewayApiKey(row.key),
    member: { id: row.member.id, name: row.user.name, email: row.user.email, image: row.user.image ?? null },
  }))
}
