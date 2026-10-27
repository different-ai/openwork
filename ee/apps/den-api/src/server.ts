import { Server } from "node:http"
import { DEN_HTTP_KEEP_ALIVE_TIMEOUT_MS, serveDenHttp } from "./http-server.js"
import { DEN_SHUTDOWN_DRAIN_MS, installGracefulShutdown, trackEventStreams } from "./graceful-shutdown.js"
import { markDraining } from "./drain-state.js"
import app from "./app.js"
import { startSlackAssistantWorker } from "./slack-assistant/worker.js"
import { startSlackDesktopHandoffWorker } from "./slack-assistant/desktop-handoff.js"
import { startWorkbotProactiveWorker } from "./workbot-proactive/worker.js"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import { shutdownObservability } from "./observability/runtime.js"
import { startScimMaintenanceLoop } from "./scim-maintenance.js"
import { startBillingInvitationExpiryLoop } from "./billing-invitation-expiry.js"
import { startLifecycleEmailLoop } from "./lifecycle-emails/index.js"
import { startCloudIdleStopLoop } from "./workers/cloud-lifecycle.js"
import { startWorkerProvisioningReconcileLoop } from "./workers/reconciler.js"
import { startGithubSyncWorker } from "./workers/github-sync.js"
import { externalMcpClientRuntimeName } from "./capability-sources/external-mcp-client-runtime.js"
import { startAutomationSchedulerLoop } from "./automations/scheduler-loop.js"
import { startModelsAnalyticsExportLoop } from "./models-analytics-export.js"
import { markServerListening } from "./server-start.js"

const stopSlackAssistantWorker = startSlackAssistantWorker()
const stopSlackDesktopHandoffWorker = startSlackDesktopHandoffWorker()
const stopWorkbotProactiveWorker = startWorkbotProactiveWorker()
const stopScimMaintenanceLoop = startScimMaintenanceLoop()
const stopBillingInvitationExpiryLoop = startBillingInvitationExpiryLoop()
const stopLifecycleEmailLoop = startLifecycleEmailLoop()
const stopCloudIdleStopLoop = startCloudIdleStopLoop()
const stopWorkerProvisioningReconcileLoop = startWorkerProvisioningReconcileLoop()
const stopGithubSyncWorker = startGithubSyncWorker()
const stopModelsAnalyticsExportLoop = startModelsAnalyticsExportLoop()
const automationScheduler = startAutomationSchedulerLoop({ enabled: env.automations.runtimeEnabled })

appLogger.info("external mcp implementation selected", { component: "server", runtime: externalMcpClientRuntimeName })

// Optional bind host: eval/testkit servers run in dev mode (unauthenticated
// dev outbox) and must not be reachable from the LAN; production/default
// behavior (all interfaces) is unchanged when DEN_BIND_HOST is unset.
const bindHost = process.env.DEN_BIND_HOST?.trim()
const server = serveDenHttp({ fetch: trackEventStreams(app.fetch), port: env.port, ...(bindHost ? { hostname: bindHost } : {}) }, (info) => {
  markServerListening()
  appLogger.info("server listening", { component: "server", port: info.port, keep_alive_timeout_ms: DEN_HTTP_KEEP_ALIVE_TIMEOUT_MS })
})

if (!(server instanceof Server)) throw new Error("den-api expects an HTTP/1.1 server")

const OBSERVABILITY_SHUTDOWN_TIMEOUT_MS = 2_500

async function stopBackgroundLoops() {
  stopModelsAnalyticsExportLoop()
  const results = await Promise.allSettled([
    stopScimMaintenanceLoop(),
    stopBillingInvitationExpiryLoop(),
    stopLifecycleEmailLoop(),
    stopSlackAssistantWorker(),
    stopSlackDesktopHandoffWorker(),
    stopWorkbotProactiveWorker(),
    stopCloudIdleStopLoop(),
    stopWorkerProvisioningReconcileLoop(),
    stopGithubSyncWorker(),
    automationScheduler.stop(),
  ])

  for (const result of results) {
    if (result.status === "rejected") {
      appLogger.error("background loop shutdown failed", { component: "server", error: result.reason })
    }
  }
}

installGracefulShutdown(server, {
  drainTimeoutMs: DEN_SHUTDOWN_DRAIN_MS,
  onDrainStart: markDraining,
  stopBackgroundWork: stopBackgroundLoops,
  afterStop: shutdownObservability,
  afterStopTimeoutMs: OBSERVABILITY_SHUTDOWN_TIMEOUT_MS,
  log: (message, details) => appLogger.info(`shutdown: ${message}`, { component: "server", ...details }),
})
