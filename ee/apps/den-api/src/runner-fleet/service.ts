import { resolve4 } from "node:dns/promises"
import { and, eq, gte, lt, lte } from "@openwork-ee/den-db/drizzle"
import { AdminMetricSnapshotTable } from "@openwork-ee/den-db/schema"
import type { AdminRunnerFleet, AdminRunnerFleetHistory, RunnerFleetHistoryRange } from "@openwork/types/den/admin-runner-fleet"
import { dbSnapshotStore, defaultOwner } from "../admin-metrics/snapshots.js"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"
import { runnerFleetConfig } from "./config.js"
import { foldFleet, historyFromHours, historyHourKeys, hourKey, mergeHours, storedHour } from "./history.js"
import { readRunnerFleet } from "./reader.js"
import { notConfiguredFleet } from "./state.js"

/**
 * The live fleet for the admin page, and the background job that records its history.
 *
 * History lives in `admin_metric_snapshot` under its own metric key, one row per UTC hour (`range_key` is the hour),
 * beside the Control Center's snapshots and out of their way: those are read by their own range keys.
 */
const logger = appLogger.child({ component: "runner_fleet" })
const HISTORY_METRIC = "runner_fleet_history"
const SAMPLER_LEASE = "runner_fleet_sampler"
const SAMPLE_INTERVAL_MS = 60_000
/** A sampler that stops renewing is replaced after this long. */
const SAMPLER_LEASE_MS = 150_000
const FIRST_SAMPLE_DELAY_MS = 20_000
const RETENTION_HOURS = 31 * 24
/** Readers within this long of each other share one read of the nodes. */
const SHARE_MS = 4_000

let shared: { at: number; fleet: Promise<AdminRunnerFleet> } | null = null

/** The fleet now. Admins watching at the same time, and the sampler, share one read of the nodes. */
export function currentRunnerFleet(): Promise<AdminRunnerFleet> {
  const config = runnerFleetConfig()
  if (!config) return Promise.resolve(notConfiguredFleet(new Date()))
  const now = Date.now()
  if (shared && now - shared.at < SHARE_MS) return shared.fleet
  const fleet = readRunnerFleet(config, { resolve: resolve4, fetch, now: () => new Date() })
  shared = { at: now, fleet }
  // A failed read is not kept: the next reader tries again.
  fleet.catch(() => { if (shared?.fleet === fleet) shared = null })
  return fleet
}

export async function readRunnerFleetHistory(range: RunnerFleetHistoryRange, now = Date.now()): Promise<AdminRunnerFleetHistory> {
  const keys = historyHourKeys(range, now)
  const rows = await db.select({ hour: AdminMetricSnapshotTable.range_key, payload: AdminMetricSnapshotTable.payload }).from(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, HISTORY_METRIC), gte(AdminMetricSnapshotTable.range_key, keys.from), lte(AdminMetricSnapshotTable.range_key, keys.to)))
  return historyFromHours(rows, range, now)
}

async function recordFleet(fleet: AdminRunnerFleet, now: number) {
  const key = hourKey(now)
  // Primary: the hour's row as last written, by this replica or the one that sampled before it.
  const [existing] = await db.$primary.select({ payload: AdminMetricSnapshotTable.payload }).from(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, HISTORY_METRIC), eq(AdminMetricSnapshotTable.range_key, key))).limit(1)
  const payload = mergeHours(storedHour(existing?.payload), foldFleet(storedHour(null), fleet, now))
  const values = { payload, computed_at: new Date(now), duration_ms: 0, error: null, attempted_at: new Date(now) }
  await db.insert(AdminMetricSnapshotTable).values({ metric_key: HISTORY_METRIC, range_key: key, ...values }).onDuplicateKeyUpdate({ set: values })
}

async function pruneHistory(now: number) {
  await db.delete(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, HISTORY_METRIC), lt(AdminMetricSnapshotTable.range_key, hourKey(now - RETENTION_HOURS * 60 * 60_000))))
}

/**
 * Records the fleet once a minute so the page's grids have a past. One Den replica samples at a time (a lease);
 * another takes over when it stops. Off when the fleet is not configured.
 */
export function startRunnerFleetSampler() {
  if (!runnerFleetConfig()) return async () => undefined
  const owner = defaultOwner()
  let running: Promise<void> = Promise.resolve()
  let prunedHour = ""
  const sample = async () => {
    const now = Date.now()
    try {
      if (!await dbSnapshotStore.claim(SAMPLER_LEASE, owner, new Date(now + SAMPLER_LEASE_MS), new Date(now), false)) return
      const fleet = await currentRunnerFleet()
      if (fleet.nodes.length === 0) return
      await recordFleet(fleet, now)
      if (prunedHour !== hourKey(now)) {
        prunedHour = hourKey(now)
        await pruneHistory(now)
      }
    } catch (error) {
      logger.warn("runner fleet sample failed", { error })
    }
  }
  const tick = () => { running = running.then(sample) }
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
  const first = setTimeout(tick, FIRST_SAMPLE_DELAY_MS)
  timer.unref()
  first.unref()
  return async () => {
    clearInterval(timer)
    clearTimeout(first)
    await running
    // Hand the lease back so another replica samples at once.
    await dbSnapshotStore.release(SAMPLER_LEASE, owner, new Date()).catch(() => undefined)
  }
}
