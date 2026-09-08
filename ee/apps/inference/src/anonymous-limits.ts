// Bounded reuse from #4621 (401267fc): atomic conservative admission/settlement.
import { createHash } from "node:crypto"
import { and, count, eq, gt, lte, sql } from "@openwork-ee/den-db/drizzle"
import {
  AnonymousInferenceControlTable,
  AnonymousInferenceRateBucketTable,
  AnonymousInferenceReservationChargeTable,
  AnonymousInferenceReservationTable,
  AnonymousInferenceUsageBucketTable,
  DesktopFreeProofNonceTable,
} from "@openwork-ee/den-db"
import { DESKTOP_FREE_PROOF_CLOCK_SKEW_MS, type DesktopFreeAccessStatus } from "@openwork/types/desktop-free-access"
import { freeInferenceWindow } from "@openwork/types/den/inference"
import { db } from "./db.js"
import { env } from "./env.js"
import type { AnonymousIdentities } from "./anonymous-identity.js"

const controlId = "anonymous-inference-global"
const upstreamCostSafetyNumerator = 11
const upstreamCostSafetyDenominator = 10

type AdmissionFailure = {
  ok: false
  reason: "limit" | "capacity" | "unavailable"
  retryAfterSeconds?: number
}

type RateSpec = {
  id: string
  kind: "session" | "request"
  scope: "installation" | "ip" | "global"
  identityHash: string
  start: Date
  end: Date
  limit: number
}

type UsageSpec = {
  id: string
  scope: "installation" | "ip" | "global"
  identityHash: string
  windowType: "daily" | "monthly" | "weekly"
  start: Date
  end: Date
  limitMicroUsd: number
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

function stableId(parts: string[]) {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex")
}

function hourlyWindow(now: Date) {
  const start = new Date(now)
  start.setUTCMinutes(0, 0, 0)
  return { start, end: new Date(start.getTime() + 60 * 60 * 1000) }
}

function dailyWindow(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) }
}

function monthlyWindow(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end }
}

function retryAfterSeconds(end: Date, now: Date) {
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000))
}

async function lockControl(tx: Transaction) {
  const [control] = await tx.select().from(AnonymousInferenceControlTable)
    .where(eq(AnonymousInferenceControlTable.id, controlId)).limit(1).for("update")
  if (!control) throw new Error("Anonymous inference control row is unavailable")
  return control
}

export async function consumeDesktopFreeNonce(proof: { keyThumbprint: string; nonce: string; timestamp: number }): Promise<"accepted" | "replay" | "unavailable"> {
  return db.transaction(async (tx) => {
    await lockControl(tx)
    const now = new Date()
    if (Math.abs(now.getTime() - proof.timestamp) > DESKTOP_FREE_PROOF_CLOCK_SKEW_MS) return "unavailable"
    // Bounded TTL cleanup and cardinality prevent self-signed registration churn
    // from growing nonce storage without limit, even before issuance rate checks.
    await tx.delete(DesktopFreeProofNonceTable).where(lte(DesktopFreeProofNonceTable.expires_at, now)).limit(1000)
    const id = stableId([proof.keyThumbprint, proof.nonce.toLowerCase()])
    const [existing] = await tx.select().from(DesktopFreeProofNonceTable).where(eq(DesktopFreeProofNonceTable.id, id)).limit(1)
    if (existing) return "replay"
    const [total] = await tx.select({ amount: count() }).from(DesktopFreeProofNonceTable)
    if (Number(total?.amount ?? 0) >= 50_000) return "unavailable"
    await tx.insert(DesktopFreeProofNonceTable).values({
      id, expires_at: new Date(proof.timestamp + DESKTOP_FREE_PROOF_CLOCK_SKEW_MS + 1000),
    })
    return "accepted"
  })
}

async function reapExpiredReservations(tx: Transaction, now: Date) {
  await tx.update(AnonymousInferenceReservationTable).set({
    status: "retained",
    released_at: now,
  }).where(and(
    eq(AnonymousInferenceReservationTable.status, "active"),
    lte(AnonymousInferenceReservationTable.lease_expires_at, now),
  ))
}

