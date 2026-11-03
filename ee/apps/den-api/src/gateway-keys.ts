import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayKeyTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createGatewayBearerKey, gatewayBearerKey, gatewayBearerKeyMatchesDigest, gatewayBearerKeyPrefix, gatewayBearerKeyStorageDigest } from "@openwork-ee/utils/gateway-bearer-key"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

async function usableGatewayKey(row: typeof GatewayKeyTable.$inferSelect | undefined): Promise<string | null> {
  if (row?.status !== "active" || row.revoked_at !== null) return null
  try {
    const key = gatewayBearerKey(row.encrypted_key)
    if (await gatewayBearerKeyMatchesDigest(key, row.key_hash)) return key.value
  } catch {
    // Corrupt/non-Gateway material is rotated in this store only, never imported from Models.
  }
  return null
}

/**
 * Member fence serializes issuance/rotation with joins and offboarding, including an empty key store. Every
 * writer of a member's key holds that member's row lock, so the key itself is read without a lock: a locking
 * read of a key that does not exist yet takes a gap lock that other new members of the organization share, and
 * their inserts then deadlock. The read happens after the fence, so it sees every committed change to the key.
 *
 * An active member's usable key is returned from one plain read, without the fence: only writes need it, and
 * a key read just before a concurrent revocation commits is the same answer the request would have had a
 * moment earlier. Everything else (no key, an unusable key, a member who is gone) takes the fenced path.
 */
export async function ensureMemberGatewayKey(input: {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}): Promise<string> {
  const [current] = await db.select({ key: GatewayKeyTable, userId: MemberTable.userId }).from(GatewayKeyTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, GatewayKeyTable.org_membership_id), eq(MemberTable.organizationId, GatewayKeyTable.organization_id)))
    .where(and(eq(GatewayKeyTable.organization_id, input.organizationId), eq(GatewayKeyTable.org_membership_id, input.memberId), isNull(MemberTable.removedAt)))
  const usable = current?.userId ? await usableGatewayKey(current.key) : null
  if (usable) return usable
  return db.transaction(async (tx) => {
    const [member] = await tx.select({ userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt))).for("update")
    if (!member?.userId) throw new Error("member_not_found")
    const [existing] = await tx.select().from(GatewayKeyTable)
      .where(and(eq(GatewayKeyTable.organization_id, input.organizationId), eq(GatewayKeyTable.org_membership_id, input.memberId)))
    const reusable = await usableGatewayKey(existing)
    if (reusable) return reusable
    const key = createGatewayBearerKey()
    const values = {
      encrypted_key: key.value,
      key_hash: await gatewayBearerKeyStorageDigest(key),
      key_prefix: gatewayBearerKeyPrefix(key),
      status: "active" as const,
      revoked_at: null,
      updated_at: new Date(),
    }
    if (existing) await tx.update(GatewayKeyTable).set(values).where(eq(GatewayKeyTable.id, existing.id))
    else await tx.insert(GatewayKeyTable).values({
      id: createDenTypeId("gatewayKey"), organization_id: input.organizationId, org_membership_id: input.memberId, ...values,
    })
    return key.value
  })
}
