import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { cleanupExpiredExternalMcpOAuthTransactions } from "./external-mcp-connections.js"

const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000
const DEFAULT_BATCH_SIZE = 500
const logger = appLogger.child({ component: "external_mcp_oauth_maintenance" })

let maintenanceRunning = false
let maintenancePromise: Promise<void> | null = null

type Cleanup = typeof cleanupExpiredExternalMcpOAuthTransactions

export async function runExternalMcpOAuthTransactionMaintenanceOnce(input: {
  now?: Date
  batchSize?: number
  cleanup?: Cleanup
} = {}) {
  const cleanup = input.cleanup ?? cleanupExpiredExternalMcpOAuthTransactions
  const result = await cleanup({
    now: input.now,
    limit: input.batchSize ?? DEFAULT_BATCH_SIZE,
  })
  if (result.deleted > 0) {
    logger.info("expired external MCP OAuth transactions removed", {
      deleted: result.deleted,
      limit_reached: result.limitReached,
    })
  }
  return result
}

/**
 * Run immediately at Den startup and periodically afterward. Cleanup is
 * idempotent and bounded, so multiple Den replicas may run it independently.
 * Failures are observable but never block server readiness.
 */
export function startExternalMcpOAuthTransactionMaintenanceLoop(
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined
  }

  const run = () => {
    if (maintenanceRunning) return

    maintenanceRunning = true
    maintenancePromise = runExternalMcpOAuthTransactionMaintenanceOnce({ batchSize })
      .then(() => undefined)
      .catch((error) => {
        logger.error("external MCP OAuth transaction maintenance failed", { error })
        captureException(error, { component: "external_mcp_oauth_maintenance" })
      })
      .finally(() => {
        maintenanceRunning = false
        maintenancePromise = null
      })
    void maintenancePromise
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await maintenancePromise
  }
}