function rateSpecs(kind: "session" | "request", identities: AnonymousIdentities, now: Date): RateSpec[] {
  const window = hourlyWindow(now)
  const limits = kind === "session"
    ? { installation: env.anonymous.sessionInstallHourly, ip: env.anonymous.sessionIpHourly, global: env.anonymous.sessionGlobalHourly }
    : { installation: env.anonymous.requestInstallHourly, ip: env.anonymous.requestIpHourly, global: env.anonymous.requestGlobalHourly }
  const values: Array<{ scope: RateSpec["scope"]; identityHash: string }> = [
    { scope: "installation", identityHash: identities.installationHash },
    { scope: "ip", identityHash: identities.ipHash },
    { scope: "global", identityHash: identities.globalHash },
  ]
  return values.map(({ scope, identityHash }) => ({
    id: stableId(["rate", kind, scope, identityHash, window.start.toISOString()]),
    kind, scope, identityHash, start: window.start, end: window.end, limit: limits[scope],
  })).sort((left, right) => left.id.localeCompare(right.id))
}

function usageSpecs(identities: AnonymousIdentities, now: Date): UsageSpec[] {
  const daily = dailyWindow(now)
  const monthly = monthlyWindow(now)
  const weekly = freeInferenceWindow(now)
  const values: Array<Omit<UsageSpec, "id">> = [
    { scope: "installation", identityHash: identities.installationHash, windowType: "weekly", ...weekly, limitMicroUsd: env.anonymous.installWeeklyMicroUsd },
    { scope: "ip", identityHash: identities.ipHash, windowType: "daily", ...daily, limitMicroUsd: env.anonymous.ipDailyMicroUsd },
    { scope: "global", identityHash: identities.globalHash, windowType: "daily", ...daily, limitMicroUsd: env.anonymous.globalDailyMicroUsd },
    { scope: "global", identityHash: identities.globalHash, windowType: "monthly", ...monthly, limitMicroUsd: env.anonymous.globalMonthlyMicroUsd },
  ]
  return values.map((value) => ({
    ...value,
    id: stableId(["usage", value.scope, value.identityHash, value.windowType, value.start.toISOString()]),
  })).sort((left, right) => left.id.localeCompare(right.id))
}

async function prepareRateBuckets(tx: Transaction, specs: RateSpec[]) {
  for (const spec of specs) {
    await tx.insert(AnonymousInferenceRateBucketTable).values({
      id: spec.id, kind: spec.kind, scope: spec.scope, identity_hash: spec.identityHash,
      window_start_at: spec.start, window_end_at: spec.end, limit_amount: spec.limit, used_amount: 0,
    }).onDuplicateKeyUpdate({ set: { limit_amount: spec.limit } })
  }
  const rows = []
  for (const spec of specs) {
    const [row] = await tx.select().from(AnonymousInferenceRateBucketTable)
      .where(eq(AnonymousInferenceRateBucketTable.id, spec.id)).limit(1).for("update")
    if (!row) throw new Error("Anonymous inference rate bucket is unavailable")
    rows.push(row)
  }
  return rows
}

async function prepareUsageBuckets(tx: Transaction, specs: UsageSpec[]) {
  for (const spec of specs) {
    await tx.insert(AnonymousInferenceUsageBucketTable).values({
      id: spec.id, scope: spec.scope, identity_hash: spec.identityHash, window_type: spec.windowType,
      window_start_at: spec.start, window_end_at: spec.end, limit_micro_usd: spec.limitMicroUsd, used_micro_usd: 0,
    }).onDuplicateKeyUpdate({ set: { limit_micro_usd: spec.limitMicroUsd } })
  }
  const rows = []
  for (const spec of specs) {
    const [row] = await tx.select().from(AnonymousInferenceUsageBucketTable)
      .where(eq(AnonymousInferenceUsageBucketTable.id, spec.id)).limit(1).for("update")
    if (!row) throw new Error("Anonymous inference usage bucket is unavailable")
    rows.push(row)
  }
  return rows
}

function firstRateLimit(rows: Awaited<ReturnType<typeof prepareRateBuckets>>, now: Date): AdmissionFailure | null {
  const limited = rows.find((row) => row.used_amount >= row.limit_amount)
  if (!limited) return null
  return { ok: false, reason: limited.scope === "global" ? "capacity" : "limit", retryAfterSeconds: retryAfterSeconds(limited.window_end_at, now) }
}

