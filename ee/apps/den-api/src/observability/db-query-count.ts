import { AsyncLocalStorage } from "node:async_hooks"

type QueryCount = { count: number }

const requestQueries = new AsyncLocalStorage<QueryCount>()

export const dbQueryCounter = {
  logQuery(_query: string, _params: unknown[]) {
    const store = requestQueries.getStore()
    if (store) store.count += 1
  },
}

export function countDbQueries<T>(count: QueryCount, run: () => Promise<T>): Promise<T> {
  return requestQueries.run(count, run)
}
