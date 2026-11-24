import { z } from "zod"

export const runnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), messageId: z.string(), status: z.string().optional() }),
  z.object({ type: z.literal("text"), messageId: z.string(), step: z.number(), delta: z.string(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("tool"), messageId: z.string(), step: z.number(), tool: z.string() }),
])
export type RunnerEvent = z.infer<typeof runnerEventSchema>

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
  readonly fresh: boolean
  readonly closed: boolean
  take(): RunnerEvent[]
  release(token: number): void
}

export type LiveFeedSource = {
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
  idleMs?: number
  maxBuffered?: number
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
