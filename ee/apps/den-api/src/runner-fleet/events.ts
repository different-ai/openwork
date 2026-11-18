import type { AdminRunnerFleet } from "@openwork/types/den/admin-runner-fleet"

/**
 * The fleet as a live event stream: a `fleet` event with the whole reading on connect and then every few seconds.
 * A stream ends itself after `maxAgeMs` with an `end` event, so a watcher reconnects and is authorized again; a
 * reading that fails sends `unavailable` and the stream carries on.
 *
 * The age is kept under the web app's proxy deadline for one browser request (175 s), so a stream read through it
 * ends cleanly here instead of being cut there.
 */
export const RUNNER_FLEET_EVENT_INTERVAL_MS = 5_000
export const RUNNER_FLEET_EVENT_MAX_AGE_MS = 150_000

export type FleetEventClock = { now: () => number; schedule: (callback: () => void, ms: number) => () => void }
const clock: FleetEventClock = {
  now: Date.now,
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

export function runnerFleetEvents(input: {
  request: Request
  read: () => Promise<AdminRunnerFleet>
  intervalMs?: number
  maxAgeMs?: number
  clock?: FleetEventClock
  onClose?: () => void
}): Response {
  const time = input.clock ?? clock
  const intervalMs = input.intervalMs ?? RUNNER_FLEET_EVENT_INTERVAL_MS
  const endsAt = time.now() + (input.maxAgeMs ?? RUNNER_FLEET_EVENT_MAX_AGE_MS)
  const encoder = new TextEncoder()
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelNext: (() => void) | undefined
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    cancelNext?.()
    input.request.signal.removeEventListener("abort", close)
    input.onClose?.()
  }
  function close() {
    if (stopped) return
    stop()
    try {
      stream?.close()
    } catch {
      // Already closed by the client.
    }
  }
  const emit = (value: string) => {
    if (!stream || stopped) return
    // A watcher that stopped reading must not grow a queue forever.
    if (stream.desiredSize !== null && stream.desiredSize <= 0) return close()
    stream.enqueue(encoder.encode(value))
  }
  const send = async () => {
    try {
      const fleet = await input.read()
      emit(`event: fleet\ndata: ${JSON.stringify(fleet)}\n\n`)
    } catch {
      emit("event: unavailable\ndata: {}\n\n")
    }
    if (stopped) return
    if (time.now() >= endsAt) {
      emit("event: end\ndata: {}\n\n")
      return close()
    }
    cancelNext = time.schedule(() => void send(), intervalMs)
  }
  input.request.signal.addEventListener("abort", close, { once: true })
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller
      if (input.request.signal.aborted) return close()
      emit("retry: 3000\n\n")
      void send()
    },
    cancel() { stop() },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } })
}
