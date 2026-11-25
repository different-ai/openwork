import { ServerResponse, type IncomingMessage, type Server } from "node:http"
import type { Http2Bindings, HttpBindings } from "@hono/node-server"

export const DEN_SHUTDOWN_DRAIN_MS = 240_000

export type GracefulShutdownOptions = {
  drainTimeoutMs: number
  onDrainStart?: () => void
  stopBackgroundWork?: () => Promise<void>
  afterStop?: () => Promise<void>
  afterStopTimeoutMs?: number
  sweepMs?: number
  exit?: (code: number) => void
  log?: (message: string, details?: Record<string, unknown>) => void
  signals?: NodeJS.Signals[]
  processTarget?: Pick<NodeJS.Process, "on" | "off">
}

export type GracefulShutdown = {
  isDraining: () => boolean
  activeRequests: () => number
  shutdown: (reason: string) => Promise<void>
  dispose: () => void
}

type DenFetch = (request: Request, env: HttpBindings | Http2Bindings) => Response | Promise<Response>

const eventStreams = new WeakSet<ServerResponse>()

function isEventStream(request: Request, response: Response) {
  return request.method === "GET"
    && (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")
}

export function trackEventStreams(fetch: DenFetch): DenFetch {
  return async (request, env) => {
    const response = await fetch(request, env)
    if (env.outgoing instanceof ServerResponse && isEventStream(request, response)) eventStreams.add(env.outgoing)
    return response
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
    timer.unref()
  })
  try {
    return await Promise.race([work.then(() => "done" as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function installGracefulShutdown(server: Server, options: GracefulShutdownOptions): GracefulShutdown {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const log = options.log ?? ((message, details) => console.log(`[shutdown] ${message}`, details ?? ""))
  const target = options.processTarget ?? process
  const signals = options.signals ?? ["SIGTERM", "SIGINT"]
  const sweepMs = options.sweepMs ?? 1_000
  const afterStopTimeoutMs = options.afterStopTimeoutMs ?? 5_000

  let draining = false
  let shutdownPromise: Promise<void> | undefined
  const responses = new Set<ServerResponse>()
  const idleWaiters = new Set<() => void>()

  function askToReconnect(response: ServerResponse) {
    if (!response.headersSent) response.setHeader("Connection", "close")
  }

  function closeEventStreams() {
    for (const response of responses) {
      if (eventStreams.has(response)) response.destroy()
    }
  }

  const onRequest = (_request: IncomingMessage, response: ServerResponse) => {
    responses.add(response)
    if (draining) askToReconnect(response)
    response.on("close", () => {
      responses.delete(response)
      if (responses.size === 0) for (const resolve of idleWaiters) resolve()
    })
  }
  server.on("request", onRequest)

  function waitForRequests() {
    if (responses.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        idleWaiters.delete(done)
        resolve()
      }
      idleWaiters.add(done)
    })
  }

  function stopBackgroundWork() {
    if (!options.stopBackgroundWork) return Promise.resolve()
    return options.stopBackgroundWork().catch((error: unknown) => {
      log("background work shutdown failed", { error: describeError(error) })
    })
  }

  async function run(reason: string) {
    draining = true
    options.onDrainStart?.()
    for (const response of responses) askToReconnect(response)
    const startedAt = Date.now()
    log("draining", { reason, activeRequests: responses.size, drainTimeoutMs: options.drainTimeoutMs })

    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    closeEventStreams()
    server.closeIdleConnections()
    const sweep = setInterval(() => {
      closeEventStreams()
      server.closeIdleConnections()
    }, sweepMs)
    sweep.unref()

    let requestsDone = false
    let backgroundDone = false
    const requests = waitForRequests().then(() => { requestsDone = true })
    const background = stopBackgroundWork().then(() => { backgroundDone = true })
    const drained = await withTimeout(Promise.all([requests, background]), options.drainTimeoutMs)
    clearInterval(sweep)

    if (!requestsDone) {
      log("request drain timed out, closing remaining connections", { activeRequests: responses.size })
      server.closeAllConnections()
    } else {
      server.closeIdleConnections()
    }
    if (!backgroundDone) log("background work did not stop before the drain deadline")
    await withTimeout(closed, 1_000)

    if (options.afterStop) {
      const flushed = await withTimeout(options.afterStop().catch((error: unknown) => {
        log("after-stop work failed", { error: describeError(error) })
      }), afterStopTimeoutMs)
      if (flushed === "timeout") log("after-stop work timed out", { afterStopTimeoutMs })
    }

    log("stopped", { reason, drained: drained === "done", elapsedMs: Date.now() - startedAt })
  }

  function shutdown(reason: string) {
    shutdownPromise ??= run(reason)
    return shutdownPromise
  }

  const handlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of signals) {
    const handler = () => {
      if (shutdownPromise) {
        log("second signal, exiting now", { signal, activeRequests: responses.size })
        exit(1)
        return
      }
      void shutdown(signal).then(
        () => exit(0),
        (error: unknown) => {
          log("shutdown failed", { error: describeError(error) })
          exit(1)
        },
      )
    }
    handlers.set(signal, handler)
    target.on(signal, handler)
  }

  return {
    isDraining: () => draining,
    activeRequests: () => responses.size,
    shutdown,
    dispose() {
      server.off("request", onRequest)
      for (const [signal, handler] of handlers) target.off(signal, handler)
    },
  }
}