async function incrementRateBuckets(tx: Transaction, rows: Awaited<ReturnType<typeof prepareRateBuckets>>) {
  for (const row of rows) {
    await tx.update(AnonymousInferenceRateBucketTable).set({
      used_amount: sql`${AnonymousInferenceRateBucketTable.used_amount} + 1`,
    }).where(eq(AnonymousInferenceRateBucketTable.id, row.id))
  }
}

export function anonymousReservationMicroUsd() {
  const input = env.anonymous.maxInputTokens * env.anonymous.maxInputPriceMicroUsdPerMillion
  const output = env.anonymous.maxCompletionTokens * env.anonymous.maxCompletionPriceMicroUsdPerMillion
  // OpenRouter BYOK currently adds a 5% fee. Keep a fixed 10% reserve margin
  // for that fee, rounding, and accounting drift; operators cannot lower it.
  return Math.ceil(((input + output) * upstreamCostSafetyNumerator) / (1_000_000 * upstreamCostSafetyDenominator))
}

export async function readAnonymousAllowance(identities: AnonymousIdentities): Promise<Pick<DesktopFreeAccessStatus, "state" | "code" | "allowance">> {
  // Consistent read under the admission lock; no bucket creation, reservation,
  // rate consumption, generation, or provider call from this status read.
  return db.transaction(async (tx) => {
    const control = await lockControl(tx)
    const now = new Date()
    const specs = usageSpecs(identities, now)
    let allowance: DesktopFreeAccessStatus["allowance"] = null
    let installationLimited = false
    let sharedLimited = false
    for (const spec of specs) {
      const [bucket] = await tx.select().from(AnonymousInferenceUsageBucketTable).where(eq(AnonymousInferenceUsageBucketTable.id, spec.id)).limit(1)
      const used = bucket?.used_micro_usd ?? 0
      const limited = used + anonymousReservationMicroUsd() > spec.limitMicroUsd
      if (spec.scope !== "installation") {
        sharedLimited ||= limited
        continue
      }
      installationLimited = limited
      const [holds] = await tx.select({ amount: sql<number>`coalesce(sum(${AnonymousInferenceReservationChargeTable.reserved_micro_usd}), 0)` })
        .from(AnonymousInferenceReservationChargeTable)
        .innerJoin(AnonymousInferenceReservationTable, eq(AnonymousInferenceReservationTable.id, AnonymousInferenceReservationChargeTable.reservation_id))
        .where(and(eq(AnonymousInferenceReservationChargeTable.bucket_id, spec.id),
          eq(AnonymousInferenceReservationTable.status, "active"), gt(AnonymousInferenceReservationTable.lease_expires_at, now)))
      const reserved = Number(holds?.amount ?? 0)
      allowance = {
        limitUsd: spec.limitMicroUsd / 1_000_000, usedUsd: Math.max(0, used - reserved) / 1_000_000,
        reservedUsd: reserved / 1_000_000, remainingUsd: Math.max(0, spec.limitMicroUsd - used) / 1_000_000,
        resetsAt: spec.end.toISOString(),
      }
    }
    if (control.blocked) return { state: "unavailable", code: "anonymous_unavailable", allowance }
    if (installationLimited) return { state: "exhausted", code: "anonymous_reservation_does_not_fit", allowance }
    if (sharedLimited) return { state: "unavailable", code: "anonymous_capacity_exceeded", allowance }
    return { state: "ready", code: null, allowance }
  })
}

export async function consumeAnonymousSessionIssuance(
  identities: AnonymousIdentities,
  request: { deadlineAt: number; signal: AbortSignal },
): Promise<{ ok: true } | AdmissionFailure> {
  return db.transaction(async (tx) => {
    const control = await lockControl(tx)
    if (control.blocked) return { ok: false, reason: "unavailable" }
    const now = new Date()
    if (request.signal.aborted || now.getTime() >= request.deadlineAt) return { ok: false, reason: "unavailable" }
    await reapExpiredReservations(tx, now)
    const specs = rateSpecs("session", identities, now)
    // Check shared identities first. Rejected installation churn stays O(1).
    const sharedRows = await prepareRateBuckets(tx, specs.filter((spec) => spec.scope !== "installation"))
    const sharedLimit = firstRateLimit(sharedRows, now)
    if (sharedLimit) return sharedLimit
    if (request.signal.aborted || Date.now() >= request.deadlineAt) return { ok: false, reason: "unavailable" }
    const installationRows = await prepareRateBuckets(tx, specs.filter((spec) => spec.scope === "installation"))
    const installationLimit = firstRateLimit(installationRows, now)
    if (installationLimit) return installationLimit
    if (request.signal.aborted || Date.now() >= request.deadlineAt) return { ok: false, reason: "unavailable" }
    await incrementRateBuckets(tx, [...sharedRows, ...installationRows])
    return { ok: true }
  })
}

