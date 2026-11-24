import { AsyncLocalStorage } from "node:async_hooks"
import { requestHasWritten } from "./request-reads.js"

const primaryReads = new AsyncLocalStorage<true>()

export function withPrimaryReads<T>(work: () => Promise<T>): Promise<T> {
  return primaryReads.run(true, work)
}

export function shouldReadFromPrimary(): boolean {
  return primaryReads.getStore() === true || requestHasWritten()
}

export function primaryReadsMiddleware(_c: unknown, next: () => Promise<void>): Promise<void> {
  return withPrimaryReads(next)
}
