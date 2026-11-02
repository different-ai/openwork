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

/** db.ts routing: reads go to the primary inside withPrimaryReads or once the request has written. */
export function shouldReadFromPrimary(): boolean {
  return primaryReads.getStore() === true || requestHasWritten()
}

/** Route middleware: the rest of a write request reads from the primary. */
export function primaryReadsMiddleware(_c: unknown, next: () => Promise<void>): Promise<void> {
  return withPrimaryReads(next)
}