export async function reserveAnonymousInference(input: {
  id: string
  identities: AnonymousIdentities
  deadlineAt: number
  signal: AbortSignal
}): Promise<{ ok: true; reservationId: string; dispatchDeadline: number } | AdmissionFailure> {
  const reserveMicroUsd = anonymousReservationMicroUsd()
  return db.transaction(async (tx) => {
    const control = await lockControl(tx)
    if (control.blocked) return { ok: false, reason: "unavailable" }
    // Start the lease after obtaining the global admission lock.
    const now = new Date()
    const dispatchDeadline = Math.min(input.deadlineAt, now.getTime() + env.anonymous.requestTimeoutMs)
    if (input.signal.aborted || dispatchDeadline <= now.getTime()) return { ok: false, reason: "unavailable" }
    await reapExpiredReservations(tx, now)

    const [installInflight] = await tx.select({ amount: count() }).from(AnonymousInferenceReservationTable).where(and(
      eq(AnonymousInferenceReservationTable.status, "active"),
      eq(AnonymousInferenceReservationTable.installation_hash, input.identities.installationHash),
    ))
    const [globalInflight] = await tx.select({ amount: count() }).from(AnonymousInferenceReservationTable)
      .where(eq(AnonymousInferenceReservationTable.status, "active"))
    if (Number(installInflight?.amount ?? 0) >= 1 || Number(globalInflight?.amount ?? 0) >= env.anonymous.globalInflight) {
      return { ok: false, reason: "capacity", retryAfterSeconds: Math.ceil((env.anonymous.requestTimeoutMs + 30_000) / 1000) }
    }

    const rateRows = await prepareRateBuckets(tx, rateSpecs("request", input.identities, now))
    const rateLimited = firstRateLimit(rateRows, now)
    if (rateLimited) return rateLimited
    const usageRows = await prepareUsageBuckets(tx, usageSpecs(input.identities, now))
    const usageLimited = usageRows.find((row) => row.used_micro_usd + reserveMicroUsd > row.limit_micro_usd)
    if (usageLimited) return { ok: false, reason: usageLimited.scope === "global" ? "capacity" : "limit", retryAfterSeconds: retryAfterSeconds(usageLimited.window_end_at, now) }
    // Bucket preparation can wait on row locks. Recheck the request lifetime.
    if (input.signal.aborted || Date.now() >= dispatchDeadline) return { ok: false, reason: "unavailable" }
    await incrementRateBuckets(tx, rateRows)
    for (const row of usageRows) {
      await tx.update(AnonymousInferenceUsageBucketTable).set({
        used_micro_usd: sql`${AnonymousInferenceUsageBucketTable.used_micro_usd} + ${reserveMicroUsd}`,
      }).where(eq(AnonymousInferenceUsageBucketTable.id, row.id))
    }
    await tx.insert(AnonymousInferenceReservationTable).values({
      id: input.id, installation_hash: input.identities.installationHash, ip_hash: input.identities.ipHash,
      reserved_micro_usd: reserveMicroUsd, lease_expires_at: new Date(dispatchDeadline + 30_000),
    })
    await tx.insert(AnonymousInferenceReservationChargeTable).values(usageRows.map((row) => ({
      id: stableId(["charge", input.id, row.id]), reservation_id: input.id, bucket_id: row.id, reserved_micro_usd: reserveMicroUsd,
    })))
    return { ok: true, reservationId: input.id, dispatchDeadline }
  })
}

