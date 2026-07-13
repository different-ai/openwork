import { serve } from "@hono/node-server"
import app from "./app.js"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import { shutdownObservability } from "./observability/runtime.js"
import { startScimMaintenanceLoop } from "./scim-maintenance.js"
import { startWorkerProvisioningReconcileLoop } from "./workers/reconciler.js"
import { startTelegramUpdateDispatcher } from "./capability-sources/telegram-dispatcher.js"
import { externalMcpClientRuntimeName } from "./capability-sources/external-mcp-client-runtime.js"

const stopScimMaintenanceLoop = startScimMaintenanceLoop()
const stopWorkerProvisioningReconcileLoop = startWorkerProvisioningReconcileLoop()
const stopTelegramUpdateDispatcher = startTelegramUpdateDispatcher()

appLogger.info("external mcp implementation selected", { component: "server", runtime: externalMcpClientRuntimeName })

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  appLogger.info("server listening", { component: "server", port: info.port })
})

let shuttingDown = false
const SERVER_CLOSE_TIMEOUT_MS = 3_000
const BACKGROUND_STOP_TIMEOUT_MS = 3_000
const OBSERVABILITY_SHUTDOWN_TIMEOUT_MS = 2_500

type CloseAllConnectionsServer = {
  closeAllConnections: () => void
}

function canCloseAllConnections(value: object): value is CloseAllConnectionsServer {
  return "closeAllConnections" in value && typeof value.closeAllConnections === "function"
}

function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref()
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

async function closeServer() {
  const closePromise = new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  try {
    await withTimeout("server close", closePromise, SERVER_CLOSE_TIMEOUT_MS)
  } catch (error) {
    appLogger.warn("server close did not finish before timeout", { component: "server", error })
    if (canCloseAllConnections(server)) {
      server.closeAllConnections()
    }
    await withTimeout("server force close", closePromise, 1_000).catch((forceError) => {
      appLogger.error("server force close did not finish", { component: "server", error: forceError })
    })
  }
}

async function stopBackgroundLoops() {
  const results = await Promise.allSettled([
    stopScimMaintenanceLoop(),
    stopWorkerProvisioningReconcileLoop(),
    stopTelegramUpdateDispatcher(),
  ])

  for (const result of results) {
    if (result.status === "rejected") {
      appLogger.error("background loop shutdown failed", { component: "server", error: result.reason })
    }
  }
}

async function shutdown(signal: "SIGTERM" | "SIGINT") {
  if (shuttingDown) {
    appLogger.warn("second shutdown signal received", { component: "server", signal })
    process.exit(1)
    return
  }
  shuttingDown = true

  appLogger.info("shutdown requested", { component: "server", signal })
  await withTimeout("background loop shutdown", stopBackgroundLoops(), BACKGROUND_STOP_TIMEOUT_MS).catch((error) => {
    appLogger.error("background loop shutdown timed out", { component: "server", error })
  })
  await closeServer()
  await withTimeout("observability shutdown", shutdownObservability(), OBSERVABILITY_SHUTDOWN_TIMEOUT_MS).catch((error) => {
    appLogger.error("observability shutdown failed", { component: "server", error })
  })
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
    .then(() => process.exit(0))
    .catch((error) => {
      appLogger.error("shutdown failed", { component: "server", error })
      process.exit(1)
    })
})
process.on("SIGINT", () => {
  void shutdown("SIGINT")
    .then(() => process.exit(0))
    .catch((error) => {
      appLogger.error("shutdown failed", { component: "server", error })
      process.exit(1)
    })
})
