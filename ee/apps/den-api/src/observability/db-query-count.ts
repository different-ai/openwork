import { AsyncLocalStorage } from "node:async_hooks"

type QueryCount = { count: number }

const requestQueries = new AsyncLocalStorage<QueryCount>()

/**
 * Drizzle logger that counts the statements issued while one request is
 * handled, for the request log. Only a number is kept, never the statement or
 * its parameters. Work that outlives its request still counts against a store
 * nobody reads, and a nested app.fetch counts in its own request log.
 */
export const dbQueryCounter = {
  logQuery(_query: string, _params: unknown[]) {
    const store = requestQueries.getStore()
    if (store) store.count += 1
  },
}

export function countDbQueries<T>(count: QueryCount, run: () => Promise<T>): Promise<T> {
  return requestQueries.run(count, run)
}
