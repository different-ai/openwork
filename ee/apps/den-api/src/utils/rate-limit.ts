import { and, eq, lt, or, sql } from "@openwork-ee/den-db/drizzle"
import { RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

type RateLimitRow = {
  count: number
  lastRequest: number
}

function requestAddress(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
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

export function enforceRateLimit(headers: Headers, scope: string, maxRequests: number, windowMs: number, now = Date.now()) {
  return checkRateLimit(`${scope}:${requestAddress(headers)}`, maxRequests, windowMs, now)
}
