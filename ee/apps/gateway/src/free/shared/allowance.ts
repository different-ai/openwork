import { and, count, eq, inArray, lte, sql } from "@openwork-ee/den-db/drizzle"
import {
  DesktopFreeProofNonceTable as Nonce, AnonymousInferenceIdentityTable as Identity,
  AnonymousInferenceControlTable, AnonymousInferenceUsageBucketTable, AnonymousInferenceReservationTable,
  AnonymousInferenceReservationChargeTable, AnonymousInferenceRateBucketTable,
  InferenceFreeControlTable, InferenceFreeUsageBucketTable, InferenceFreeReservationTable,
  InferenceFreeReservationChargeTable, InferenceFreeRateBucketTable,
} from "@openwork-ee/den-db"
import { freeInferenceWindow, INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { DESKTOP_FREE_PROOF_CLOCK_SKEW_MS, type DesktopFreeAccessStatus } from "@openwork/free-auto"
import { freeIdentityHash, freePrincipalHash, memberFreePrincipalAllowed, type FreePrincipal } from "./principal.js"
import { freeRequestReservation, rampedDeviceAmount } from "@openwork/free-auto/accounting"
import type { AutoConfig } from "./config.js"
import { db } from "../../db.js"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
// Guests and members keep separate tables with the same accounting columns. The
// engine is typed against the guest shape; member reservations add ownership columns.
type Tables = { control: typeof AnonymousInferenceControlTable; bucket: typeof AnonymousInferenceUsageBucketTable;
  reservation: typeof AnonymousInferenceReservationTable; charge: typeof AnonymousInferenceReservationChargeTable; rate: typeof AnonymousInferenceRateBucketTable }
const anonymousTables: Tables = { control: AnonymousInferenceControlTable, bucket: AnonymousInferenceUsageBucketTable,
  reservation: AnonymousInferenceReservationTable, charge: AnonymousInferenceReservationChargeTable, rate: AnonymousInferenceRateBucketTable }
const memberTables = { control: InferenceFreeControlTable, bucket: InferenceFreeUsageBucketTable,
  reservation: InferenceFreeReservationTable, charge: InferenceFreeReservationChargeTable, rate: InferenceFreeRateBucketTable } as unknown as Tables
export type FreeAllowanceFamily = "anonymous" | "member"
type Held = typeof AnonymousInferenceReservationTable.$inferSelect & { inference_key_id?: string }
type Scope = "member" | "installation" | "ip" | "global"
export type FreeUsageReceipt = { eventId: string; model: string; amount: number; inputTokens: number; outputTokens: number }
export type FreeAdmission = { ok: true; requestId: string; deadlineAt: number } | { ok: false; code: string }
const controlId = "free-auto"
const active = ["held", "dispatched"] satisfies Held["status"][]

export function freeSettlementDecision(reservation: Pick<Held, "status" | "reserved_amount" | "max_input_tokens" | "max_output_tokens" | "model_id">, receipt: FreeUsageReceipt | null) {
  if (receipt === null) return { amount: reservation.reserved_amount, status: "retained", unsafe: false } as const
  if (!receipt.eventId || receipt.model !== reservation.model_id || ![receipt.amount, receipt.inputTokens, receipt.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) return null
  return { amount: receipt.amount, status: "settled", unsafe: receipt.amount > reservation.reserved_amount
    || receipt.inputTokens > reservation.max_input_tokens || receipt.outputTokens > reservation.max_output_tokens } as const
}
export function freeUsageBucketId(scope: string, identity: string, window: string, start: Date) {
  return freeIdentityHash("free", ["usage", scope, identity, window, start.toISOString()].join(":"))
}
function stableId(parts: string[]) { return freeIdentityHash("free", parts.join(":")) }

export function createFreeAllowanceStore(config: AutoConfig, family: FreeAllowanceFamily, database = db) {
  const { control: Control, bucket: Bucket, reservation: Reservation, charge: Charge, rate: Rate } = family === "member" ? memberTables : anonymousTables
  const owns = (principal: FreePrincipal) => principal.kind === (family === "member" ? "member" : "installation")

  async function lock(tx: Tx) {
    await tx.insert(Control).values({ id: controlId }).onDuplicateKeyUpdate({ set: { id: sql`${Control.id}` } })
    const [row] = await tx.select({ blocked: Control.blocked, nowMs: sql<number>`unix_timestamp(current_timestamp(3)) * 1000` })
      .from(Control).where(eq(Control.id, controlId)).for("update")
    if (!row) throw new Error("Free accounting unavailable")
    return { blocked: row.blocked, now: new Date(Number(row.nowMs)) }
  }
  /**
   * Every signed guest request is a heartbeat: the time since the previous one is credited as
   * active time, unless the gap is long enough to mean the app was closed. Returns the total.
   */
  async function identityActivity(tx: Tx, principal: FreePrincipal, now: Date) {
    if (principal.kind !== "installation") return { activeMs: 0 }
    const [existing] = await tx.select().from(Identity).where(eq(Identity.id, principal.id)).limit(1).for("update")
    if (!existing) {
      await tx.insert(Identity).values({ id: principal.id, first_seen_at: now, last_seen_at: now, active_ms: 0 }).onDuplicateKeyUpdate({ set: { id: sql`${Identity.id}` } })
      return { activeMs: 0 }
    }
    const gap = now.getTime() - existing.last_seen_at.getTime()
    const credit = gap > 0 && gap <= config.activityMaxGapMs ? gap : 0
    const activeMs = existing.active_ms + credit
    if (gap > 0) await tx.update(Identity).set({ last_seen_at: now, active_ms: activeMs }).where(eq(Identity.id, principal.id))
    return { activeMs }
  }
  function specs(principal: FreePrincipal, ipHash: string | null, now: Date, activeMs = 0) {
    const weekly = freeInferenceWindow(now)
    const daily = { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) }
    const monthly = { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) }
    type Spec = { scope: Scope; identity: string; window: "weekly" | "daily" | "monthly"; start: Date; end: Date; limit: number }
    const values: Spec[] = principal.kind === "member" ? [
      { scope: "member", identity: freePrincipalHash(principal), window: "weekly", ...weekly, limit: config.member.weeklyLimitAmount },
      { scope: "global", identity: "global", window: "daily", ...daily, limit: config.memberGlobalDailyAmount },
      { scope: "global", identity: "global", window: "monthly", ...monthly, limit: config.memberGlobalMonthlyAmount },
    ] : [
      { scope: "installation", identity: freePrincipalHash(principal), window: "weekly", ...weekly, limit: rampedDeviceAmount(config, activeMs) },
      { scope: "ip", identity: ipHash ?? "", window: "daily", ...daily, limit: config.ipDailyAmount },
      { scope: "global", identity: "global", window: "daily", ...daily, limit: config.globalDailyAmount },
      { scope: "global", identity: "global", window: "monthly", ...monthly, limit: config.globalMonthlyAmount },
    ]
    if (values.some((value) => !value.identity)) throw new Error("Free accounting identity unavailable")
    return values.map((value) => ({ ...value, id: freeUsageBucketId(value.scope, value.identity, value.window, value.start) }))
  }
  const chargeCount = family === "member" ? 3 : 4
  async function consumeRates(tx: Tx, limits: Array<{ kind: string; identity: string; limit: number; window?: "hour" | "day" }>, now: Date) {
    const rates = limits.map((value) => {
      const start = new Date(now)
      if (value.window === "day") start.setUTCHours(0, 0, 0, 0); else start.setUTCMinutes(0, 0, 0)
      const expiresAt = new Date(start.getTime() + (value.window === "day" ? 86400000 : 3600000))
      return { ...value, expiresAt, id: stableId(["rate", value.kind, value.identity, start.toISOString()]) }
    })
    for (const rate of rates) {
      const [row] = await tx.select().from(Rate).where(eq(Rate.id, rate.id)).limit(1)
      if (row && row.used_amount >= rate.limit) return false
    }
    for (const rate of rates) await tx.insert(Rate).values({ id: rate.id, used_amount: 1, expires_at: rate.expiresAt })
      .onDuplicateKeyUpdate({ set: { used_amount: sql`${Rate.used_amount} + 1` } })
    return true
  }
  /** settle: charge the receipt (or retain the hold); cancel: undispatched only; release: provider refused it, nothing was billed. */
  async function finish(tx: Tx, reservation: Held, receipt: FreeUsageReceipt | null, mode: "settle" | "cancel" | "release" = "settle") {
    if (reservation.status !== "held" && reservation.status !== "dispatched") return false
    if (mode === "cancel" && reservation.status !== "held") return false
    const decision = mode === "settle" ? freeSettlementDecision(reservation, receipt) : { amount: 0, status: "cancelled", unsafe: false } as const
    if (!decision) return false
    const charges = await tx.select().from(Charge).where(eq(Charge.request_id, reservation.request_id))
    if (charges.length !== chargeCount) throw new Error("Free accounting charge invariant")
    for (const charge of charges) {
      const [bucket] = await tx.select().from(Bucket).where(eq(Bucket.id, charge.bucket_id)).limit(1).for("update")
      if (!bucket || bucket.reserved_amount < charge.reserved_amount || charge.reserved_amount !== reservation.reserved_amount
        || !Number.isSafeInteger(bucket.used_amount + decision.amount)) throw new Error("Free accounting bucket invariant")
      await tx.update(Bucket).set({ reserved_amount: bucket.reserved_amount - charge.reserved_amount,
        used_amount: bucket.used_amount + decision.amount }).where(eq(Bucket.id, bucket.id))
    }
    if (decision.unsafe) await tx.update(Control).set({ blocked: true }).where(eq(Control.id, controlId))
    await tx.update(Reservation).set({ status: decision.status, actual_amount: decision.amount,
      external_event_id: receipt?.eventId ?? null }).where(eq(Reservation.request_id, reservation.request_id))
    return true
  }
  async function reap(tx: Tx, now: Date) {
    const expired = await tx.select().from(Reservation).where(and(inArray(Reservation.status, active), lte(Reservation.expires_at, now))).limit(100).for("update")
    for (const reservation of expired) await finish(tx, reservation, null)
  }
  async function byRequest(tx: Tx, requestId: string): Promise<Held | undefined> {
    const [reservation] = await tx.select().from(Reservation).where(eq(Reservation.request_id, requestId)).limit(1).for("update")
    return reservation
  }

  return {
    family,
    async consumeNonce(proof: { keyThumbprint: string; nonce: string; timestamp: number }, ipHash: string): Promise<"accepted" | "replay" | "unavailable"> {
      if (family !== "anonymous") return "unavailable"
      return database.transaction(async (tx) => {
        const { now } = await lock(tx)
        if (Math.abs(now.getTime() - proof.timestamp) > DESKTOP_FREE_PROOF_CLOCK_SKEW_MS) return "unavailable"
        await tx.delete(Nonce).where(lte(Nonce.expires_at, now)).limit(1000)
        await tx.delete(Rate).where(lte(Rate.expires_at, now)).limit(1000)
        const id = stableId(["nonce", proof.keyThumbprint, proof.nonce.toLowerCase()])
        const [existing] = await tx.select().from(Nonce).where(eq(Nonce.id, id)).limit(1)
        if (existing) return "replay"
        if (!await consumeRates(tx, [{ kind: "proof-ip", identity: ipHash, limit: 1200 },
          { kind: "proof-global", identity: "global", limit: 40000 }], now)) return "unavailable"
        const [total] = await tx.select({ amount: count() }).from(Nonce)
        if (Number(total?.amount ?? 0) >= 50000) return "unavailable"
        await tx.insert(Nonce).values({ id, expires_at: new Date(proof.timestamp + DESKTOP_FREE_PROOF_CLOCK_SKEW_MS + 1000) })
        return "accepted"
      })
    },
    /** Mints a guest session. A machine never seen before also counts against the IP's daily new-identity cap. */
    async consumeSession(ipHash: string, installationHash: string): Promise<"accepted" | "capacity" | "new_identity_capped"> {
      if (family !== "anonymous") return "capacity"
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        if (blocked) return "capacity"
        const [known] = await tx.select({ id: Identity.id }).from(Identity).where(eq(Identity.id, installationHash)).limit(1)
        if (!known && !await consumeRates(tx, [{ kind: "new-identity-ip", identity: ipHash, limit: config.ipNewIdentitiesPerDay, window: "day" }], now)) return "new_identity_capped"
        if (!await consumeRates(tx, [{ kind: "session-ip", identity: ipHash, limit: 60 },
          { kind: "session-installation", identity: installationHash, limit: 12 },
          { kind: "session-global", identity: "global", limit: 10000 }], now)) return "capacity"
        await identityActivity(tx, { kind: "installation", id: installationHash }, now)
        return "accepted"
      })
    },
    async read(principal: FreePrincipal, ipHash: string | null): Promise<Pick<DesktopFreeAccessStatus, "state" | "code" | "allowance">> {
      if (!owns(principal)) return { state: "unavailable", code: "free_principal_rejected", allowance: null }
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        if (!await memberFreePrincipalAllowed(principal, tx)) return { state: "unavailable", code: "free_principal_rejected", allowance: null }
        await reap(tx, now)
        const { activeMs } = await identityActivity(tx, principal, now)
        let allowance: DesktopFreeAccessStatus["allowance"] = null
        let limited = false, sharedLimited = false
        for (const spec of specs(principal, ipHash, now, activeMs)) {
          const [row] = await tx.select().from(Bucket).where(eq(Bucket.id, spec.id)).limit(1)
          // A guest bucket's limit only grows as the identity ages within the week.
          const limit = row ? (spec.scope === "installation" ? Math.max(row.limit_amount, spec.limit) : row.limit_amount) : spec.limit
          const used = row?.used_amount ?? 0, reserved = row?.reserved_amount ?? 0
          const cannotFit = used + reserved + freeRequestReservation(config) > limit
          if (spec.scope === "member" || spec.scope === "installation") {
            limited = cannotFit
            allowance = { limitUsd: limit / INFERENCE_USAGE_CONVERSION_FACTOR, usedUsd: used / INFERENCE_USAGE_CONVERSION_FACTOR,
              reservedUsd: reserved / INFERENCE_USAGE_CONVERSION_FACTOR, remainingUsd: Math.max(0, limit - used - reserved) / INFERENCE_USAGE_CONVERSION_FACTOR,
              resetsAt: spec.end.toISOString() }
          } else sharedLimited ||= cannotFit
        }
        if (blocked) return { state: "unavailable", code: "free_accounting_blocked", allowance }
        const [pending] = await tx.select({ id: Reservation.request_id }).from(Reservation)
          .where(and(eq(Reservation.principal_hash, freePrincipalHash(principal)), inArray(Reservation.status, active))).limit(1)
        if (pending) return { state: "unavailable", code: "free_request_in_progress", allowance }
        if (limited) return { state: "exhausted", code: "anonymous_reservation_does_not_fit", allowance }
        if (sharedLimited) return { state: "unavailable", code: "anonymous_capacity_exceeded", allowance }
        return { state: "ready", code: null, allowance }
      })
    },
    async reserve(principal: FreePrincipal, ipHash: string | null, requestId: string, deadlineAt: number): Promise<FreeAdmission> {
      if (!owns(principal)) return { ok: false, code: "free_principal_rejected" }
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        if (blocked || now.getTime() >= deadlineAt || !await memberFreePrincipalAllowed(principal, tx)) return { ok: false, code: "free_principal_rejected" }
        await reap(tx, now)
        const principalHash = freePrincipalHash(principal)
        const [pending] = await tx.select({ id: Reservation.request_id }).from(Reservation)
          .where(and(eq(Reservation.principal_hash, principalHash), inArray(Reservation.status, active))).limit(1)
        if (pending) return { ok: false, code: "free_request_in_progress" }
        const [inflight] = await tx.select({ amount: count() }).from(Reservation).where(inArray(Reservation.status, active))
        if (Number(inflight?.amount ?? 0) >= config.globalInflight) return { ok: false, code: "anonymous_capacity_exceeded" }
        const rates = [{ kind: "request-principal", identity: principalHash, limit: 60 }, { kind: "request-global", identity: "global", limit: 10000 }]
        if (ipHash) rates.push({ kind: "request-ip", identity: ipHash, limit: 300 })
        if (!await consumeRates(tx, rates, now)) return { ok: false, code: "anonymous_capacity_exceeded" }
        const amount = freeRequestReservation(config)
        const rows: Array<typeof Bucket.$inferSelect> = []
        const { activeMs } = await identityActivity(tx, principal, now)
        for (const spec of specs(principal, ipHash, now, activeMs)) {
          await tx.insert(Bucket).values({ id: spec.id, scope: spec.scope as typeof Bucket.$inferInsert.scope, identity_hash: spec.identity, window_type: spec.window,
            window_start_at: spec.start, window_end_at: spec.end, limit_amount: spec.limit })
            .onDuplicateKeyUpdate({ set: spec.scope === "installation" ? { limit_amount: sql`greatest(${Bucket.limit_amount}, ${spec.limit})` } : { id: sql`${Bucket.id}` } })
          const [row] = await tx.select().from(Bucket).where(eq(Bucket.id, spec.id)).limit(1).for("update")
          if (!row || row.blocked) return { ok: false, code: "free_accounting_blocked" }
          if (!Number.isSafeInteger(row.used_amount + row.reserved_amount + amount) || row.used_amount + row.reserved_amount + amount > row.limit_amount) {
            return { ok: false, code: spec.scope === "global" || spec.scope === "ip" ? "anonymous_capacity_exceeded" : "anonymous_limit_exceeded" }
          }
          rows.push(row)
        }
        const expiresAt = Math.min(deadlineAt, now.getTime() + config.requestTimeoutMs)
        if (Date.now() >= expiresAt) return { ok: false, code: "anonymous_unavailable" }
        const owner = principal.kind === "member"
          ? { organization_id: principal.organizationId, org_membership_id: principal.memberId, inference_key_id: principal.inferenceKeyId } : {}
        await tx.insert(Reservation).values({ request_id: requestId, principal_hash: principalHash, model_id: INFERENCE_FREE_MODEL_ID,
          reserved_amount: amount, max_input_tokens: config.maxInputTokens, max_output_tokens: config.maxCompletionTokens,
          expires_at: new Date(expiresAt + 30000), ...owner })
        for (const row of rows) {
          await tx.update(Bucket).set({ reserved_amount: row.reserved_amount + amount }).where(eq(Bucket.id, row.id))
          await tx.insert(Charge).values({ id: stableId([requestId, row.id]), request_id: requestId, bucket_id: row.id, reserved_amount: amount })
        }
        return { ok: true, requestId, deadlineAt: expiresAt }
      })
    },
    async dispatch(requestId: string, principal: FreePrincipal, deadlineAt: number) {
      if (!owns(principal)) return false
      return database.transaction(async (tx) => {
        const { blocked, now } = await lock(tx)
        const reservation = await byRequest(tx, requestId)
        if (!reservation || reservation.status !== "held" || reservation.principal_hash !== freePrincipalHash(principal)
          || (principal.kind === "member" && reservation.inference_key_id !== principal.inferenceKeyId)) return false
        if (blocked || now.getTime() >= deadlineAt || !await memberFreePrincipalAllowed(principal, tx)) {
          await finish(tx, reservation, null, "cancel")
          return false
        }
        await tx.update(Reservation).set({ status: "dispatched" }).where(eq(Reservation.request_id, requestId))
        return true
      })
    },
    async cancelUndispatched(requestId: string) {
      return database.transaction(async (tx) => {
        await lock(tx)
        const reservation = await byRequest(tx, requestId)
        return reservation ? finish(tx, reservation, null, "cancel") : false
      })
    },
    /** OpenAI rejected the request before generating (bad key, forbidden, rate limited): it was not billed. */
    async release(requestId: string) {
      return database.transaction(async (tx) => {
        await lock(tx)
        const reservation = await byRequest(tx, requestId)
        return reservation ? finish(tx, reservation, null, "release") : false
      })
    },
    async settle(requestId: string, receipt: FreeUsageReceipt | null) {
      return database.transaction(async (tx) => {
        await lock(tx)
        const reservation = await byRequest(tx, requestId)
        if (!reservation) return false
        if (reservation.status === "retained") {
          const decision = freeSettlementDecision(reservation, receipt)
          if (decision?.unsafe) await tx.update(Control).set({ blocked: true }).where(eq(Control.id, controlId))
          return false
        }
        return finish(tx, reservation, receipt)
      })
    },
  }
}
export type FreeAllowanceStore = ReturnType<typeof createFreeAllowanceStore>
