export class GatewayUsageError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message)
  }
}

export function safeUsageDatabaseCode(error: unknown): string {
  const allowed = new Set([
    "ER_LOCK_DEADLOCK",
    "ER_LOCK_WAIT_TIMEOUT",
    "ER_DUP_ENTRY",
    "ER_CHECK_CONSTRAINT_VIOLATED",
    "ER_NO_SUCH_TABLE",
    "ER_BAD_FIELD_ERROR",
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
  ])
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== "object" || current === null) break
    if ("code" in current && typeof current.code === "string" && allowed.has(current.code))
      return current.code
    current = "cause" in current ? current.cause : null
  }
  return error instanceof GatewayUsageError ? "QUOTA_INVARIANT" : "DATABASE_ERROR"
}

export function isGatewayUsageDeadlock(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== "object" || current === null) return false
    if ("code" in current && current.code === "ER_LOCK_DEADLOCK") return true
    if ("errno" in current && current.errno === 1213) return true
    current = "cause" in current ? current.cause : null
  }
  return false
}
