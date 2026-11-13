import { setHostRegExp } from "@openwork/codemode"
import { runWithTimeLimit, TimeLimitExceededError } from "../time-limit.js"

/**
 * How long a program's regular expressions may hold Den's event loop before it
 * gets a turn. Ordinary matches take microseconds; a pattern that backtracks
 * exponentially would otherwise run for hours, where neither the execution
 * timeout nor any other timer can fire.
 */
const PATTERN_TIME_LIMIT_MS = 250

// Once a turn's allowance is spent, each further match in that turn gets this
// much: ordinary matches, from any program sharing the turn, still finish.
const SPENT_TURN_MATCH_MS = 2

let spentMs = 0
let turnOpen = false
let matching = false

function limited<T>(match: () => T): T {
  // replace and split call exec for each match: those run under the outer call.
  if (matching) return match()
  // Both engines give the event loop a turn every few milliseconds of program
  // work, so the allowance is per turn: many slow matches in a row stop too.
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

/** A RegExp whose matching, through its own methods and String's, stops at the limit. */
class TimeLimitedRegExp extends RegExp {
  // test and matchAll call exec, and so do replace and split, once for each match.
  override exec(text: string): RegExpExecArray | null {
    return matching ? super.exec(text) : limited(() => super.exec(text))
  }
}

// String.match, replace, search and split call these.
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

/** Makes every program Den runs, on either engine, match with a time limit. */
export function limitCodemodePatternTime(): void {
  setHostRegExp(TimeLimitedRegExp)
}
