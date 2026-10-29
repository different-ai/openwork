import { and, eq, gte, isNull, lt, lte, sql } from "drizzle-orm"
import type { createDenDb } from "./client"
import { FreeAutoLimitEventTable as Limit } from "./schema/free-auto-behavior"
import { AnonymousInferenceRateBucketTable as Rate } from "./schema/inference"
import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"

type Database = ReturnType<typeof createDenDb>["db"]
export const FREE_AUTO_CONVERSION_WINDOW_DAYS = 30
const WINDOW_MS = FREE_AUTO_CONVERSION_WINDOW_DAYS * 86_400_000
/** Analytics only: shared networks can record several journeys, but rotating public headers cannot grow storage indefinitely. */
export const FREE_AUTO_GUEST_OBSERVATION_DAILY_LIMIT = 100

/** A missing/malformed correlation header disables guest attribution without affecting access or accounting. */
export function freeAutoJourneyHash(value: string | null | undefined): string | null {
  return value && /^[a-f0-9]{64}$/.test(value) ? freeInferenceDigest("free-auto-journey", value) : null
}

/** One observation per audience, subject and allowance window; repeated checks map to the same row. */
export function freeAutoLimitId(input: { audience: "guest" | "member"; subjectHash: string; windowStart: Date }) {
  return freeInferenceDigest("free-auto-limit", `${input.audience}:${input.subjectHash}:${input.windowStart.toISOString()}`)
}

/** The per-network daily bucket that bounds guest observations. */
export function freeAutoObservationRateId(observationRateHash: string, now: Date) {
  return freeInferenceDigest("free-auto-observation-rate", `${observationRateHash}:${Math.floor(now.getTime() / 86_400_000)}`)
}

/**
 * `exists`: already recorded, so callers can stop checking it. `capped`: this network reached today's guest bound.
 * `skipped`: a guest observation without a server-derived network hash.
 */
export type FreeAutoLimitRecord = "recorded" | "exists" | "capped" | "skipped"

export async function recordFreeAutoLimit(database: Database, input: {
  audience: "guest" | "member"; subjectHash: string; userId?: typeof Limit.$inferInsert.user_id;
  organizationId?: typeof Limit.$inferInsert.organization_id; windowStart: Date; now: Date;
  /** Server-derived keyed network hash; never supplied by the client. Required for guest observations. */
  observationRateHash?: string;
}): Promise<FreeAutoLimitRecord> {
  const id = freeAutoLimitId(input)
  if (input.audience === "guest" && !input.observationRateHash) return "skipped"
  // A primary-key read before any write: repeated checks of an exhausted allowance cost one indexed read and no locks.
  const [known] = await database.select({ id: Limit.id }).from(Limit).where(eq(Limit.id, id)).limit(1)
  if (known) return "exists"
  const row = { id, audience: input.audience, subject_hash: input.subjectHash,
    user_id: input.userId, organization_id: input.organizationId, window_start_at: input.windowStart, exhausted_at: input.now }
  if (input.audience === "member" || !input.observationRateHash) {
    await database.insert(Limit).values(row).onDuplicateKeyUpdate({ set: { id: sql`${Limit.id}` } })
    return "recorded"
  }
  const day = Math.floor(input.now.getTime() / 86_400_000)
  const rateId = freeAutoObservationRateId(input.observationRateHash, input.now)
  // This existing expiry-indexed table is independent of allowance accounting.
  await database.delete(Rate).where(lte(Rate.expires_at, input.now)).limit(100)
  return database.transaction(async (tx): Promise<FreeAutoLimitRecord> => {
    // Insert before locking, avoiding a gap lock on an absent counter. The row lock bounds all Gateway instances together.
    await tx.insert(Rate).values({ id: rateId, used_amount: 0, expires_at: new Date((day + 1) * 86_400_000) })
      .onDuplicateKeyUpdate({ set: { id: sql`${Rate.id}` } })
    const [rate] = await tx.select({ used: Rate.used_amount }).from(Rate).where(eq(Rate.id, rateId)).limit(1).for("update")
    if (!rate || rate.used >= FREE_AUTO_GUEST_OBSERVATION_DAILY_LIMIT) return "capped"
    const [existing] = await tx.select({ id: Limit.id }).from(Limit).where(eq(Limit.id, id)).limit(1)
    if (existing) return "exists"
    await tx.insert(Limit).values(row).onDuplicateKeyUpdate({ set: { id: sql`${Limit.id}` } })
    await tx.update(Rate).set({ used_amount: sql`${Rate.used_amount} + 1` }).where(eq(Rate.id, rateId))
    return "recorded"
  })
}

/** First authenticated Auto request with the same reported journey; no IP or device fingerprint join. */
export async function linkFreeAutoGuest(database: Database, input: {
  journeyHash: string; userId: NonNullable<typeof Limit.$inferInsert.user_id>;
  organizationId: NonNullable<typeof Limit.$inferInsert.organization_id>; now: Date;
}) {
  await database.update(Limit).set({ user_id: input.userId, organization_id: input.organizationId, authenticated_at: input.now })
    .where(and(eq(Limit.audience, "guest"), eq(Limit.subject_hash, input.journeyHash), isNull(Limit.user_id),
      lt(Limit.exhausted_at, input.now), gte(Limit.exhausted_at, new Date(input.now.getTime() - WINDOW_MS))))
}

/** Durable sign-in evidence, independent of session retention or optional organization audit capture. */
export async function recordFreeAutoSignIn(database: Database, input: { userId: NonNullable<typeof Limit.$inferInsert.user_id>; now: Date }) {
  await database.update(Limit).set({ authenticated_at: input.now }).where(and(eq(Limit.audience, "member"),
    eq(Limit.user_id, input.userId), isNull(Limit.authenticated_at), gte(Limit.exhausted_at, new Date(input.now.getTime() - WINDOW_MS)), lt(Limit.exhausted_at, input.now)))
}
