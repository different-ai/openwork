import { and, asc, eq, isNull, lt, or } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { CLOUD_INSTANCE_BACKEND } from "./cloud-constants.js"
import {
  isDaytonaSandboxMissingError,
  provisionWorkerOnDaytona,
  stopWorkerOnDaytona,
  wakeWorkerOnDaytona,
  type StopWorkerOnDaytonaResult,
} from "./daytona.js"

type WorkerId = typeof WorkerTable.$inferSelect.id
type WorkerStatus = typeof WorkerTable.$inferSelect.status
type CloudWorker = Pick<typeof WorkerTable.$inferSelect, "id" | "name" | "status" | "last_active_at" | "updated_at">
type WorkerToken = typeof WorkerTokenTable.$inferSelect
type WakeWorkerOnDaytona = typeof wakeWorkerOnDaytona
type ProvisionWorkerOnDaytona = typeof provisionWorkerOnDaytona
type StopWorkerOnDaytona = typeof stopWorkerOnDaytona

type CloudLifecycleStore = {
  getWorker: (workerId: WorkerId) => Promise<CloudWorker | null>
  getActiveTokens: (workerId: WorkerId) => Promise<WorkerToken[]>
  listIdleWorkers: (input: { idleBefore: Date; limit: number }) => Promise<CloudWorker[]>
  updateWorkerStatus: (input: { workerId: WorkerId; status: WorkerStatus; imageVersion?: string | null; onlyWhenStatus?: WorkerStatus }) => Promise<void>
}

type WakeCloudWorkerOptions = {
  store?: CloudLifecycleStore
  wakeWorker?: WakeWorkerOnDaytona
  provisionWorker?: ProvisionWorkerOnDaytona
}

type StopIdleCloudWorkersOptions = {
  store?: CloudLifecycleStore
  stopWorker?: StopWorkerOnDaytona
  provisionerMode?: typeof env.provisionerMode
  idleMs?: number
  idleBefore?: Date
  batchSize?: number
}

type StartCloudIdleStopLoopOptions = {
  stopIdleWorkers?: () => Promise<unknown>
}

const logger = appLogger.child({ component: "cloud_lifecycle" })
const wakeInFlight = new Map<WorkerId, Promise<void>>()

let cloudIdleStopRunning = false
let cloudIdleStopPromise: Promise<void> | null = null

function tokenByScope(tokens: WorkerToken[], scope: typeof WorkerTokenTable.$inferSelect.scope) {
  return tokens.find((entry) => entry.scope === scope)?.token ?? null
}

const databaseCloudLifecycleStore: CloudLifecycleStore = {
  async getWorker(workerId) {
    const rows = await db
      .select()
      .from(WorkerTable)
      .where(and(
        eq(WorkerTable.id, workerId),
        eq(WorkerTable.destination, "cloud"),
        eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
      ))
      .limit(1)

    return rows[0] ?? null
  },
  async getActiveTokens(workerId) {
    return db
      .select()
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
  },
  async listIdleWorkers(input) {
    return db
      .select()
      .from(WorkerTable)
      .where(and(
        eq(WorkerTable.destination, "cloud"),
        eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
        eq(WorkerTable.status, "healthy"),
        or(
          lt(WorkerTable.last_active_at, input.idleBefore),
          and(isNull(WorkerTable.last_active_at), lt(WorkerTable.updated_at, input.idleBefore)),
        ),
      ))
      .orderBy(asc(WorkerTable.updated_at))
      .limit(input.limit)
  },
  async updateWorkerStatus(input) {
    const update = input.imageVersion === undefined
      ? { status: input.status }
      : { status: input.status, image_version: input.imageVersion }

    await db
      .update(WorkerTable)
      .set(update)
      .where(input.onlyWhenStatus
        ? and(eq(WorkerTable.id, input.workerId), eq(WorkerTable.status, input.onlyWhenStatus))
        : eq(WorkerTable.id, input.workerId))
  },
}

export function cloudWorkerIdleReferenceTime(worker: Pick<CloudWorker, "last_active_at" | "updated_at">) {
  return worker.last_active_at ?? worker.updated_at
}

export function isCloudWorkerIdleForStop(worker: Pick<CloudWorker, "last_active_at" | "updated_at">, idleBefore: Date) {
  return cloudWorkerIdleReferenceTime(worker).getTime() < idleBefore.getTime()
}

async function markWorkerFailed(store: CloudLifecycleStore, workerId: WorkerId) {
  await store.updateWorkerStatus({ workerId, status: "failed", onlyWhenStatus: "provisioning" })
}

