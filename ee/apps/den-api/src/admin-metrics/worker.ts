import type { ControlCenterSectionKey } from "@openwork/types/den/admin-control-center"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { dbSnapshotStore, defaultOwner, metricsForTier, refreshMetrics, type Intervals, type MetricTier } from "./snapshots.js"
import { dbRows } from "./sql.js"

const logger = appLogger.child({ component: "admin_metrics" })
const owner = defaultOwner()
// Let the server finish booting before the first refresh.
const FIRST_REFRESH_DELAY_MS = 15_000

export const adminMetricIntervals = (): Intervals => ({ fast: env.adminMetrics.fastIntervalMs, heavy: env.adminMetrics.heavyIntervalMs })

// One queue per process: ticks and manual refreshes never run two metric
// queries side by side. Leases coordinate across instances.
let queue: Promise<void> = Promise.resolve()

function enqueue(keys: readonly ControlCenterSectionKey[], force: boolean, reason: string) {
  const run = queue.then(async () => {
    const outcomes = await refreshMetrics(keys, { store: dbSnapshotStore, context: { now: new Date(), rows: dbRows }, owner, intervals: adminMetricIntervals(), force })
    const failed = Object.entries(outcomes).filter(([, outcome]) => outcome === "failed").map(([key]) => key)
    if (failed.length) logger.warn("admin metric refresh failed", { reason, metrics: failed })
  }).catch((error: unknown) => {
    logger.error("admin metric refresh crashed", { reason, error })
    captureException(error, { component: "admin_metrics" })
  })
  queue = run
  return run
}

/** Recompute every metric now, even one that refreshed recently. Returns without waiting. */
export function scheduleAdminMetricsRefresh() {
  void enqueue([...metricsForTier("fast"), ...metricsForTier("heavy")], true, "manual")
}

export function startAdminMetricsRefreshLoop() {
  const intervals = adminMetricIntervals()
  if (!env.adminMetrics.enabled) return async () => undefined
  const tick = (tier: MetricTier) => () => void enqueue(metricsForTier(tier), false, tier)
  const timers = [setInterval(tick("fast"), intervals.fast), setInterval(tick("heavy"), intervals.heavy)]
  const first = setTimeout(() => {
    tick("fast")()
    tick("heavy")()
  }, FIRST_REFRESH_DELAY_MS)
  for (const timer of [...timers, first]) timer.unref()
  return async () => {
    for (const timer of timers) clearInterval(timer)
    clearTimeout(first)
    await queue
  }
}
