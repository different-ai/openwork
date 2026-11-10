import { setTimeout as delay } from "node:timers/promises"

export function isDeadlock(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return false
    if (("code" in current && current.code === "ER_LOCK_DEADLOCK")
      || ("errno" in current && current.errno === 1213)) return true
    // PlanetScale puts MySQL's diagnostic in the nested DatabaseError message.
    if ("name" in current && current.name === "DatabaseError"
      && "message" in current && typeof current.message === "string"
      && /\(errno 1213\)/.test(current.message)) return true
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

/**
 * Re-runs `work` up to three times when MySQL picks it as a deadlock victim.
 * The victim's statement or transaction was rolled back, so a re-run can never
 * duplicate a write. Only wrap database work that is safe to run again from
 * its first read: never provider mutations or ambiguous commits.
 */
export async function withDeadlockRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (attempt >= 2 || !isDeadlock(error)) throw error
      await delay(25 * 2 ** attempt + Math.floor(Math.random() * 25))
    }
  }
}
