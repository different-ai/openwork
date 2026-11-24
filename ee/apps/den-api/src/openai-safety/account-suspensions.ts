import { createHash } from "node:crypto"
import { and, desc, eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, FreeAutoSafetyCaseTable as Cases, FundedModelSuspensionTable as Holds } from "@openwork-ee/den-db/schema"
import { fundedUserSuspended } from "@openwork-ee/den-db"
import { readFeatures } from "@openwork-ee/den-db/organization-features"
import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"

const hash = (reference: string) => createHash("sha256").update(reference).digest("hex")
export async function suspensionEnforced() {
  return (await readFeatures(db.$primary, null, env.features)).fundedModelAccountSuspensions
}
export async function assertFundedUserAllowed(userId: string) {
  if (await suspensionEnforced() && await fundedUserSuspended(db.$primary, userId)) throw new Error("funded_model_account_suspended")
}

export async function applyProviderSuspension(reference: string, target: string, reviewer: string) {
  const userId = normalizeDenTypeId("user", target)
  const key = hash(reference)
  return db.transaction(async tx => {
    const [user] = await tx.select({ id: AuthUserTable.id }).from(AuthUserTable).where(eq(AuthUserTable.id, userId)).limit(1)
    if (!user) return "missing"
    const [notice] = await tx.select({ identifier: Cases.identifier }).from(Cases).where(eq(Cases.case_key, key))
    if (notice?.identifier && notice.identifier !== freeInferenceDigest("member", userId)) return "conflict"
    await tx.insert(Holds).values({ reference_hash: key, provider_reference: reference, user_id: userId, suspended_by: normalizeDenTypeId("user", reviewer) })
      .onDuplicateKeyUpdate({ set: { reference_hash: key } })
    const [existing] = await tx.select().from(Holds).where(eq(Holds.reference_hash, key)).for("update")
    return existing?.user_id === userId && existing.released_at === null ? "ok" : "conflict"
  })
}
export async function releaseProviderSuspension(reference: string, target: string, authorization: string, reviewer: string) {
  if (reference === authorization) return "conflict"
  const key = hash(reference)
  const userId = normalizeDenTypeId("user", target)
  return db.transaction(async tx => {
    const [row] = await tx.select().from(Holds).where(and(eq(Holds.reference_hash, key), eq(Holds.user_id, userId))).for("update")
    if (!row) return "missing"
    if (row.released_at) return row.release_reference === authorization ? "ok" : "conflict"
    await tx.update(Holds).set({ released_at: new Date(), released_by: normalizeDenTypeId("user", reviewer), release_reference: authorization })
      .where(eq(Holds.reference_hash, key))
    return "ok"
  })
}
export async function fundedSuspensionStatus(target: string) {
  const userId = normalizeDenTypeId("user", target)
  const [enforcementEnabled, active, rows] = await Promise.all([
    suspensionEnforced(), fundedUserSuspended(db.$primary, userId),
    db.$primary.select().from(Holds).where(eq(Holds.user_id, userId)).orderBy(desc(Holds.suspended_at), desc(Holds.reference_hash)).limit(50),
  ])
  return { userId, enforcementEnabled, suspended: active, recent: rows.map(r => ({
    reference: r.provider_reference, suspendedAt: r.suspended_at.toISOString(), suspendedBy: r.suspended_by,
    releasedAt: r.released_at?.toISOString() ?? null, releasedBy: r.released_by, releaseReference: r.release_reference,
  })) }
}
