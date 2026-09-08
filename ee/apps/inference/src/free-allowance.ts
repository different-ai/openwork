import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, InferenceFreeReservationTable as Reservation, InferenceFreeUsageBucketTable as Bucket, InferenceKeyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db"
import { freeInferenceAccess, freeInferenceWindow, inferenceAccessMode, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import type { FreeInferenceConfig, InferenceAccess } from "@openwork/types/den/inference"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { freeRequestReservation } from "./free-request.js"
import type { FreeRequestPricing } from "./free-request.js"

function changedOne(result: unknown): boolean {
  if (Array.isArray(result)) return changedOne(result[0])
  if (typeof result !== "object" || result === null) return false
  if ("rowsAffected" in result) return result.rowsAffected === 1
  if ("affectedRows" in result) return result.affectedRows === 1
  return false
}

export type FreeReservationResult = { ok: true; maxOutputTokens: number; access: InferenceAccess } | { ok: false; access: InferenceAccess }

export async function reserveFreeInference(input: {
  keyId: string
  requestId: string
  config: FreeInferenceConfig
  pricing: FreeRequestPricing
}, database = db): Promise<FreeReservationResult> {
  if (!input.requestId.startsWith("free_")) throw new Error("Free reservation requires a free request ID")
  return database.transaction(async (tx) => {
    // Recheck canonical key/membership inside the reservation transaction. A
    // client user ID, org switch or newly issued key cannot choose the bucket.
    const [identity] = await tx.select({
      key: InferenceKeyTable,
      userId: MemberTable.userId,
      metadata: OrganizationTable.metadata,
      nowMs: sql<number>`unix_timestamp(current_timestamp(3)) * 1000`,
    }).from(InferenceKeyTable)
      .innerJoin(MemberTable, eq(InferenceKeyTable.org_membership_id, MemberTable.id))
      .innerJoin(OrganizationTable, eq(InferenceKeyTable.organization_id, OrganizationTable.id))
      .where(and(
        eq(InferenceKeyTable.id, normalizeDenTypeId("inferenceKey", input.keyId)),
        eq(InferenceKeyTable.status, "active"),
        eq(MemberTable.organizationId, InferenceKeyTable.organization_id),
        isNull(MemberTable.removedAt),
      )).limit(1).for("update")
    const mode = identity ? inferenceAccessMode(identity.metadata) : "not_eligible"
    if (!identity?.userId || mode !== "free" || !input.config.enabled) {
      return { ok: false, access: freeInferenceAccess({ config: input.config, mode: mode === "paid" ? "not_eligible" : mode }) }
    }
    // A stable PERSON lock serializes different memberships, keys and weeks.
    // Bucket uniqueness alone cannot prevent two outstanding requests at rollover.
    const [person] = await tx.select({ id: AuthUserTable.id }).from(AuthUserTable)
      .where(eq(AuthUserTable.id, identity.userId)).limit(1).for("update")
    if (!person) return { ok: false, access: freeInferenceAccess({ config: input.config, mode: "not_eligible" }) }
    const now = new Date(Number(identity.nowMs))
    const window = freeInferenceWindow(now)
    const where = and(eq(Bucket.user_id, identity.userId), eq(Bucket.window_start_at, window.start))
    // The unique person/week key serializes concurrent first use as well as
    // existing buckets. Never refresh a limit or reset counters on duplicate.
    await tx.insert(Bucket).values({ user_id: identity.userId, window_start_at: window.start, window_end_at: window.end, limit_amount: input.config.weeklyLimitAmount })
      .onDuplicateKeyUpdate({ set: { user_id: sql`${Bucket.user_id}` } })
    const [bucket] = await tx.select().from(Bucket).where(where).limit(1).for("update")
    if (!bucket) throw new Error("Free allowance bucket unavailable")
    const access = freeInferenceAccess({ config: input.config, mode, bucket, now })
    if (access.kind !== "free") return { ok: false, access }
    // The person lock serializes this first nonlocking read. Do not gap-lock
    // a missing reservation range shared with another person's first insert.
    const [pending] = await tx.select({ status: Reservation.status }).from(Reservation)
      .where(and(eq(Reservation.user_id, identity.userId), sql`${Reservation.status} <> 'settled'`)).limit(1)
    if (pending?.status === "invalid") return { ok: false, access: { ...access, kind: "unavailable", reason: "accounting_unavailable" } }
    if (pending || bucket.reserved_amount > 0) return { ok: false, access: { ...access, reason: "free_request_in_progress" } }
    const reservation = freeRequestReservation(input.pricing, bucket.limit_amount - bucket.used_amount)
    if (!reservation) throw new Error("Invalid free request estimate")
    const updated = await tx.update(Bucket).set({ reserved_amount: reservation.amount }).where(and(
      where, eq(Bucket.blocked, false),
      eq(Bucket.reserved_amount, 0), sql`${Bucket.used_amount} < ${Bucket.limit_amount}`,
    ))
    if (!changedOne(updated)) throw new Error("Free allowance reservation failed closed")
    // Duplicate request IDs roll back the bucket increment. An uncertain commit
    // must not be retried as another upstream request with this reservation.
    await tx.insert(Reservation).values({
      request_id: input.requestId,
      user_id: identity.userId,
      window_start_at: window.start,
      organization_id: identity.key.organization_id,
      org_membership_id: identity.key.org_membership_id,
      inference_key_id: identity.key.id,
      model_id: input.config.modelID,
      upstream_model: input.config.modelID,
      reserved_amount: reservation.amount,
      // Kept in the existing column: this is now an estimate, not an input cap.
      input_token_cap: input.pricing.inputTokenEstimate,
      max_output_tokens: reservation.maxOutputTokens,
      input_token_price: input.pricing.inputTokenPrice,
      output_token_price: input.pricing.outputTokenPrice,
    })
    return { ok: true, maxOutputTokens: reservation.maxOutputTokens, access: freeInferenceAccess({ config: input.config, mode, bucket: { ...bucket, reserved_amount: bucket.reserved_amount + reservation.amount }, now }) }
  }, { isolationLevel: "read committed" })
}

export type FreeSettlement = {
  requestId: string
  inferenceKeyId: string
  orgMembershipId: string
  requestModel: string | null
  responseModel: string | null
  currency: string | null
  eventId: string | null
} & ({ costUsd: number } | { inputCost: number; outputCost: number })

export function freeSettlementAmount(input: FreeSettlement, reservation: Pick<typeof Reservation.$inferSelect, "inference_key_id" | "org_membership_id" | "upstream_model">) {
  const components = "costUsd" in input ? [input.costUsd] : [input.inputCost, input.outputCost]
  const cost = Math.ceil(components.reduce((sum, value) => sum + value, 0) * INFERENCE_USAGE_CONVERSION_FACTOR)
  if (input.inferenceKeyId !== reservation.inference_key_id || input.orgMembershipId !== reservation.org_membership_id
    || input.requestModel !== reservation.upstream_model || input.responseModel !== reservation.upstream_model
    || input.currency !== "USD" || !input.eventId
    || !components.every((value) => Number.isFinite(value) && value >= 0)
    || !Number.isSafeInteger(cost) || cost < 0) return null
  return cost
}

export async function settleFreeInference(input: FreeSettlement, database = db): Promise<boolean> {
  const [owner] = await database.select({ userId: Reservation.user_id }).from(Reservation)
    .where(eq(Reservation.request_id, input.requestId)).limit(1)
  if (!owner) return false
  return database.transaction(async (tx) => {
    // Same lock order as admission, before request and bucket locks. A deleted
    // user cannot admit new work, but their immutable usage can still settle.
    await tx.select({ id: AuthUserTable.id }).from(AuthUserTable)
      .where(eq(AuthUserTable.id, owner.userId)).limit(1).for("update")
    const [reservation] = await tx.select().from(Reservation).where(eq(Reservation.request_id, input.requestId)).limit(1).for("update")
    if (!reservation) return false
    const where = and(eq(Bucket.user_id, reservation.user_id), eq(Bucket.window_start_at, reservation.window_start_at))
    const [bucket] = await tx.select().from(Bucket).where(where).limit(1).for("update")
    if (!bucket) throw new Error("Free settlement bucket unavailable")
    const amount = freeSettlementAmount(input, reservation)
    if (reservation.status === "invalid") return false
    if (amount === null) {
      console.error("[free-inference] rejected usage receipt; hold retained", { requestId: input.requestId })
      return false
    }
    if (reservation.status === "settled") {
      if (input.eventId !== reservation.external_event_id || amount !== reservation.actual_amount) {
        console.error("[free-inference] conflicting duplicate usage receipt", { requestId: input.requestId })
      }
      return false
    }
    if (reservation.status !== "held" || bucket.reserved_amount !== reservation.reserved_amount
      || !Number.isSafeInteger(bucket.used_amount) || bucket.used_amount < 0 || !Number.isSafeInteger(bucket.used_amount + amount)) {
      await tx.update(Bucket).set({ blocked: true }).where(where)
      await tx.update(Reservation).set({ status: "invalid" }).where(eq(Reservation.request_id, input.requestId))
      console.error("[free-inference] accounting invariant violation", { requestId: input.requestId })
      return false
    }
    const updated = await tx.update(Bucket).set({
      reserved_amount: 0,
      used_amount: sql`${Bucket.used_amount} + ${amount}`,
    }).where(and(where, eq(Bucket.reserved_amount, reservation.reserved_amount)))
    if (!changedOne(updated)) throw new Error("Free settlement failed closed")
    await tx.update(Reservation).set({ status: "settled", actual_amount: amount, external_event_id: input.eventId, settled_at: new Date() })
      .where(eq(Reservation.request_id, input.requestId))
    return true
  })
}
