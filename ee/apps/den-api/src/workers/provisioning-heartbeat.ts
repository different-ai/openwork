import { and, eq } from "@openwork-ee/den-db/drizzle"
import { WorkerTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"

type WorkerId = typeof WorkerTable.$inferSelect.id

const logger = appLogger.child({ component: "provisioning_heartbeat" })

/**
 * The stale-provisioning reconciler reads a quiet `updated_at` as an orphaned
 * claim, so every live provisioning owner must keep touching its row until it
 * writes a terminal status. Keep this interval well below
 * `WORKER_PROVISIONING_RECONCILE_STALE_MS` so several missed beats are needed
 * before another owner may reclaim the worker.
 */
export const provisioningHeartbeatIntervalMs = 30_000

/**
 * Bump the claim fence for a worker that is still provisioning. The status
 * predicate keeps the touch inert after any owner writes a terminal status,
 * and the explicit timestamp write keeps MySQL from skipping `ON UPDATE`
 * when no column value changes.
 */
export async function touchProvisioningWorker(workerId: WorkerId) {
  await db
    .update(WorkerTable)
    .set({ updated_at: new Date() })
    .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.status, "provisioning")))
}

/**
 * Run one claimed provisioning action while keeping its worker row visibly
 * alive. Touch failures are logged and dropped: a missed beat only risks an
 * earlier reconcile of a live claim, never a wrong worker status, so the
 * provider action must not fail because of one.
 */
export async function withProvisioningHeartbeat<T>(input: {
  workerId: WorkerId
  run: () => Promise<T>
  touch?: (workerId: WorkerId) => Promise<void>
  intervalMs?: number
}): Promise<T> {
  const touch = input.touch ?? touchProvisioningWorker
  const intervalMs = input.intervalMs ?? provisioningHeartbeatIntervalMs
  let beat: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    beat = beat.then(() => touch(input.workerId)).catch((error) => {
      logger.warn("provisioning heartbeat touch failed", { worker_id: input.workerId, error })
    })
  }, intervalMs)
  timer.unref()

  try {
    return await input.run()
  } finally {
    clearInterval(timer)
    await beat.catch(() => undefined)
  }
}
