import { and, asc, eq, isNull, lt } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { automationUpdateChangedRows } from "../automations/update-result.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { continueCloudProvisioning } from "../routes/workers/shared.js"

type ProvisioningWorker = typeof WorkerTable.$inferSelect
type WorkerToken = typeof WorkerTokenTable.$inferSelect
type ProvisioningReconcileStore = {
  listStaleWorkers: (input: { staleBefore: Date; limit: number }) => Promise<ProvisioningWorker[]>
  claimWorker: (input: { worker: ProvisioningWorker; staleBefore: Date; claimedAt: Date }) => Promise<boolean>
  getActiveTokens: (workerId: ProvisioningWorker["id"]) => Promise<WorkerToken[]>
  markFailed: (workerId: ProvisioningWorker["id"]) => Promise<void>
}
type ReconcileStaleProvisioningWorkersOptions = {
  store?: ProvisioningReconcileStore
  continueProvisioning?: typeof continueCloudProvisioning
  now?: Date
  staleMs?: number
  batchSize?: number
}
const logger = appLogger.child({ component: "worker_reconciler" })

let workerProvisioningReconcileRunning = false
let workerProvisioningReconcilePromise: Promise<void> | null = null

const databaseProvisioningReconcileStore: ProvisioningReconcileStore = {
  async listStaleWorkers(input) {
    return db
      .select()
      .from(WorkerTable)
      .where(and(
        eq(WorkerTable.destination, "cloud"),
        eq(WorkerTable.status, "provisioning"),
        lt(WorkerTable.updated_at, input.staleBefore),
      ))
      .orderBy(asc(WorkerTable.updated_at))
      .limit(input.limit)
  },
  async claimWorker(input) {
    const result: unknown = await db
      .update(WorkerTable)
      .set({ updated_at: input.claimedAt })
      .where(and(
        eq(WorkerTable.id, input.worker.id),
        eq(WorkerTable.destination, "cloud"),
        eq(WorkerTable.status, "provisioning"),
        eq(WorkerTable.updated_at, input.worker.updated_at),
        lt(WorkerTable.updated_at, input.staleBefore),
      ))
    return automationUpdateChangedRows(result)
  },
  async getActiveTokens(workerId) {
    return db
      .select()
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
  },
  async markFailed(workerId) {
    await db
      .update(WorkerTable)
      .set({ status: "failed" })
      .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.status, "provisioning")))
  },
}

function tokenByScope(
  tokens: Array<typeof WorkerTokenTable.$inferSelect>,
  scope: typeof WorkerTokenTable.$inferSelect.scope,
) {
  return tokens.find((entry) => entry.scope === scope)?.token ?? null
}

async function reconcileWorker(
  worker: ProvisioningWorker,
  store: ProvisioningReconcileStore,
  continueProvisioning: typeof continueCloudProvisioning,
) {
  const tokens = await store.getActiveTokens(worker.id)

  const hostToken = tokenByScope(tokens, "host")
  const clientToken = tokenByScope(tokens, "client")
  const activityToken = tokenByScope(tokens, "activity")

  if (!hostToken || !clientToken || !activityToken) {
    await store.markFailed(worker.id)
    logger.error("provisioning reconcile failed", { worker_id: worker.id, reason: "missing_worker_tokens" })
    return
  }

  await continueProvisioning({
    workerId: worker.id,
    orgId: worker.org_id,
    name: worker.name,
    hostToken,
    clientToken,
    activityToken,
  })
}

export async function reconcileStaleProvisioningWorkers(options: ReconcileStaleProvisioningWorkersOptions = {}) {
  const store = options.store ?? databaseProvisioningReconcileStore
  const continueProvisioning = options.continueProvisioning ?? continueCloudProvisioning
  const scanAt = options.now ?? new Date()
  const staleBefore = new Date(scanAt.getTime() - (options.staleMs ?? env.workerProvisioningReconcileStaleMs))
  const workers = await store.listStaleWorkers({
    staleBefore,
    limit: options.batchSize ?? env.workerProvisioningReconcileBatchSize,
  })

  for (const worker of workers) {
    if (!await store.claimWorker({ worker, staleBefore, claimedAt: options.now ?? new Date() })) continue

    logger.info("reconciling stale provisioning worker", { worker_id: worker.id })
    await reconcileWorker(worker, store, continueProvisioning)
  }

  return { checked: workers.length }
}

export function startWorkerProvisioningReconcileLoop(
  intervalMs = env.workerProvisioningReconcileIntervalMs,
) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined
  }

  const run = () => {
    if (workerProvisioningReconcileRunning) {
      return
    }

    workerProvisioningReconcileRunning = true
    workerProvisioningReconcilePromise = reconcileStaleProvisioningWorkers()
      .then(() => undefined)
      .catch((error) => {
        logger.error("provisioning reconcile loop failed", { error })
        captureException(error, { component: "worker_reconciler" })
      })
      .finally(() => {
        workerProvisioningReconcileRunning = false
        workerProvisioningReconcilePromise = null
      })
    void workerProvisioningReconcilePromise
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await workerProvisioningReconcilePromise
  }
}
