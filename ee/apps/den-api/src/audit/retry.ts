import { setTimeout as delay } from "node:timers/promises"
import { isTransientDbConnectionError } from "@openwork-ee/den-db"
import { AuditLogError } from "@openwork-ee/den-db/audit-log"
import { appLogger } from "../observability/logger.js"
import { AUDIT_APPEND_RETRY_OPERATIONAL_MARKER } from "../operational-log-markers.js"

export const AUDIT_APPEND_MAX_ATTEMPTS = 3
const BACKOFF_MS: readonly number[] = [50, 150]
const BACKOFF_JITTER_MS = 25

export type AuditTransientFailure = "lock_conflict" | "connection"

const LOCK_CONFLICT_CODES = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_CHECKREAD"])
const LOCK_CONFLICT_ERRNOS = new Set([1213, 1205, 1020])
const LOCK_CONFLICT_MESSAGE = /Deadlock found when trying to get lock|Lock wait timeout exceeded|Record has changed since last read|\(errno (?:12(?:13|05)|1020)\)/
const CONNECTION_MESSAGE = /Connection lost|PROTOCOL_CONNECTION_LOST/
const POOL_EXHAUSTED_MESSAGE = /ResourceExhausted|transaction pool connection limit exceeded/
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

const logger = appLogger.child({ component: "audit_retry" })

function errorChain(error: unknown): object[] {
  const chain: object[] = []
  let current = error
  while (typeof current === "object" && current !== null && !chain.includes(current) && chain.length < 8) {
    chain.push(current)
    current = "cause" in current ? current.cause : undefined
  }
  return chain
}

function field(value: object, name: "code" | "errno" | "message"): unknown {
  return name in value ? Reflect.get(value, name) : undefined
}

export function classifyTransientAuditError(error: unknown): AuditTransientFailure | null {
  const chain = errorChain(error)
  if (chain.some((entry) => entry instanceof AuditLogError)) return null
  if (chain.some((entry) => { const message = field(entry, "message"); return typeof message === "string" && POOL_EXHAUSTED_MESSAGE.test(message) })) return null
  for (const entry of chain) {
    const code = field(entry, "code")
    const errno = field(entry, "errno")
    const message = field(entry, "message")
    if (typeof code === "string" && LOCK_CONFLICT_CODES.has(code)) return "lock_conflict"
    if (typeof errno === "number" && LOCK_CONFLICT_ERRNOS.has(errno)) return "lock_conflict"
    if (typeof message === "string" && LOCK_CONFLICT_MESSAGE.test(message)) return "lock_conflict"
  }
  for (const entry of chain) {
    const message = field(entry, "message")
    if (isTransientDbConnectionError(entry) || (typeof message === "string" && CONNECTION_MESSAGE.test(message))) return "connection"
  }
  return null
}

function safeErrorCode(error: unknown): string | null {
  for (const entry of errorChain(error)) {
    const code = field(entry, "code")
    if (typeof code === "string" && SAFE_CODE.test(code)) return code
  }
  return null
}

export type AuditRetryOptions = Readonly<{
  label: string
  idempotent: boolean
  requestId?: string | null
  organizationId?: string | null
}>

export async function withAuditRetry<T>(attempt: (attemptNumber: number) => Promise<T>, options: AuditRetryOptions): Promise<T> {
  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      return await attempt(attemptNumber)
    } catch (error) {
      const failure = classifyTransientAuditError(error)
      const retryable = failure === "lock_conflict" || (failure === "connection" && options.idempotent)
      if (!retryable || attemptNumber >= AUDIT_APPEND_MAX_ATTEMPTS) throw error
      const backoffMs = (BACKOFF_MS[attemptNumber - 1] ?? 150) + Math.floor(Math.random() * BACKOFF_JITTER_MS)
      logger.warn(`${AUDIT_APPEND_RETRY_OPERATIONAL_MARKER} transient audit append failure; retrying`, {
        operational_marker: AUDIT_APPEND_RETRY_OPERATIONAL_MARKER, audit_append: options.label, attempt: attemptNumber, max_attempts: AUDIT_APPEND_MAX_ATTEMPTS,
        transient_failure: failure, backoff_ms: backoffMs, request_id: options.requestId ?? null, organization_id: options.organizationId ?? null, error_code: safeErrorCode(error),
      })
      await delay(backoffMs)
    }
  }
}
