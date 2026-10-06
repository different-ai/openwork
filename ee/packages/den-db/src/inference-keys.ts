import { and, eq, inArray, isNull } from "drizzle-orm"
import {
  createInferenceBearerKey,
  inferenceBearerKeyLookupDigests,
  inferenceBearerKeyPrefix,
  inferenceBearerKeyStorageDigest,
  type InferenceBearerKey,
} from "@openwork-ee/utils/inference-bearer-key"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { createDenDb } from "./client"
import { InferenceKeyTable } from "./schema/inference"
import { MemberTable } from "./schema/org"

/**
 * Shared `ow_inf_` key store used by OpenWork Models, free inference and the Gateway.
 * Every helper runs on the caller's database or transaction and never opens its own,
 * so callers keep their lock order.
 */
type Db = ReturnType<typeof createDenDb>["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Database = Db | Tx

export type InferenceKeyRow = typeof InferenceKeyTable.$inferSelect
type OrgId = InferenceKeyRow["organization_id"]
type MemberId = InferenceKeyRow["org_membership_id"]

export async function mintMemberInferenceKey(tx: Tx, input: { organizationId: OrgId; memberId: MemberId; name?: string }): Promise<InferenceBearerKey> {
  const key = createInferenceBearerKey()
  await tx.insert(InferenceKeyTable).values({
    id: createDenTypeId("inferenceKey"),
    organization_id: input.organizationId,
    org_membership_id: input.memberId,
    name: input.name ?? "OpenWork Models",
    key_hash: await inferenceBearerKeyStorageDigest(key),
    key_prefix: inferenceBearerKeyPrefix(key),
    encrypted_key: key.value,
    status: "active",
  })
  return key
}

export async function findActiveMemberInferenceKey(database: Database, input: { organizationId: OrgId; memberId: MemberId }) {
  const [row] = await database
    .select({ id: InferenceKeyTable.id, encryptedKey: InferenceKeyTable.encrypted_key, keyHash: InferenceKeyTable.key_hash })
    .from(InferenceKeyTable)
    .where(and(
      eq(InferenceKeyTable.organization_id, input.organizationId),
      eq(InferenceKeyTable.org_membership_id, input.memberId),
      eq(InferenceKeyTable.status, "active"),
    ))
    .limit(1)
  return row ?? null
}

/** Active key for a bearer value whose member still belongs to the key's organization. */
export async function findActiveInferenceKeyByBearer(database: Database, key: InferenceBearerKey): Promise<InferenceKeyRow | null> {
  const keyHashes = await inferenceBearerKeyLookupDigests(key)
  const [row] = await database
    .select({ inferenceKey: InferenceKeyTable })
    .from(InferenceKeyTable)
    .innerJoin(MemberTable, eq(InferenceKeyTable.org_membership_id, MemberTable.id))
    .where(and(
      inArray(InferenceKeyTable.key_hash, keyHashes),
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

/** Revokes the member's active keys, then mints a fresh one. Call only when an active key exists. */
export async function rotateMemberInferenceKey(tx: Tx, input: { organizationId: OrgId; memberId: MemberId; name?: string }): Promise<InferenceBearerKey> {
  await tx.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() })
    .where(and(eq(InferenceKeyTable.org_membership_id, input.memberId), eq(InferenceKeyTable.status, "active")))
  return mintMemberInferenceKey(tx, input)
}

/** Backfills the raw value on a legacy row minted before `encrypted_key` existed. */
export async function backfillInferenceKeyValue(tx: Tx, input: { id: InferenceKeyRow["id"]; value: string }): Promise<void> {
  await tx.update(InferenceKeyTable).set({ encrypted_key: input.value }).where(eq(InferenceKeyTable.id, input.id))
}

export async function revokeInferenceKeysForMembers(tx: Tx, memberIds: MemberId[]): Promise<void> {
  if (!memberIds.length) return
  await tx.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() })
    .where(and(inArray(InferenceKeyTable.org_membership_id, memberIds), eq(InferenceKeyTable.status, "active")))
}

export async function revokeInferenceKeysForOrganization(tx: Tx, organizationId: OrgId): Promise<void> {
  await tx.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() })
    .where(and(eq(InferenceKeyTable.organization_id, organizationId), eq(InferenceKeyTable.status, "active")))
}
