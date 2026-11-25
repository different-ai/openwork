import { createContext, Script } from "node:vm"

export class TimeLimitExceededError extends Error {
  readonly limitMs: number

  constructor(limitMs: number) {
    super(`Stopped after ${limitMs}ms.`)
    this.name = "TimeLimitExceededError"
    this.limitMs = limitMs
  }
}

export const SCHEMA_CHECK_TIME_LIMIT_MS = 250
export const SCHEMA_CHECK_TOO_SLOW_MESSAGE = `Checking the value against the schema took longer than ${SCHEMA_CHECK_TIME_LIMIT_MS}ms and was stopped. Simplify the schema's patterns: nested repetition such as (a+)+ can take exponential time.`

const slot: { run?: () => void } = {}
const context = createContext(slot)
const script = new Script("run()")
let running = false

function isScriptTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
}

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