export async function validateAnonymousDispatch(reservationId: string, dispatchDeadline: number, signal: AbortSignal) {
  return db.transaction(async (tx) => {
    const control = await lockControl(tx)
    const now = new Date()
    await reapExpiredReservations(tx, now)
    const [reservation] = await tx.select().from(AnonymousInferenceReservationTable)
      .where(eq(AnonymousInferenceReservationTable.id, reservationId)).limit(1).for("update")
    const valid = !control.blocked && !signal.aborted && reservation?.status === "active"
      && reservation.lease_expires_at > now && dispatchDeadline > now.getTime()
    if (reservation?.status === "active" && !valid) {
      await tx.update(AnonymousInferenceReservationTable).set({ status: "retained", released_at: now })
        .where(eq(AnonymousInferenceReservationTable.id, reservationId))
    }
    return valid
  })
}

export type TrustedAnonymousUsage = {
  costMicroUsd: number
  inputTokens: number
  billableCompletionTokens: number
}

function unsafeUsageForReservation(usage: TrustedAnonymousUsage | null, reservedMicroUsd: number) {
  return usage !== null && (
    !Number.isSafeInteger(usage.costMicroUsd) || usage.costMicroUsd < 0 || usage.costMicroUsd > reservedMicroUsd
    || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || usage.inputTokens > env.anonymous.maxInputTokens
    || !Number.isSafeInteger(usage.billableCompletionTokens) || usage.billableCompletionTokens < 0
    || usage.billableCompletionTokens > env.anonymous.maxCompletionTokens
  )
}

async function blockAnonymousInference(tx: Transaction, now: Date) {
  await tx.update(AnonymousInferenceControlTable).set({
    blocked: true, blocked_at: now, block_reason: "reservation_safety_fault",
  }).where(eq(AnonymousInferenceControlTable.id, controlId))
}

export async function settleAnonymousInference(reservationId: string, usage: TrustedAnonymousUsage | null) {
  return db.transaction(async (tx) => {
    await lockControl(tx)
    const now = new Date()
    const [reservation] = await tx.select().from(AnonymousInferenceReservationTable)
      .where(eq(AnonymousInferenceReservationTable.id, reservationId)).limit(1).for("update")
    if (!reservation) return "missing"
    const unsafeUsage = unsafeUsageForReservation(usage, reservation.reserved_micro_usd)
    if (reservation.status === "active" && reservation.lease_expires_at <= now) {
      if (unsafeUsage) await blockAnonymousInference(tx, now)
      await tx.update(AnonymousInferenceReservationTable).set({ status: "retained", released_at: now })
        .where(eq(AnonymousInferenceReservationTable.id, reservationId))
      return unsafeUsage ? "blocked" : "retained"
    }
    // Late trusted usage cannot refund a retained charge, but can trip the kill
    // switch if it proves the original reservation was insufficient.
    if (reservation.status !== "active") {
      if (unsafeUsage) await blockAnonymousInference(tx, now)
      return unsafeUsage ? "blocked" : reservation.status
    }
    if (!usage || unsafeUsage) {
      if (unsafeUsage) await blockAnonymousInference(tx, now)
      await tx.update(AnonymousInferenceReservationTable).set({ status: "retained", released_at: now })
        .where(eq(AnonymousInferenceReservationTable.id, reservationId))
      return unsafeUsage ? "blocked" : "retained"
    }
    const refundMicroUsd = reservation.reserved_micro_usd - usage.costMicroUsd
    const charges = await tx.select().from(AnonymousInferenceReservationChargeTable)
      .where(eq(AnonymousInferenceReservationChargeTable.reservation_id, reservationId))
    charges.sort((left, right) => left.bucket_id.localeCompare(right.bucket_id))
    for (const charge of charges) {
      if (refundMicroUsd > 0) {
        await tx.update(AnonymousInferenceUsageBucketTable).set({
          used_micro_usd: sql`${AnonymousInferenceUsageBucketTable.used_micro_usd} - ${refundMicroUsd}`,
        }).where(eq(AnonymousInferenceUsageBucketTable.id, charge.bucket_id))
      }
      await tx.update(AnonymousInferenceReservationChargeTable).set({ settled_micro_usd: usage.costMicroUsd })
        .where(eq(AnonymousInferenceReservationChargeTable.id, charge.id))
    }
    await tx.update(AnonymousInferenceReservationTable).set({ status: "settled", settled_micro_usd: usage.costMicroUsd, released_at: now })
      .where(eq(AnonymousInferenceReservationTable.id, reservationId))
    return "settled"
  })
}
