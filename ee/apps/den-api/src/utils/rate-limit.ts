import { and, eq, lt, or, sql } from "@openwork-ee/den-db/drizzle"
import { RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { requestClientIpKey } from "../request-client-ip.js"

type RateLimitRow = {
  count: number
  lastRequest: number
}

function retryAfterSeconds(row: RateLimitRow, maxRequests: number, windowMs: number, now: number) {
  const elapsed = now - row.lastRequest
  if (elapsed <= windowMs && row.count >= maxRequests) {
    return Math.max(1, Math.ceil((windowMs - elapsed) / 1000))
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }

  const code = error.code
  if (code === "ER_DUP_ENTRY" || code === "ALREADY_EXISTS") {
    return true
  }

  if (error.errno === 1062) {
    return true
  }

  const message = error.message
  if (typeof message === "string" && message.includes("Duplicate entry")) {
    return true
  }

  return isDuplicateKeyError(error.cause) || isDuplicateKeyError(error.body)
}

function changedRows(result: unknown): number | null {
  if (Array.isArray(result)) {
    for (const value of result) {
      const nestedRows = changedRows(value)
      if (nestedRows !== null) {
        return nestedRows
      }
    }
    return null
  }

  if (!isRecord(result)) {
    return null
  }

  if (typeof result.rowsAffected === "number") {
    return result.rowsAffected
  }

  if (typeof result.affectedRows === "number") {
    return result.affectedRows
  }

  return null
}

async function readRateLimit(key: string): Promise<RateLimitRow | null> {
  const [row] = await db
    .select({ count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, key))
    .limit(1)
  return row ?? null
}

async function insertRateLimit(key: string, now: number) {
  await db.insert(RateLimitTable).values({
    id: createDenTypeId("rateLimit"),
    key,
    count: 1,
    lastRequest: now,
  })
}

async function incrementExistingRateLimit(key: string, maxRequests: number, windowMs: number, now: number) {
  const result: unknown = await db
    .update(RateLimitTable)
    .set({
      count: sql<number>`IF(${now} - ${RateLimitTable.lastRequest} > ${windowMs}, 1, ${RateLimitTable.count} + 1)`,
      lastRequest: now,
    })
    .where(and(
      eq(RateLimitTable.key, key),
      or(
        sql`${now} - ${RateLimitTable.lastRequest} > ${windowMs}`,
        lt(RateLimitTable.count, maxRequests),
      ),
    ))

  const rows = changedRows(result)
  return rows !== null && rows > 0
}

async function claimExistingRateLimit(key: string, maxRequests: number, windowMs: number, now: number, row: RateLimitRow) {
  const retryAfter = retryAfterSeconds(row, maxRequests, windowMs, now)
  if (retryAfter !== null) {
    return retryAfter
  }

  if (await incrementExistingRateLimit(key, maxRequests, windowMs, now)) {
    return null
  }

  const latestRow = await readRateLimit(key)
  return latestRow ? retryAfterSeconds(latestRow, maxRequests, windowMs, now) : null
}

export async function checkRateLimit(key: string, maxRequests: number, windowMs: number, now: number, consume = true) {
  const row = await readRateLimit(key)
  if (!consume) {
    return row ? retryAfterSeconds(row, maxRequests, windowMs, now) : null
  }
  if (row) {
    return claimExistingRateLimit(key, maxRequests, windowMs, now, row)
  }

  try {
    await insertRateLimit(key, now)
    return null
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error
    }
  }

  const existingRow = await readRateLimit(key)
  if (!existingRow) {
    await insertRateLimit(key, now)
    return null
  }

  return claimExistingRateLimit(key, maxRequests, windowMs, now, existingRow)
}

// Fixed windows: a window opens at the first request it accepts, and
// `lastRequest` stores that start. A window has ended once
// `now - start >= windowMs`, so a request at exactly `start + windowMs` opens
// the next one. Each window admits `maxRequests`; a caller can therefore send
// up to twice that across a boundary. Blocked requests never write, so they
// cannot extend a wait, and steady traffic below the limit never accumulates
// across windows. Moving a key over from `checkRateLimit` is safe: its stored
// last-request time reads as a window start, so an old count lasts at most
// one more window.
function fixedWindowRetryAfterSeconds(row: RateLimitRow, maxRequests: number, windowMs: number, now: number) {
  const remaining = row.lastRequest + windowMs - now
  if (remaining > 0 && row.count >= maxRequests) {
    return Math.max(1, Math.ceil(remaining / 1000))
  }
  return null
}

async function claimFixedWindowRateLimit(key: string, maxRequests: number, windowMs: number, now: number) {
  const ended = sql`${now} - ${RateLimitTable.lastRequest} >= ${windowMs}`
  const result: unknown = await db
    .update(RateLimitTable)
    .set({
      // MySQL applies SET assignments left to right and Drizzle emits them in
      // column order, so `count` still sees the old window start here.
      count: sql<number>`IF(${ended}, 1, ${RateLimitTable.count} + 1)`,
      lastRequest: sql<number>`IF(${ended}, ${now}, ${RateLimitTable.lastRequest})`,
    })
    .where(and(eq(RateLimitTable.key, key), or(ended, lt(RateLimitTable.count, maxRequests))))

  const rows = changedRows(result)
  return rows !== null && rows > 0
}

const FIXED_WINDOW_CLAIM_ATTEMPTS = 3

/** Same contract as `checkRateLimit`, counted in fixed windows (see above). */
export async function checkFixedWindowRateLimit(key: string, maxRequests: number, windowMs: number, now: number, consume = true): Promise<number | null> {
  let row = await readRateLimit(key)
  if (!consume) {
    return row ? fixedWindowRetryAfterSeconds(row, maxRequests, windowMs, now) : null
  }

  for (let attempt = 0; attempt < FIXED_WINDOW_CLAIM_ATTEMPTS; attempt += 1) {
    if (row) {
      const retryAfter = fixedWindowRetryAfterSeconds(row, maxRequests, windowMs, now)
      if (retryAfter !== null) {
        return retryAfter
      }
      if (await claimFixedWindowRateLimit(key, maxRequests, windowMs, now)) {
        return null
      }
    } else {
      try {
        await insertRateLimit(key, now)
        return null
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error
        }
      }
    }
    // Another request changed the row first; decide again from what it wrote.
    row = await readRateLimit(key)
  }

  // Still contended after every attempt: ask the caller to retry shortly
  // rather than admit a request that was never counted.
  return row ? fixedWindowRetryAfterSeconds(row, maxRequests, windowMs, now) ?? 1 : 1
}

export function enforceRateLimit(headers: Headers, scope: string, maxRequests: number, windowMs: number, now = Date.now()) {
  return checkRateLimit(`${scope}:${requestClientIpKey(headers)}`, maxRequests, windowMs, now)
}
