/**
 * The Slack worker's loop: each tick claims due events and starts them without waiting for the ones already running,
 * so a reply that streams for a while never holds up another mention. Events run at most `maxInFlight` at a time;
 * claimed events hold a database lease, so several Den processes share the queue.
 */
export function createSlackEventLoop<E extends { id: string }>(deps: {
  claim: () => Promise<E | null>
  /** Handles its own failures; a rejection is dropped. */
  process: (event: E) => Promise<void>
  /** Housekeeping run before claiming, at most every `pruneEveryMs`. */
  prune?: () => Promise<void>
  pruneEveryMs?: number
  /** Events claimed per tick. */
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
    /** Claims what is due and starts it; resolves once claiming is done, not when the events finish. */
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
          // A lease keeps one event with one worker, so it can't already be running here.
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
    /** Waits for the events already running. */
    async drain() {
      await Promise.allSettled([...inFlight.values()])
    },
  }
}
