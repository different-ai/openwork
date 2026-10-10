import { z } from "zod"

/**
 * The runner's live events for a Slack run's session (ee/apps/headless-runner/src/events.ts), so a reply shows its
 * text as it is written instead of only once each step is stored.
 *
 * A Slack run is advanced in short windows (run.ts), but the model keeps writing between them. A feed therefore stays
 * open for a little while after a window ends and buffers what arrives, so the next window on this process continues
 * without a gap. The window passes a token it got from its checkpoint; a feed only continues for the same token, so a
 * window that ran on another process (and consumed those events there) never gets them twice. Anything else starts a
 * fresh feed, which can't know how much of the step in progress it missed.
 */

export const runnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), messageId: z.string(), status: z.string().optional() }),
  z.object({ type: z.literal("text"), messageId: z.string(), step: z.number(), delta: z.string(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("tool"), messageId: z.string(), step: z.number(), tool: z.string() }),
])
export type RunnerEvent = z.infer<typeof runnerEventSchema>

/** Parses complete server-sent events from `buffer`; returns them and the incomplete remainder. */
export function parseServerSentEvents(buffer: string): { events: RunnerEvent[]; ready: boolean; rest: string } {
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ""
  const events: RunnerEvent[] = []
  let ready = false
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    if (lines.some((line) => line === "event: ready" || line === "event:ready")) {
      ready = true
      continue
    }
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    if (!data) continue
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      continue
    }
    const parsed = runnerEventSchema.safeParse(json)
    if (parsed.success) events.push(parsed.data)
  }
  return { events, ready, rest }
}

export type LiveFeed = {
  /** Just connected: text of a step already in progress before now was missed. */
  readonly fresh: boolean
  /** The connection ended (or fell too far behind); events before that are still returned by take(). */
  readonly closed: boolean
  /** Events since the last take, oldest first. */
  take(): RunnerEvent[]
  /** Ends this window; the feed stays open briefly for the next window that brings `token`. */
  release(token: number): void
}

export type LiveFeedSource = {
  /** A feed of the session's events, or null when the runner's events can't be opened. */
  acquire(sessionId: string, token: number): Promise<LiveFeed | null>
}

type Entry = {
  controller: AbortController
  buffer: RunnerEvent[]
  closed: boolean
  token: number | null
  inUse: boolean
  idle: ReturnType<typeof setTimeout> | null
}

export function createLiveFeeds(options: {
  open: (sessionId: string, signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>
  /** How long a feed waits for the next window. */
  idleMs?: number
  /** A feed that buffered this many events without a window taking them is closed. */
  maxBuffered?: number
  /** How long to wait for the runner to confirm the subscription. */
  readyTimeoutMs?: number
}): LiveFeedSource {
  const idleMs = options.idleMs ?? 30_000
  const maxBuffered = options.maxBuffered ?? 5_000
  const readyTimeoutMs = options.readyTimeoutMs ?? 2_000
  const entries = new Map<string, Entry>()

  const shut = (sessionId: string, entry: Entry) => {
    entry.closed = true
    if (entry.idle) clearTimeout(entry.idle)
    entry.controller.abort()
    if (entries.get(sessionId) === entry) entries.delete(sessionId)
  }

  const pump = async (entry: Entry, stream: ReadableStream<Uint8Array>, onReady: () => void) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseServerSentEvents(buffer)
        buffer = parsed.rest
        if (parsed.ready) onReady()
        entry.buffer.push(...parsed.events)
        if (entry.buffer.length > maxBuffered) break
      }
    } catch {
      // Aborted or dropped: the reader falls back to reading the session.
    } finally {
      entry.closed = true
      onReady()
      entry.controller.abort()
    }
  }

  const handle = (sessionId: string, entry: Entry, fresh: boolean): LiveFeed => ({
    fresh,
    get closed() {
      return entry.closed
    },
    take: () => entry.buffer.splice(0),
    release: (token) => {
      entry.inUse = false
      entry.token = token
      if (entry.closed) return shut(sessionId, entry)
      entry.idle = setTimeout(() => shut(sessionId, entry), idleMs)
      entry.idle.unref?.()
    },
  })

  return {
    async acquire(sessionId, token) {
      const existing = entries.get(sessionId)
      if (existing?.inUse) return null
      if (existing) {
        if (existing.idle) clearTimeout(existing.idle)
        existing.idle = null
        if (!existing.closed && existing.token === token) {
          existing.inUse = true
          return handle(sessionId, existing, false)
        }
        shut(sessionId, existing)
      }
      const controller = new AbortController()
      const stream = await options.open(sessionId, controller.signal).catch(() => null)
      if (!stream) return null
      const entry: Entry = { controller, buffer: [], closed: false, token: null, inUse: true, idle: null }
      entries.set(sessionId, entry)
      // Wait for the runner to confirm the subscription, so a turn sent right after loses none of its text.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, readyTimeoutMs)
        timer.unref?.()
        void pump(entry, stream, () => {
          clearTimeout(timer)
          resolve()
        })
      })
      return handle(sessionId, entry, true)
    },
  }
}
