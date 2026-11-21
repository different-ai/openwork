import { setHostRegExp } from "@openwork/codemode"
import { runWithTimeLimit, TimeLimitExceededError } from "../time-limit.js"

const PATTERN_TIME_LIMIT_MS = 250

const SPENT_TURN_MATCH_MS = 2

let spentMs = 0
let turnOpen = false
let matching = false

function limited<T>(match: () => T): T {
  if (matching) return match()
  if (!turnOpen) {
    turnOpen = true
    setImmediate(() => {
      turnOpen = false
      spentMs = 0
    })
  }
  const startedAt = performance.now()
  matching = true
  try {
    return runWithTimeLimit(match, Math.max(PATTERN_TIME_LIMIT_MS - spentMs, SPENT_TURN_MATCH_MS))
  } catch (error) {
    if (!(error instanceof TimeLimitExceededError)) throw error
    throw new RangeError(
      `Regular expression matching took longer than ${PATTERN_TIME_LIMIT_MS}ms and was stopped. Simplify the pattern: nested repetition such as (a+)+ can take exponential time. For literal text use String.includes or String.indexOf.`,
    )
  } finally {
    matching = false
    spentMs += performance.now() - startedAt
  }
}

class TimeLimitedRegExp extends RegExp {
  override exec(text: string): RegExpExecArray | null {
    return matching ? super.exec(text) : limited(() => super.exec(text))
  }
}

for (const name of [Symbol.match, Symbol.replace, Symbol.search, Symbol.split]) {
  const matcher: unknown = Reflect.get(RegExp.prototype, name)
  if (typeof matcher !== "function") continue
  Object.defineProperty(TimeLimitedRegExp.prototype, name, {
    configurable: true,
    writable: true,
    value(this: RegExp, ...args: unknown[]): unknown {
      return limited(() => Reflect.apply(matcher, this, args))
    },
  })
}

export function limitCodemodePatternTime(): void {
  setHostRegExp(TimeLimitedRegExp)
}
