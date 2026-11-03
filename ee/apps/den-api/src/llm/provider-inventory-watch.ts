export const PROVIDER_INVENTORY_POLL_MS = 2_000
/** Bounds what a marker cannot show: credential expiry, removed sessions and writes outside a request. */
export const PROVIDER_INVENTORY_MAX_AGE_MS = 60_000
export const PROVIDER_INVENTORY_HEARTBEAT_MS = 15_000
export const PROVIDER_INVENTORY_TIMEOUT_MS = 5_000

export type InventoryWatchClock = {
  now: () => number
  schedule: (callback: () => void, ms: number) => () => void
}
const clock: InventoryWatchClock = {
  now: Date.now,
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

/** Per-connection polling of shared state sees other replicas' writes. No process-local invalidation bus. */
export async function providerInventoryEvents(input: {
  request: Request
  expiresAt: number
  /** Revalidates session and membership from the DB on EVERY read. */
  read: () => Promise<string>
  /**
   * Polled in place of `read`, which runs only when the value changes or is
   * null, or once PROVIDER_INVENTORY_MAX_AGE_MS has passed. Rejects to close the
   * stream. Without it every poll reads.
   */
  marker?: () => Promise<string | null>
  clock?: InventoryWatchClock
  onClose?: () => void
}): Promise<Response> {
  const time = input.clock ?? clock
  const operations = new AbortController()
  const signal = operations.signal
  let pollTimer: (() => void) | undefined
  let expiryTimer: (() => void) | undefined
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    operations.abort()
    pollTimer?.()
    expiryTimer?.()
    input.request.signal.removeEventListener("abort", close)
    input.onClose?.()
  }
  const close = () => {
    if (stopped) return
    stop()
    stream?.close()
  }
  const timedOut = new Error("Provider inventory check timed out.")
  const checked = async <T>(check: () => Promise<T>) => {
    signal.throwIfAborted()
    let cancelTimeout: (() => void) | undefined
    let onAbort: (() => void) | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      cancelTimeout = time.schedule(() => reject(timedOut), PROVIDER_INVENTORY_TIMEOUT_MS)
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      return await Promise.race([check(), deadline])
    } finally {
      cancelTimeout?.()
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }
  // A marker only saves reads, so one that hangs counts as no answer rather than a failed check.
  const readMarker = async () => input.marker
    ? await checked(input.marker).catch((error: unknown) => { if (error === timedOut) return null; throw error })
    : null
  input.request.signal.addEventListener("abort", close, { once: true })
  if (input.request.signal.aborted) close()
  const expires = () => !Number.isFinite(input.expiresAt) || input.expiresAt <= time.now()
  try {
    if (expires()) throw new Error("Provider inventory session expired.")
    // Taken before each read: a write that lands during the read shows up as a change on the next poll.
    let seenMarker = await readMarker()
    let readAt = time.now()
    let revision = await checked(input.read)
    signal.throwIfAborted()
    if (expires()) throw new Error("Provider inventory session expired.")
    let heartbeatAt = time.now()
    const encoder = new TextEncoder()
    const emit = (value: string) => {
      if (!stream || stopped) return
      // A client that never drains its body must not grow a queue forever.
      if (stream.desiredSize !== null && stream.desiredSize <= 0) return close()
      stream.enqueue(encoder.encode(value))
    }
    const changed = () => emit(`event: inventory.changed\ndata: ${JSON.stringify({ revision })}\n\n`)
    const poll = async () => {
      try {
        const marker = await readMarker()
        const stale = marker === null || marker !== seenMarker || time.now() - readAt >= PROVIDER_INVENTORY_MAX_AGE_MS
        if (stale) {
          seenMarker = marker
          readAt = time.now()
        }
        const next = stale ? await checked(input.read) : revision
        if (stopped) return
        if (expires()) return close()
        if (next !== revision) { revision = next; changed() }
        if (time.now() - heartbeatAt >= PROVIDER_INVENTORY_HEARTBEAT_MS) {
          heartbeatAt = time.now()
          emit(": heartbeat\n\n")
        }
        if (!stopped) pollTimer = time.schedule(() => void poll(), PROVIDER_INVENTORY_POLL_MS)
      } catch { close() }
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
        changed()
        expiryTimer = time.schedule(close, Math.min(input.expiresAt - time.now(), 2_147_483_647))
        pollTimer = time.schedule(() => void poll(), PROVIDER_INVENTORY_POLL_MS)
      },
      cancel() { stop() },
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } })
  } catch (error) {
    stop()
    throw error
  }
}
