import { createHash, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { InferenceKeyTable, InferenceOrgUpstreamProviderKeyTable } from "@openwork-ee/den-db"
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
  const [row] = await db.select().from(InferenceKeyTable).where(eq(InferenceKeyTable.key_hash, sha256(rawKey))).limit(1)
  if (!row || row.status !== "active") {
    return null
  }
  return row
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
