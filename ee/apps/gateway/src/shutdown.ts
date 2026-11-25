import type { IncomingMessage, Server, ServerResponse } from "node:http"

export type GracefulShutdownOptions = {
  drainTimeoutMs: number
  afterDrain?: () => Promise<void>
  afterDrainTimeoutMs?: number
  idleSweepMs?: number
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms)
  })
  try {
    return await Promise.race([work.then(() => "done" as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function installGracefulShutdown(server: Server, options: GracefulShutdownOptions): GracefulShutdown {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const log = options.log ?? ((message, details) => console.log(`[shutdown] ${message}`, details ?? ""))
  const target = options.processTarget ?? process
  const signals = options.signals ?? ["SIGTERM", "SIGINT"]
  const idleSweepMs = options.idleSweepMs ?? 1_000
  const afterDrainTimeoutMs = options.afterDrainTimeoutMs ?? 10_000

  let draining = false
  let shutdownPromise: Promise<void> | undefined
  const responses = new Set<ServerResponse>()
  const idleWaiters = new Set<() => void>()

  function askToReconnect(response: ServerResponse) {
    if (!response.headersSent) response.setHeader("Connection", "close")
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

  function waitForIdle() {
    if (responses.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        idleWaiters.delete(done)
        resolve()
      }
      idleWaiters.add(done)
    })
  }

  async function run(reason: string) {
    draining = true
    for (const response of responses) askToReconnect(response)
    const startedAt = Date.now()
    log("draining", { reason, activeRequests: responses.size, drainTimeoutMs: options.drainTimeoutMs })

    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeIdleConnections()
    const sweep = setInterval(() => server.closeIdleConnections(), idleSweepMs)

    const drained = await withTimeout(waitForIdle(), options.drainTimeoutMs)
    clearInterval(sweep)
    if (drained === "timeout") {
      log("drain timed out, closing remaining connections", { activeRequests: responses.size })
      server.closeAllConnections()
    } else {
      server.closeIdleConnections()
    }
    await withTimeout(closed, 1_000)

    if (options.afterDrain) {
      const flushed = await withTimeout(options.afterDrain().catch((error: unknown) => {
        log("after-drain work failed", { error: error instanceof Error ? error.message : String(error) })
      }), afterDrainTimeoutMs)
      if (flushed === "timeout") log("after-drain work timed out", { afterDrainTimeoutMs })
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
          log("shutdown failed", { error: error instanceof Error ? error.message : String(error) })
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

export async function waitForQueueIdle(state: () => { active: number; queued: number }, pollMs = 100) {
  while (true) {
    const { active, queued } = state()
    if (active === 0 && queued === 0) return
    await sleep(pollMs)
  }
}
