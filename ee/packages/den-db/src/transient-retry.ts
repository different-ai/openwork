import type { Config } from "@planetscale/database"

const TRANSIENT_DB_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
])

const TRANSIENT_DB_HTTP_STATUSES = new Set([429, 500, 502, 503, 504])
const RETRYABLE_QUERY_PREFIXES = ["select", "show", "describe", "explain"]
type PlanetScaleFetch = NonNullable<Config["fetch"]>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isTransientDbConnectionError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }

  if (typeof error.code === "string" && TRANSIENT_DB_ERROR_CODES.has(error.code)) {
    return true
  }

  if (typeof error.status === "number" && TRANSIENT_DB_HTTP_STATUSES.has(error.status)) {
    return true
  }

  return isTransientDbConnectionError(error.cause)
}

function extractPlanetScaleSql(body: string | undefined): string | null {
  if (!body) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed) && typeof parsed.query === "string") {
      return parsed.query
    }
    return null
  } catch {
    return null
  }
}

function isRetryableReadQuery(sql: string | null): boolean {
  if (!sql) {
    return false
  }

  const normalized = sql.trimStart().toLowerCase()
  return RETRYABLE_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export async function retryReadQuery<T>(
  label: "query" | "execute",
  sql: string | null,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isRetryableReadQuery(sql) || !isTransientDbConnectionError(error)) {
      throw error
    }

    const queryType = sql?.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "QUERY"
    console.warn(`[db] transient database error on ${label} (${queryType}); retrying once`)
    return run()
  }
}

export function createRetryingPlanetScaleFetch(): PlanetScaleFetch {
  return async (input, init) => {
    const sql = extractPlanetScaleSql(init?.body)
    let firstAttempt = true

    return retryReadQuery("execute", sql, async () => {
      const shouldRetryResponse = firstAttempt && isRetryableReadQuery(sql)
      firstAttempt = false
      const response = await globalThis.fetch(input, init)
      if (shouldRetryResponse && TRANSIENT_DB_HTTP_STATUSES.has(response.status)) {
        // Release the discarded response before issuing the bounded retry.
        await response.body?.cancel()
        throw response
      }
      return response
    })
  }
}
