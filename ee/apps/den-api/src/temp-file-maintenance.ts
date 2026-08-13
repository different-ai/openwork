import { TempFileTable } from "@openwork-ee/den-db/schema"
import { inArray, lt } from "@openwork-ee/den-db/drizzle"
import { db } from "./db.js"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import { captureException } from "./observability/runtime.js"
import { resolveTempFileStorage, type TempFileStorage } from "./temp-file-storage.js"

const SWEEP_BATCH_SIZE = 100
const MAX_BATCHES_PER_RUN = 50

let tempFileSweepRunning = false
let tempFileSweepPromise: Promise<void> | null = null
const logger = appLogger.child({ component: "temp_file_maintenance" })

export async function runTempFileSweepOnce(input: { storage?: TempFileStorage; now?: Date } = {}) {
  const storage = input.storage ?? resolveTempFileStorage()
  const now = input.now ?? new Date()
  let deleted = 0
  let storageFailures = 0

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const expired = await db
      .select({ id: TempFileTable.id, storageKey: TempFileTable.storage_key })
      .from(TempFileTable)
      .where(lt(TempFileTable.expires_at, now))
      .limit(SWEEP_BATCH_SIZE)
    if (expired.length === 0) break

    for (const row of expired) {
      try {
        await storage.delete(row.storageKey)
      } catch (error) {
        // A byte that will not delete must not strand the whole batch; the
        // row is still removed and the object is left to the bucket lifecycle
        // rule or the next operator sweep.
        storageFailures += 1
        logger.warn("temporary file bytes could not be deleted", { fileId: row.id, error })
      }
    }

    await db.delete(TempFileTable).where(inArray(TempFileTable.id, expired.map((row) => row.id)))
    deleted += expired.length
    if (expired.length < SWEEP_BATCH_SIZE) break
  }

  return { deleted, storageFailures }
}

export function startTempFileMaintenanceLoop(intervalMs = env.tempFiles.sweepIntervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return async () => undefined
  }

  const run = () => {
    if (tempFileSweepRunning) {
      return
    }

    tempFileSweepRunning = true
    tempFileSweepPromise = runTempFileSweepOnce()
      .then(() => undefined)
      .catch((error) => {
        logger.error("temporary file sweep failed", { error })
        captureException(error, { component: "temp_file_maintenance" })
      })
      .finally(() => {
        tempFileSweepRunning = false
        tempFileSweepPromise = null
      })
    void tempFileSweepPromise
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await tempFileSweepPromise
  }
}
