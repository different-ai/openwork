import { createContext, Script } from "node:vm"

/** Synchronous work was stopped because it ran past its time limit. */
export class TimeLimitExceededError extends Error {
  readonly limitMs: number

  constructor(limitMs: number) {
    super(`Stopped after ${limitMs}ms.`)
    this.name = "TimeLimitExceededError"
    this.limitMs = limitMs
  }
}

/**
 * How long checking a value against a caller's JSON Schema may take. Its
 * `pattern`s are regular expressions, and one that backtracks exponentially
 * would otherwise hold the event loop for hours.
 */
export const SCHEMA_CHECK_TIME_LIMIT_MS = 250
export const SCHEMA_CHECK_TOO_SLOW_MESSAGE = `Checking the value against the schema took longer than ${SCHEMA_CHECK_TIME_LIMIT_MS}ms and was stopped. Simplify the schema's patterns: nested repetition such as (a+)+ can take exponential time.`

const slot: { run?: () => void } = {}
const context = createContext(slot)
const script = new Script("run()")
let running = false

function isScriptTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
}

/**
 * Runs synchronous work that nothing else can interrupt, such as matching a
 * caller's regular expression, and stops it at the limit. A timer cannot do
 * this: it only fires once the work has returned. Node's script timeout ends
 * the work from a watchdog thread, wherever it is.
 *
 * `finally` blocks inside stopped work do not run, so only pass work whose
 * half-finished state is thrown away. Work started inside other limited work
 * runs under the outer limit.
 */
export function runWithTimeLimit<T>(work: () => T, limitMs: number): T {
  if (running) return work()
  const done: Array<T> = []
  slot.run = () => {
    done.push(work())
  }
  running = true
  try {
    script.runInContext(context, { timeout: Math.max(1, Math.ceil(limitMs)) })
  } catch (error) {
    if (isScriptTimeout(error)) throw new TimeLimitExceededError(limitMs)
    throw error
  } finally {
    running = false
    slot.run = undefined
  }
  const [result] = done
  if (done.length === 0) throw new Error("Time-limited work did not run.")
  return result
}
