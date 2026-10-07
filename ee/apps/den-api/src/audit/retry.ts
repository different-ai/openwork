import { setTimeout as delay } from "node:timers/promises"
import { isTransientDbConnectionError } from "@openwork-ee/den-db"
import { AuditLogError } from "@openwork-ee/den-db/audit-log"
import { appLogger } from "../observability/logger.js"
import { AUDIT_APPEND_RETRY_OPERATIONAL_MARKER } from "../operational-log-markers.js"

// Bounded retry for standalone audit transactions (intent, served, outcome,
// service/job outcomes, user fan-out, after-commit change events, platform
// rows). The whole transaction callback is re-run, so the entitlement recheck
// and policy-current fence run again on every attempt. Deterministic failures
// (every AuditLogError, feature/entitlement decisions, validation) are never
// retried. Appends made INSIDE a business transaction (appendAuditChanges,
// providerAuditMutation) are not wrapped: retrying them would re-run the
// business mutation, so a deadlock there still rolls the mutation back.

export const AUDIT_APPEND_MAX_ATTEMPTS = 3
// Base backoff before attempts 2 and 3, plus up to 25 ms jitter each: at most
// ~250 ms added latency, well under one second.
const BACKOFF_MS: readonly number[] = [50, 150]
const BACKOFF_JITTER_MS = 25

/**
 * lock_conflict: InnoDB deadlock victim (1213) or lock wait timeout (1205); the
 * transaction was rolled back, so a re-run can never duplicate anything.
 * connection: the connection failed mid-transaction; the COMMIT may or may not
 * have landed, so only appends that are idempotent on replay are re-run.
 */
export type AuditTransientFailure = "lock_conflict" | "connection"

const LOCK_CONFLICT_CODES = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"])
const LOCK_CONFLICT_ERRNOS = new Set([1213, 1205])
// PlanetScale/Vitess surface MySQL errors as message text: "... Deadlock found when trying to get lock; try restarting transaction (errno 1213) (sqlstate 40001)".
const LOCK_CONFLICT_MESSAGE = /Deadlock found when trying to get lock|Lock wait timeout exceeded|\(errno 12(?:13|05)\)/
const CONNECTION_MESSAGE = /Connection lost|PROTOCOL_CONNECTION_LOST/
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
  /** Which append is retried (log field only). */
  label: string
  /**
   * True when a replay after an ambiguous commit returns the already-written
   * record instead of a second one (stable idempotency key on a stable
   * operation binding, or a pre-generated primary key). Lock conflicts are
   * retried either way; connection failures only when idempotent.
   */
  idempotent: boolean
  requestId?: string | null
  organizationId?: string | null
}>

/**
 * Runs `attempt` (one complete transaction) up to AUDIT_APPEND_MAX_ATTEMPTS
 * times on transient database failures with short jittered backoff, then
 * rethrows the last error so the caller's existing fail-closed (503) or
 * [audit-outcome-lost] behaviour applies.
 */
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
