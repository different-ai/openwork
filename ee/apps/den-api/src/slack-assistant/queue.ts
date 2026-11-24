export function createSlackEventLoop<E extends { id: string }>(deps: {
  claim: () => Promise<E | null>
  process: (event: E) => Promise<void>
  prune?: () => Promise<void>
  pruneEveryMs?: number
  claimPerTick?: number
  maxInFlight?: number
  now?: () => number
}) {
  const claimPerTick = deps.claimPerTick ?? 8
  const maxInFlight = deps.maxInFlight ?? 32
  const pruneEveryMs = deps.pruneEveryMs ?? 300_000
  const now = deps.now ?? Date.now
  const inFlight = new Map<string, Promise<void>>()
  let claiming = false
  let lastPruned = 0

  return {
    async tick() {
      if (claiming) return
      claiming = true
      try {
        if (deps.prune && now() - lastPruned > pruneEveryMs) {
          await deps.prune()
          lastPruned = now()
        }
        for (let claimed = 0; claimed < claimPerTick && inFlight.size < maxInFlight; claimed += 1) {
          const event = await deps.claim()
          if (!event) break
          const run = deps
            .process(event)
            .catch(() => undefined)
            .finally(() => inFlight.delete(event.id))
          inFlight.set(event.id, run)
        }
      } finally {
        claiming = false
      }
    },
    inFlight: () => inFlight.size,
    async drain() {
      await Promise.allSettled([...inFlight.values()])
    },
  }
}
