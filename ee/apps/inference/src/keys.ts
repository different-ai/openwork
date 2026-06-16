import { createHash, timingSafeEqual } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { InferenceKeyTable, InferenceOrgUpstreamProviderKeyTable, MemberTable } from "@openwork-ee/den-db"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export function constantTimeEquals(a: string, b: string) {
  const left = new Uint8Array(Buffer.from(a))
  const right = new Uint8Array(Buffer.from(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function findActiveInferenceKey(rawKey: string) {
  const [row] = await db
    .select({ inferenceKey: InferenceKeyTable })
    .from(InferenceKeyTable)
    .innerJoin(MemberTable, eq(InferenceKeyTable.org_membership_id, MemberTable.id))
    .where(and(
      eq(InferenceKeyTable.key_hash, sha256(rawKey)),
      eq(InferenceKeyTable.status, "active"),
      eq(MemberTable.organizationId, InferenceKeyTable.organization_id),
      isNull(MemberTable.removedAt),
    ))
    .limit(1)
  if (!row) {
    return null
  }
  return row.inferenceKey
}

export async function getOpenRouterProviderKey(organizationId: string) {
  const rows = await db.select().from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(
      eq(InferenceOrgUpstreamProviderKeyTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(InferenceOrgUpstreamProviderKeyTable.provider, "openrouter"),
      eq(InferenceOrgUpstreamProviderKeyTable.status, "active"),
    ))
    .limit(1)
  return rows[0] ?? null
}
