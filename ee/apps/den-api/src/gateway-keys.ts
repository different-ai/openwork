import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayKeyTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createGatewayBearerKey, gatewayBearerKey, gatewayBearerKeyMatchesDigest, gatewayBearerKeyPrefix, gatewayBearerKeyStorageDigest } from "@openwork-ee/utils/gateway-bearer-key"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

/** Member fence serializes issuance/rotation with joins and offboarding, including an empty key store. */
export async function ensureMemberGatewayKey(input: {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}): Promise<string> {
  return db.transaction(async (tx) => {
    const [member] = await tx.select({ userId: MemberTable.userId }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId), isNull(MemberTable.removedAt))).for("update")
    if (!member?.userId) throw new Error("member_not_found")
    const [existing] = await tx.select().from(GatewayKeyTable)
      .where(and(eq(GatewayKeyTable.organization_id, input.organizationId), eq(GatewayKeyTable.org_membership_id, input.memberId))).for("update")
    if (existing?.status === "active" && existing.revoked_at === null) {
      try {
        const key = gatewayBearerKey(existing.encrypted_key)
        if (await gatewayBearerKeyMatchesDigest(key, existing.key_hash)) return key.value
      } catch {
        // Corrupt/non-Gateway material is rotated in this store only, never imported from Models.
      }
    }
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
