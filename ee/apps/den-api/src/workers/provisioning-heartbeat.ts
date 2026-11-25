import { and, eq } from "@openwork-ee/den-db/drizzle"
import { WorkerTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"

type WorkerId = typeof WorkerTable.$inferSelect.id

const logger = appLogger.child({ component: "provisioning_heartbeat" })

export const provisioningHeartbeatIntervalMs = 30_000

export async function touchProvisioningWorker(workerId: WorkerId) {
  await db
    .update(WorkerTable)
    .set({ updated_at: new Date() })
    .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.status, "provisioning")))
}

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
