import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server"
import { parseRemoteSessionReceiptUri, remoteSessionReceiptUnavailable } from "./remote-session-resources.js"

export const REMOTE_SESSION_RECEIPT_POLL_MS = 2_000
export const REMOTE_SESSION_RECEIPT_AUTH_MS = 15_000
export const REMOTE_SESSION_RECEIPT_CHECK_TIMEOUT_MS = 5_000
export const REMOTE_SESSION_RECEIPT_MAX_URIS = 10
export const REMOTE_SESSION_RECEIPT_MAX_STREAMS = 4

export type ReceiptWatchClock = {
  now: () => number
  schedule: (callback: () => void, ms: number) => () => void
}
export const receiptWatchClock: ReceiptWatchClock = {
  now: Date.now,
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

type ReceiptReader = (uri: string) => Promise<{ fingerprint: string }>

/** Bound even a hung auth/database call; cancellation never waits for it to settle. */
async function checked<T>(run: () => Promise<T>, signal: AbortSignal, clock: ReceiptWatchClock): Promise<T> {
  signal.throwIfAborted()
  let cancelTimeout: (() => void) | undefined
  let onAbort: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    cancelTimeout = clock.schedule(() => reject(new Error("Remote session receipt check timed out.")), REMOTE_SESSION_RECEIPT_CHECK_TIMEOUT_MS)
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([run(), deadline])
  } finally {
    cancelTimeout?.()
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

/** Each subscription watches the shared stores, including changes made on another replica. */
export function startRemoteSessionReceiptWatch(input: {
  baseline: ReadonlyMap<string, string>
  read: ReceiptReader
  revalidate: (signal: AbortSignal) => Promise<boolean>
  notify: (uri: string) => void
  controller: AbortController
  expiresAt: number
  clock?: ReceiptWatchClock
}): () => void {
  const clock = input.clock ?? receiptWatchClock
  const streamSignal = input.controller.signal
  const operations = new AbortController()
  const signal = operations.signal
  const fingerprints = new Map(input.baseline)
  let pollTimer: (() => void) | undefined
  let authTimer: (() => void) | undefined
  let expiryTimer: (() => void) | undefined
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    operations.abort()
    pollTimer?.()
    authTimer?.()
    expiryTimer?.()
    streamSignal.removeEventListener("abort", stop)
  }
  const fail = () => input.controller.abort(new Error("Remote session receipt subscription is no longer authorized or available."))
  const poll = async () => {
    try {
      const snapshots = await checked(() => Promise.all([...fingerprints.keys()].map(async (uri) => {
        const { fingerprint } = await input.read(uri)
        return { uri, fingerprint }
      })), signal, clock)
      if (stopped || signal.aborted) return
      for (const { uri, fingerprint } of snapshots) {
        if (fingerprints.get(uri) === fingerprint) continue
        fingerprints.set(uri, fingerprint)
        input.notify(uri)
      }
      pollTimer = clock.schedule(() => void poll(), REMOTE_SESSION_RECEIPT_POLL_MS)
    } catch {
      if (!stopped) fail()
    }
  }
  const authorize = async () => {
    try {
      const authorized = await checked(() => input.revalidate(signal), signal, clock)
      if (stopped || signal.aborted) return
      if (!authorized) return fail()
      authTimer = clock.schedule(() => void authorize(), REMOTE_SESSION_RECEIPT_AUTH_MS)
    } catch {
      if (!stopped) fail()
    }
  }
  streamSignal.addEventListener("abort", stop, { once: true })
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= clock.now() || streamSignal.aborted) {
    fail()
    stop()
    return stop
  }
  expiryTimer = clock.schedule(fail, Math.min(input.expiresAt - clock.now(), 2_147_483_647))
  if (fingerprints.size > 0) pollTimer = clock.schedule(() => void poll(), REMOTE_SESSION_RECEIPT_POLL_MS)
  authTimer = clock.schedule(() => void authorize(), REMOTE_SESSION_RECEIPT_AUTH_MS)
  return stop
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * HTTP authorization must precede SDK entry: its listen router bypasses resource handlers.
 * The SDK still owns wire validation, honored filters, acknowledgment, ids and notifications.
 */
export function createRemoteSessionReceiptSubscriptions(clock: ReceiptWatchClock = receiptWatchClock) {
  const streams = new Map<string, number>()
  return {
    async fetch(input: {
      request: Request
      /** Already inspected by the agent route; avoid another body clone on ordinary calls. */
      method?: string | null
      scopeKey: string
      enabled: boolean
      expiresAt: number
      read: ReceiptReader
      revalidate: (hasReceipts: boolean, signal: AbortSignal) => Promise<boolean>
      notify: (uri: string) => void
      serve: (request: Request) => Promise<Response>
    }): Promise<Response> {
      if (input.method !== undefined && input.method !== "subscriptions/listen") return input.serve(input.request)
      const body: unknown = input.request.method === "POST" ? await input.request.clone().json().catch(() => null) : null
      if (!record(body) || body.method !== "subscriptions/listen") return input.serve(input.request)
      const id = typeof body.id === "number" || typeof body.id === "string" ? body.id : null
      const params = record(body.params) ? body.params : null
      const notifications = params && record(params.notifications) ? params.notifications : null
      const requested = notifications?.resourceSubscriptions
      const errorResponse = (code: number, message: string, status = 400) => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status })
      if (requested !== undefined && (!Array.isArray(requested) || !requested.every((uri): uri is string => typeof uri === "string") || requested.length > REMOTE_SESSION_RECEIPT_MAX_URIS)) {
        return errorResponse(ProtocolErrorCode.InvalidParams, "At most ten exact receipt URIs may be subscribed to.")
      }
      const uris: string[] = Array.isArray(requested) ? requested : []
      if (uris.length > 0 && (!input.enabled || uris.some((uri) => !parseRemoteSessionReceiptUri(uri)))) {
        return errorResponse(ProtocolErrorCode.InvalidParams, remoteSessionReceiptUnavailable().message)
      }
      const count = streams.get(input.scopeKey) ?? 0
      if (count >= REMOTE_SESSION_RECEIPT_MAX_STREAMS) return errorResponse(ProtocolErrorCode.InternalError, "Subscription limit reached for this member.", 429)
      streams.set(input.scopeKey, count + 1)
      const controller = new AbortController()
      let released = false
      const release = () => {
        if (released) return
        released = true
        const remaining = (streams.get(input.scopeKey) ?? 1) - 1
        if (remaining > 0) streams.set(input.scopeKey, remaining)
        else streams.delete(input.scopeKey)
        input.request.signal.removeEventListener("abort", abort)
      }
      const abort = () => controller.abort(input.request.signal.reason)
      input.request.signal.addEventListener("abort", abort, { once: true })
      controller.signal.addEventListener("abort", release, { once: true })
      if (input.request.signal.aborted) abort()
      try {
        const baseline = await checked(async () => {
          if (!Number.isFinite(input.expiresAt) || input.expiresAt <= clock.now() || !(await input.revalidate(uris.length > 0, controller.signal))) throw remoteSessionReceiptUnavailable()
          controller.signal.throwIfAborted()
          return new Map(await Promise.all([...new Set(uris)].map(async (uri): Promise<[string, string]> => [uri, (await input.read(uri)).fingerprint])))
        }, controller.signal, clock)
        controller.signal.throwIfAborted()
        if (input.expiresAt <= clock.now()) throw remoteSessionReceiptUnavailable()
        const response = await input.serve(new Request(input.request, { signal: controller.signal }))
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
          controller.abort()
          release()
          return response
        }
        const stop = startRemoteSessionReceiptWatch({
          baseline, read: input.read, revalidate: (signal) => input.revalidate(uris.length > 0, signal), notify: input.notify,
          controller, expiresAt: input.expiresAt, clock,
        })
        // Body.cancel() does not abort Request.signal on Node. Explicitly tear down both.
        const reader = response.body.getReader()
        // SDK shutdown can close its subscription before the client drains the
        // graceful final result. Stop polling without dropping that SDK frame.
        void reader.closed.then(() => { stop(); release() }, () => { stop(); release() })
        let finished = false
        let streamController: ReadableStreamDefaultController<Uint8Array>
        const finish = () => {
          if (finished) return
          finished = true
          stop()
          controller.signal.removeEventListener("abort", onAbort)
          controller.abort()
          release()
        }
        const onAbort = () => {
          if (finished) return
          finish()
          void reader.cancel().catch(() => undefined)
          streamController.error(controller.signal.reason)
        }
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            streamController = value
            controller.signal.addEventListener("abort", onAbort, { once: true })
            if (controller.signal.aborted) onAbort()
          },
          async pull(value) {
            try {
              const next = await reader.read()
              if (finished) return
              if (next.done) { finish(); value.close() }
              else value.enqueue(next.value)
            } catch (error) {
              if (finished) return
              finish()
              value.error(error)
            }
          },
          async cancel(reason) {
            finish()
            await reader.cancel(reason)
          },
        })
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
      } catch (error) {
        controller.abort()
        release()
        return errorResponse(error instanceof ProtocolError ? error.code : ProtocolErrorCode.InternalError,
          error instanceof ProtocolError ? error.message : "Remote session receipt subscription is unavailable.", error instanceof ProtocolError ? 400 : 503)
      }
    },
  }
}
