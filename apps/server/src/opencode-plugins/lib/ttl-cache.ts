export type TtlCache<Key, Value> = {
  clear(): void;
  delete(key: Key): boolean;
  get(key: Key, load: () => Promise<Value>): Promise<Value>;
  getStaleWhileRevalidate(
    key: Key,
    load: () => Promise<Value>,
  ): { stale: boolean; value: Promise<Value> };
};

type CacheEntry<Value> = {
  expiresAt: number;
  staleUntil: number;
  value: Promise<Value>;
  refreshing?: Promise<void>;
};

type TtlCacheOptions<Value> = {
  maxEntries?: number;
  maxStaleMs?: number;
  /** Keep the last-known stale value when a refresh result is not acceptable. */
  shouldReplaceStale?: (value: Value) => boolean;
};

export function createTtlCache<Key, Value>(
  ttlMs: number,
  now: () => number = Date.now,
  options: TtlCacheOptions<Value> = {},
): TtlCache<Key, Value> {
  const entries = new Map<Key, CacheEntry<Value>>();
  const maxEntries = Math.max(1, options.maxEntries ?? 128);
  const maxStaleMs = Math.max(0, options.maxStaleMs ?? 0);
  const shouldReplaceStale = options.shouldReplaceStale;

  const sweep = () => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.staleUntil <= current && !entry.refreshing) entries.delete(key);
    }
  };

  const touch = (key: Key, entry: CacheEntry<Value>) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  const enforceBound = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const insert = (key: Key, load: () => Promise<Value>): Promise<Value> => {
    const startedAt = now();
    const value = load();
    const entry: CacheEntry<Value> = {
      expiresAt: startedAt + ttlMs,
      staleUntil: startedAt + ttlMs + maxStaleMs,
      value,
    };
    entries.set(key, entry);
    enforceBound();
    void value.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return value;
  };

  return {
    clear() {
      entries.clear();
    },
    delete(key) {
      return entries.delete(key);
    },
    get(key, load) {
      sweep();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) {
        touch(key, cached);
        return cached.value;
      }

      if (cached) entries.delete(key);
      return insert(key, load);
    },
    getStaleWhileRevalidate(key, load) {
      sweep();
      const cached = entries.get(key);
      const current = now();
      if (!cached) return { stale: false, value: insert(key, load) };
      touch(key, cached);
      if (cached.expiresAt > current) return { stale: false, value: cached.value };
      if (cached.staleUntil <= current) {
        entries.delete(key);
        return { stale: false, value: insert(key, load) };
      }

      if (!cached.refreshing) {
        const refresh = load();
        cached.refreshing = refresh.then((value) => {
          if (entries.get(key) !== cached) return;
          if (shouldReplaceStale && !shouldReplaceStale(value)) {
            cached.refreshing = undefined;
            // Retry later without discarding the bounded last-known value.
            cached.expiresAt = Math.min(cached.staleUntil, now() + 5_000);
            return;
          }
          const refreshedAt = now();
          entries.set(key, {
            expiresAt: refreshedAt + ttlMs,
            staleUntil: refreshedAt + ttlMs + maxStaleMs,
            value: Promise.resolve(value),
          });
        }).catch(() => {
          if (entries.get(key) !== cached) return;
          cached.refreshing = undefined;
          // Avoid scheduling one failing refresh per prompt while retaining a
          // bounded last-known value.
          cached.expiresAt = Math.min(cached.staleUntil, now() + 5_000);
        });
      }
      return { stale: true, value: cached.value };
    },
  };
}
