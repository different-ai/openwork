import { AsyncLocalStorage } from "node:async_hooks"
import { requestHasWritten } from "./request-reads.js"

const primaryReads = new AsyncLocalStorage<true>()

/**
 * Runs `work` with every read on the primary. Use it around a flow that writes
 * and then reads back through shared helpers, so no step sees a lagging replica.
 */
export function withPrimaryReads<T>(work: () => Promise<T>): Promise<T> {
  return primaryReads.run(true, work)
}

/**
 * Runs `work`, and once more on the primary when it misses, so a row written
 * moments ago, or one a replica has yet to receive, is still found.
 */
export async function withPrimaryAfterMiss<T>(work: () => Promise<T>, missed: (error: unknown) => boolean): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!missed(error) || shouldReadFromPrimary()) throw error
    return await withPrimaryReads(work)
  }
}

/** db.ts routing: reads go to the primary inside withPrimaryReads or once the request has written. */
export function shouldReadFromPrimary(): boolean {
  return primaryReads.getStore() === true || requestHasWritten()
}

/** Route middleware: the rest of a write request reads from the primary. */
export function primaryReadsMiddleware(_c: unknown, next: () => Promise<void>): Promise<void> {
  return withPrimaryReads(next)
}
