export type ExternalMcpSearchCacheOptions<T> = {
  maxEntries: number
  maxTotalSize?: number
  sizeOf?: (value: T) => number
  ttlMs: number
  now?: () => number
}

type CacheEntry<T> = {
  expiresAt: number
  size: number
  value: T
}

/**
 * A small process-local cache for search-only MCP tool discovery. It stores
 * the complete sanitized tool shape, coalesces concurrent misses, never
 * caches failures, and bounds both lifetime and memory use.
 */
export function createExternalMcpSearchCache<T>(options: ExternalMcpSearchCacheOptions<T>) {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries))
  const maxTotalSize = Math.max(1, Math.floor(options.maxTotalSize ?? maxEntries))
  const ttlMs = Math.max(1, Math.floor(options.ttlMs))
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry<T>>()
  const inFlight = new Map<string, Promise<T>>()
  let totalSize = 0

  function remove(key: string): void {
    const entry = entries.get(key)
    if (!entry) return
    totalSize -= entry.size
    entries.delete(key)
  }

  function remember(key: string, value: T): T {
    let size = 1
    try {
      size = Math.max(1, Math.floor(options.sizeOf?.(value) ?? 1))
    } catch {
      return value
    }
    if (size > maxTotalSize) return value
    remove(key)
    entries.set(key, { value, size, expiresAt: now() + ttlMs })
    totalSize += size
    while (entries.size > maxEntries || totalSize > maxTotalSize) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      remove(oldestKey)
    }
    return value
  }

  return {
    async getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
      const cached = entries.get(key)
      if (cached && cached.expiresAt > now()) {
        entries.delete(key)
        entries.set(key, cached)
        return cached.value
      }
      remove(key)

      const pending = inFlight.get(key)
      if (pending) return pending

      const task = load().then((value) => remember(key, value))
      inFlight.set(key, task)
      try {
        return await task
      } finally {
        if (inFlight.get(key) === task) inFlight.delete(key)
      }
    },
    size(): number {
      return entries.size
    },
    totalSize(): number {
      return totalSize
    },
  }
}