async function safelyMarkWorkerFailed(store: CloudLifecycleStore, workerId: WorkerId) {
  try {
    await markWorkerFailed(store, workerId)
  } catch (error) {
    logger.error("worker wake status update failed", { worker_id: workerId, error })
  }
}

async function runWakeCloudWorker(workerId: WorkerId, options: WakeCloudWorkerOptions) {
  const store = options.store ?? databaseCloudLifecycleStore
  const wakeWorker = options.wakeWorker ?? wakeWorkerOnDaytona
  const provisionWorker = options.provisionWorker ?? provisionWorkerOnDaytona

  try {
    const worker = await store.getWorker(workerId)

    if (!worker) {
      logger.error("worker wake failed", { worker_id: workerId, reason: "worker_not_found" })
      return
    }

    await store.updateWorkerStatus({ workerId, status: "provisioning", onlyWhenStatus: "stopped" })

    const tokens = await store.getActiveTokens(workerId)
    const hostToken = tokenByScope(tokens, "host")
    const clientToken = tokenByScope(tokens, "client")
    const activityToken = tokenByScope(tokens, "activity")

    if (!hostToken || !clientToken || !activityToken) {
      await safelyMarkWorkerFailed(store, workerId)
      logger.error("worker wake failed", { worker_id: workerId, reason: "missing_worker_tokens" })
      return
    }

    const wakeInput = {
      workerId,
      name: worker.name,
      hostToken,
      clientToken,
      activityToken,
    }
    let woken: Awaited<ReturnType<WakeWorkerOnDaytona>>
    try {
      woken = await wakeWorker(wakeInput)
    } catch (error) {
      if (!isDaytonaSandboxMissingError(error)) {
        throw error
      }

      logger.warn("worker wake sandbox missing; reprovisioning", { worker_id: workerId, error })
      woken = await provisionWorker(wakeInput)
    }

    await store.updateWorkerStatus({ workerId, status: woken.status, imageVersion: woken.imageVersion, onlyWhenStatus: "provisioning" })
  } catch (error) {
    await safelyMarkWorkerFailed(store, workerId)
    logger.error("worker wake failed", { worker_id: workerId, error })
  }
}

export async function wakeCloudWorker(workerId: WorkerId, options: WakeCloudWorkerOptions = {}) {
  const existing = wakeInFlight.get(workerId)
  if (existing) {
    return existing
  }

  const promise = runWakeCloudWorker(workerId, options)
    .finally(() => {
      if (wakeInFlight.get(workerId) === promise) {
        wakeInFlight.delete(workerId)
      }
    })
  wakeInFlight.set(workerId, promise)

  return promise
}

function stopResultAllowsStoppedStatus(result: StopWorkerOnDaytonaResult) {
  return result.status === "stopped" || result.status === "no_sandbox"
}

export async function stopIdleCloudWorkers(options: StopIdleCloudWorkersOptions = {}) {
  if ((options.provisionerMode ?? env.provisionerMode) !== "daytona") {
    return { checked: 0, stopped: 0 }
  }

  const store = options.store ?? databaseCloudLifecycleStore
  const stopWorker = options.stopWorker ?? stopWorkerOnDaytona
  const idleBefore = options.idleBefore ?? new Date(Date.now() - (options.idleMs ?? env.cloudIdleStopMs))
  const workers = await store.listIdleWorkers({
    idleBefore,
    limit: options.batchSize ?? env.cloudIdleStopBatchSize,
  })
  let stopped = 0

  for (const worker of workers) {
    try {
      const result = await stopWorker(worker.id)
      if (stopResultAllowsStoppedStatus(result)) {
        await store.updateWorkerStatus({ workerId: worker.id, status: "stopped", onlyWhenStatus: "healthy" })
        stopped += 1
      }
    } catch (error) {
      logger.error("cloud idle stop failed", { worker_id: worker.id, error })
      captureException(error, { component: "cloud_lifecycle", worker_id: worker.id })
    }
  }

  return { checked: workers.length, stopped }
}

export function startCloudIdleStopLoop(
  intervalMs = env.cloudIdleLoopIntervalMs,
  options: StartCloudIdleStopLoopOptions = {},
) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined
  }

  const stopIdleWorkers = options.stopIdleWorkers ?? stopIdleCloudWorkers
  const run = () => {
    if (cloudIdleStopRunning) {
      return
    }

    cloudIdleStopRunning = true
    cloudIdleStopPromise = stopIdleWorkers()
      .then(() => undefined)
      .catch((error) => {
        logger.error("cloud idle stop loop failed", { error })
        captureException(error, { component: "cloud_lifecycle" })
      })
      .finally(() => {
        cloudIdleStopRunning = false
        cloudIdleStopPromise = null
      })
    void cloudIdleStopPromise
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await cloudIdleStopPromise
  }
}
