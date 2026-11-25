import { AsyncLocalStorage } from "node:async_hooks"

type RequestReads = { shared: Map<string, Promise<unknown>>; outer: RequestReads | null; wrote: boolean }

const requestReads = new AsyncLocalStorage<RequestReads>()

export function withRequestReads<T>(run: () => Promise<T>): Promise<T> {
  return requestReads.run({ shared: new Map(), outer: requestReads.getStore() ?? null, wrote: false }, run)
}

export function requestRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const reads = requestReads.getStore()?.shared
  if (!reads) return load()
  const shared = reads.get(key)
  if (shared) return shared as Promise<T>
  const loading = load()
  reads.set(key, loading)
  loading.catch(() => {
    if (reads.get(key) === loading) reads.delete(key)
  })
  return loading
}

const ownerIds = new WeakMap<object, number>()
let lastOwnerId = 0

export function requestReadFor<T>(owner: object, name: string, load: () => Promise<T>): Promise<T> {
  let id = ownerIds.get(owner)
  if (id === undefined) {
    id = ++lastOwnerId
    ownerIds.set(owner, id)
  }
  return requestRead(`${name}:#${id}`, load)
}

export async function requestReadMany<Id, T>(
  ids: readonly Id[],
  keyOf: (id: Id) => string,
  load: (missing: Id[]) => Promise<ReadonlyMap<Id, T>>,
  absent: T,
): Promise<Map<Id, T>> {
  const reads = requestReads.getStore()?.shared
  const uniqueIds = [...new Set(ids)]
  const pending = new Map<Id, Promise<T>>()
  const missing: Id[] = []
  for (const id of uniqueIds) {
    const shared = reads?.get(keyOf(id))
    if (shared) pending.set(id, shared as Promise<T>)
    else missing.push(id)
  }
  if (missing.length > 0) {
    const loading = load(missing)
    for (const id of missing) {
      const one = loading.then((rows) => rows.has(id) ? rows.get(id) as T : absent)
      pending.set(id, one)
      if (!reads) continue
      const key = keyOf(id)
      reads.set(key, one)
      one.catch(() => {
        if (reads.get(key) === one) reads.delete(key)
      })
    }
  }
  return new Map(await Promise.all(uniqueIds.map(async (id) => [id, await pending.get(id)!] as const)))
}

const WRITE_STATEMENT = /^\s*(insert|update|delete|replace)\b/i

export function forgetRequestReadsOnWrite(query: string) {
  if (!WRITE_STATEMENT.test(query)) return
  for (let reads: RequestReads | null | undefined = requestReads.getStore(); reads; reads = reads.outer) {
    reads.shared.clear()
    reads.wrote = true
  }
}

export function requestHasWritten(): boolean {
  for (let reads: RequestReads | null | undefined = requestReads.getStore(); reads; reads = reads.outer) {
    if (reads.wrote) return true
  }
  return false
}
