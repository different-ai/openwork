type Entry<Value> = { value: Value; expiresAt: number }

export function createFeatureCache<Key, Value>(options: {
  lookup: (key: Key) => Promise<Value>
  fallback: Value
  onError: (key: Key, error: unknown) => void
  maxEntries: number
  ttlMs: number
  now?: () => number
}) {
  const entries = new Map<Key, Entry<Value>>()
  const flights = new Map<Key, Promise<Value>>()
  const now = options.now ?? Date.now
  let generation = 0

  function remember(key: Key, entry: Entry<Value>) {
    entries.delete(key)
    entries.set(key, entry)
    if (entries.size <= options.maxEntries) return
    for (const oldest of entries.keys()) {
      entries.delete(oldest)
      break
    }
  }

  function get(key: Key): Promise<Value> {
    const previous = entries.get(key)
    if (previous && previous.expiresAt > now()) return Promise.resolve(previous.value)
    const pending = flights.get(key)
    if (pending) return pending
    const flight = Promise.resolve().then(async () => {
      try {
        while (true) {
          const lookupGeneration = generation
          let value: Value
          try {
            value = await options.lookup(key)
          } catch (error) {
            options.onError(key, error)
            value = previous?.value ?? options.fallback
          }
          if (generation !== lookupGeneration) continue
          remember(key, { value, expiresAt: now() + options.ttlMs })
          return value
        }
      } finally {
        flights.delete(key)
      }
    })
    flights.set(key, flight)
    return flight
  }

  return {
    get,
    invalidate() {
      generation += 1
      for (const entry of entries.values()) entry.expiresAt = 0
    },
  }
}
