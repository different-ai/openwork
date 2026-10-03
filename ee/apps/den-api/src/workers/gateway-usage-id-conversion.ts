import {
  convertGatewayUsageLegacyIds,
  safeUsageDatabaseCode,
  type GatewayUsageLegacyIdConversion,
} from "@openwork-ee/den-db/gateway-usage-limits"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"

const logger = appLogger.child({ component: "gateway_usage_id_conversion" })

const INTERVAL_MS = 5 * 60_000
// Keep sweeping for longer than a rolling deploy takes: instances still running
// the previous release can create legacy-UUID rows until they have drained.
const MIN_RUNTIME_MS = 30 * 60_000

/**
 * Converts gateway usage rows created before those tables adopted TypeIDs.
 * Runs at startup and every five minutes, then stops once a run finds nothing
 * left and the process has outlived any overlapping rollout. If the first run
 * finds nothing at all, the data was already converted by an earlier process
 * and the loop stops straight away. Every instance runs it; the conversion is
 * idempotent and safe to run concurrently.
 */
export function startGatewayUsageIdConversionLoop(
  options: {
    intervalMs?: number
    minRuntimeMs?: number
    now?: () => number
    convert?: () => Promise<GatewayUsageLegacyIdConversion>
  } = {},
) {
  const intervalMs = options.intervalMs ?? INTERVAL_MS
  const minRuntimeMs = options.minRuntimeMs ?? MIN_RUNTIME_MS
  const now = options.now ?? Date.now
  const convert =
    options.convert ??
    (async () => convertGatewayUsageLegacyIds((await import("../db.js")).db))
  const startedAt = now()
  let running: Promise<void> | null = null
  let runs = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }

  const run = () => {
    if (running || !timer) return
    running = convert()
      .then((result) => {
        runs++
        if (result.converted > 0) logger.info("converted legacy gateway usage IDs", { ...result })
        const clean = !result.remaining && result.converted === 0
        if (clean && (runs === 1 || now() - startedAt >= minRuntimeMs)) {
          logger.info("gateway usage ID conversion complete", { ...result })
          stop()
        }
      })
      .catch((error) => {
        const code = safeUsageDatabaseCode(error)
        if (code === "ER_NO_SUCH_TABLE") {
          logger.warn("gateway usage tables missing; skipping ID conversion", { code })
          stop()
          return
        }
        logger.error("gateway usage ID conversion failed", { code, error })
        captureException(error, { component: "gateway_usage_id_conversion" })
      })
      .finally(() => {
        running = null
      })
  }

  timer = setInterval(run, intervalMs)
  timer.unref()
  run()

  return async () => {
    stop()
    await running
  }
}
