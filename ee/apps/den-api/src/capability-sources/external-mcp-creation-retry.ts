import { setTimeout as delay } from "node:timers/promises"

function isDeadlock(error: unknown): boolean {
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

/** Retry only a complete, rolled-back database transaction, never provider calls or ambiguous commits. */
export async function withExternalMcpCreationRetry<T>(transaction: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction()
    } catch (error) {
      if (attempt >= 2 || !isDeadlock(error)) throw error
      await delay(25 * 2 ** attempt + Math.floor(Math.random() * 25))
    }
  }
}
