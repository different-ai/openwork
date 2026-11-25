import { and, asc, eq, inArray, isNull, lt, notExists, or } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable, WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import { materializeCloudWorkerProviders } from "../llm/cloud-provider-materialization.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { CLOUD_INSTANCE_BACKEND } from "./cloud-constants.js"
import { automationUpdateChangedRows } from "../automations/update-result.js"
import {
  isCloudRuntimeInstanceMissingError,
  type ProvisionInput,
  type ProvisionedInstance,
  type StopInstanceResult,
} from "@openwork-ee/cloud-runtime/orchestrator"
import { cloudRuntimeConfigured, cloudRuntimeStore, getCloudRuntime, type CloudRuntimeAvailabilityOptions } from "./cloud-runtime.js"
import {
  hasActiveCloudAutomationRun,
  resolveCloudWorkerInterruptibility,
  type CloudWorkerInterruptibility,
  type ProbeCloudWorkerActivity,
} from "./cloud-activity.js"
import { withProvisionDeadline } from "./provision-deadline.js"
import { touchProvisioningWorker, withProvisioningHeartbeat } from "./provisioning-heartbeat.js"
import {
  cloudStartupFailureUpdate,
  createCloudStartupFailure,
  createKnownCloudStartupFailure,
  type CloudStartupFailure,
} from "./cloud-failure.js"

type WorkerId = typeof WorkerTable.$inferSelect.id
type WorkerStatus = typeof WorkerTable.$inferSelect.status
type CloudWorker = Pick<typeof WorkerTable.$inferSelect, "id" | "name" | "status" | "last_active_at" | "updated_at"> & Partial<Pick<typeof WorkerTable.$inferSelect, "org_id">>
type WorkerToken = typeof WorkerTokenTable.$inferSelect
type WakeWorker = (input: ProvisionInput) => Promise<ProvisionedInstance>
type ProvisionWorker = (input: ProvisionInput) => Promise<ProvisionedInstance>
type StopWorker = (workerId: WorkerId) => Promise<StopInstanceResult>
type FlushWorker = (workerId: WorkerId) => Promise<boolean>
type IdleStopInstance = { url: string; hostToken: string } | null

type CloudLifecycleStore = {
  getWorker: (workerId: WorkerId) => Promise<CloudWorker | null>
  getActiveTokens: (workerId: WorkerId) => Promise<WorkerToken[]>
  listIdleWorkers: (input: { idleBefore: Date; limit: number }) => Promise<CloudWorker[]>
  reserveWake: (workerId: WorkerId) => Promise<boolean>
  reserveIdleStop: (input: { workerId: WorkerId; idleBefore: Date }) => Promise<boolean>
  updateWorkerStatus: (input: {
    workerId: WorkerId
    status: WorkerStatus
    imageVersion?: string | null
    failure?: CloudStartupFailure | null
    onlyWhenStatus?: WorkerStatus
  }) => Promise<void>
  touchProvisioningWorker: (workerId: WorkerId) => Promise<void>
}

type WakeCloudWorkerOptions = {
  store?: CloudLifecycleStore
  wakeWorker?: WakeWorker
  provisionWorker?: ProvisionWorker
  materializeProviders?: typeof materializeCloudWorkerProviders
  deadlineMs?: number
  heartbeatIntervalMs?: number
}

type StopIdleCloudWorkersOptions = {
  store?: CloudLifecycleStore
  stopWorker?: StopWorker
  flushWorker?: FlushWorker
  resolveInstance?: (workerId: WorkerId) => Promise<IdleStopInstance>
  probeActivity?: ProbeCloudWorkerActivity
  hasActiveAutomationRun?: (workerId: WorkerId) => Promise<boolean>
  provisionerMode?: CloudRuntimeAvailabilityOptions["provisionerMode"]
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

function noActiveCloudAutomationRun() {
  return notExists(
    db.select({ id: AutomationRunTable.id }).from(AutomationRunTable)
      .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
      .innerJoin(MemberTable, eq(MemberTable.id, AutomationTable.owner_member_id))
      .where(and(
        eq(AutomationTable.organization_id, WorkerTable.org_id),
        eq(MemberTable.userId, WorkerTable.created_by_user_id),
        eq(AutomationRunTable.execution_target, "cloud"),
        inArray(AutomationRunTable.status, ["claimed", "running"]),
      )),
  )
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
  async reserveWake(workerId) {
    const result: unknown = await db.update(WorkerTable).set({ status: "provisioning" }).where(and(
      eq(WorkerTable.id, workerId),
      eq(WorkerTable.status, "stopped"),
    ))
    return automationUpdateChangedRows(result)
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
        noActiveCloudAutomationRun(),
      ))
      .orderBy(asc(WorkerTable.updated_at))
      .limit(input.limit)
  },
  async reserveIdleStop(input) {
    const result: unknown = await db.update(WorkerTable).set({ status: "provisioning" }).where(and(
      eq(WorkerTable.id, input.workerId),
      eq(WorkerTable.status, "healthy"),
      or(
        lt(WorkerTable.last_active_at, input.idleBefore),
        and(isNull(WorkerTable.last_active_at), lt(WorkerTable.updated_at, input.idleBefore)),
      ),
      noActiveCloudAutomationRun(),
    ))
    return automationUpdateChangedRows(result)
  },
  async updateWorkerStatus(input) {
    const update = {
      status: input.status,
      ...(input.imageVersion === undefined ? {} : { image_version: input.imageVersion }),
      ...(input.failure === undefined ? {} : cloudStartupFailureUpdate(input.failure)),
    }

    await db
      .update(WorkerTable)
      .set(update)
      .where(input.onlyWhenStatus
        ? and(eq(WorkerTable.id, input.workerId), eq(WorkerTable.status, input.onlyWhenStatus))
        : eq(WorkerTable.id, input.workerId))
  },
  touchProvisioningWorker,
}

export function cloudWorkerIdleReferenceTime(worker: Pick<CloudWorker, "last_active_at" | "updated_at">) {
  return worker.last_active_at ?? worker.updated_at
}

export function isCloudWorkerIdleForStop(worker: Pick<CloudWorker, "last_active_at" | "updated_at">, idleBefore: Date) {
  return cloudWorkerIdleReferenceTime(worker).getTime() < idleBefore.getTime()
}

async function markWorkerFailed(store: CloudLifecycleStore, workerId: WorkerId, failure: CloudStartupFailure) {
  await store.updateWorkerStatus({ workerId, status: "failed", failure, onlyWhenStatus: "provisioning" })
}

async function safelyMarkWorkerFailed(store: CloudLifecycleStore, workerId: WorkerId, failure: CloudStartupFailure) {
  try {
    await markWorkerFailed(store, workerId, failure)
  } catch (error) {
    logger.error("worker wake status update failed", {
      worker_id: workerId,
      failure_reference: failure.reference,
      error,
    })
  }
}

async function runClaimedCloudWorkerRecovery(workerId: WorkerId, options: WakeCloudWorkerOptions) {
  const store = options.store ?? databaseCloudLifecycleStore
  const wakeWorker = options.wakeWorker ?? ((input: ProvisionInput) => getCloudRuntime().wake(input))
  const provisionWorker = options.provisionWorker ?? ((input: ProvisionInput) => getCloudRuntime().provision(input))
  const materializeProviders = options.materializeProviders ?? materializeCloudWorkerProviders
  const deadlineMs = options.deadlineMs ?? env.cloudProvisionDeadlineMs

  try {
    const worker = await store.getWorker(workerId)

    if (!worker) {
      logger.error("claimed worker recovery failed", { worker_id: workerId, reason: "worker_not_found" })
      return
    }

    if (worker.status !== "provisioning") return

    const tokens = await store.getActiveTokens(workerId)
    const hostToken = tokenByScope(tokens, "host")
    const clientToken = tokenByScope(tokens, "client")
    const activityToken = tokenByScope(tokens, "activity")

    if (!hostToken || !clientToken || !activityToken) {
      const failure = createKnownCloudStartupFailure({ code: "access_tokens_missing", stage: "recovery" })
      await safelyMarkWorkerFailed(store, workerId, failure)
      logger.error("worker wake failed", {
        worker_id: workerId,
        failure_code: failure.code,
        failure_stage: failure.stage,
        failure_reference: failure.reference,
      })
      return
    }

    const wakeInput = {
      workerId,
      name: worker.name,
      hostToken,
      clientToken,
      activityToken,
    }
    await withProvisioningHeartbeat({
      workerId,
      touch: store.touchProvisioningWorker,
      intervalMs: options.heartbeatIntervalMs,
      run: async () => {
        const woken = await withProvisionDeadline({
          promise: (async () => {
            try {
              return await wakeWorker(wakeInput)
            } catch (error) {
              if (!isCloudRuntimeInstanceMissingError(error)) {
                throw error
              }

              logger.warn("worker wake instance missing; reprovisioning", { worker_id: workerId, error })
              return provisionWorker(wakeInput)
            }
          })(),
          deadlineMs,
          label: `cloud wake for ${workerId}`,
        })

        if (woken.status === "healthy" && worker.org_id) {
          try {
            await materializeProviders({
              organizationId: worker.org_id,
              workerId,
              instanceUrl: woken.url,
              hostToken,
              clientToken,
              force: true,
            })
          } catch (error) {
            logger.warn("worker wake provider materialization warning", {
              worker_id: workerId,
              message: error instanceof Error ? error.message : "provider_materialization_failed",
            })
          }
        }

        await store.updateWorkerStatus({
          workerId,
          status: woken.status,
          imageVersion: woken.imageVersion,
          failure: null,
          onlyWhenStatus: "provisioning",
        })
      },
    })
  } catch (error) {
    const failure = createCloudStartupFailure({ stage: "recovery", error })
    await safelyMarkWorkerFailed(store, workerId, failure)
    logger.error("worker wake failed", {
      worker_id: workerId,
      failure_code: failure.code,
      failure_stage: failure.stage,
      failure_reference: failure.reference,
      error,
    })
  }
}

async function runWakeCloudWorker(workerId: WorkerId, options: WakeCloudWorkerOptions) {
  const store = options.store ?? databaseCloudLifecycleStore
  try {
    const worker = await store.getWorker(workerId)
    if (!worker) {
      logger.error("worker wake failed", { worker_id: workerId, reason: "worker_not_found" })
      return
    }

    if (worker.status !== "stopped" || !await store.reserveWake(workerId)) return
    await runClaimedCloudWorkerRecovery(workerId, { ...options, store })
  } catch (error) {
    logger.error("worker wake claim failed", { worker_id: workerId, error })
  }
}

function runWorkerRecoveryOnce(workerId: WorkerId, operation: () => Promise<void>) {
  const existing = wakeInFlight.get(workerId)
  if (existing) return existing

  const promise = operation().finally(() => {
    if (wakeInFlight.get(workerId) === promise) wakeInFlight.delete(workerId)
  })
  wakeInFlight.set(workerId, promise)
  return promise
}

export async function wakeCloudWorker(workerId: WorkerId, options: WakeCloudWorkerOptions = {}) {
  return runWorkerRecoveryOnce(workerId, () => runWakeCloudWorker(workerId, options))
}

export async function recoverClaimedCloudWorker(workerId: WorkerId, options: WakeCloudWorkerOptions = {}) {
  return runWorkerRecoveryOnce(workerId, () => runClaimedCloudWorkerRecovery(workerId, options))
}

function stopResultAllowsStoppedStatus(result: StopInstanceResult) {
  return result.status === "stopped" || result.status === "no_instance"
}

export const idleStopUnknownCyclesBeforeStop = 3
const idleStopUnknownCycles = new Map<WorkerId, number>()

function idleStopMayProceed(workerId: WorkerId, interruptibility: CloudWorkerInterruptibility) {
  if (interruptibility.verdict === "interruptible") {
    idleStopUnknownCycles.delete(workerId)
    return true
  }
  if (interruptibility.verdict === "busy") {
    idleStopUnknownCycles.delete(workerId)
    return false
  }
  const cycles = (idleStopUnknownCycles.get(workerId) ?? 0) + 1
  if (cycles < idleStopUnknownCyclesBeforeStop) {
    idleStopUnknownCycles.set(workerId, cycles)
    return false
  }
  idleStopUnknownCycles.delete(workerId)
  return true
}

export function resetIdleStopUnknownCycles() {
  idleStopUnknownCycles.clear()
}

async function resolveIdleStopInstance(store: CloudLifecycleStore, workerId: WorkerId): Promise<IdleStopInstance> {
  const hostToken = tokenByScope(await store.getActiveTokens(workerId), "host")
  if (!hostToken) return null
  const record = await cloudRuntimeStore().get(workerId)
  if (!record) return null
  const endpoint = record.endpointExpiresAt.getTime() > Date.now()
    ? record
    : await getCloudRuntime().refreshEndpoint(workerId).catch(() => null)
  return endpoint ? { url: endpoint.endpointUrl, hostToken } : null
}

export async function stopIdleCloudWorkers(options: StopIdleCloudWorkersOptions = {}) {
  if (!cloudRuntimeConfigured({ provisionerMode: options.provisionerMode })) {
    return { checked: 0, stopped: 0 }
  }

  const store = options.store ?? databaseCloudLifecycleStore
  const stopWorker = options.stopWorker ?? ((workerId: WorkerId) => getCloudRuntime().stop(workerId))
  const flushWorker = options.flushWorker ?? ((workerId: WorkerId) => getCloudRuntime().flushCheckpoint(workerId))
  const resolveInstance = options.resolveInstance ?? ((workerId: WorkerId) => resolveIdleStopInstance(store, workerId))
  const idleBefore = options.idleBefore ?? new Date(Date.now() - (options.idleMs ?? env.cloudIdleStopMs))
  const workers = await store.listIdleWorkers({
    idleBefore,
    limit: options.batchSize ?? env.cloudIdleStopBatchSize,
  })
  let stopped = 0

  for (const worker of workers) {
    try {
      const interruptibility = await resolveCloudWorkerInterruptibility({
        workerId: worker.id,
        trigger: "idle_stop",
        hasActiveAutomationRun: options.hasActiveAutomationRun ?? hasActiveCloudAutomationRun,
        instance: () => resolveInstance(worker.id),
        probeActivity: options.probeActivity,
      })
      if (!idleStopMayProceed(worker.id, interruptibility)) continue
      if (!await store.reserveIdleStop({ workerId: worker.id, idleBefore })) continue
      await flushWorker(worker.id).catch((error: unknown) => {
        logger.warn("cloud idle stop checkpoint flush failed", { worker_id: worker.id, error })
        return false
      })
      const result = await stopWorker(worker.id)
      if (stopResultAllowsStoppedStatus(result)) {
        await store.updateWorkerStatus({ workerId: worker.id, status: "stopped", onlyWhenStatus: "provisioning" })
        stopped += 1
      } else {
        await store.updateWorkerStatus({ workerId: worker.id, status: "healthy", onlyWhenStatus: "provisioning" })
      }
    } catch (error) {
      await store.updateWorkerStatus({ workerId: worker.id, status: "healthy", onlyWhenStatus: "provisioning" }).catch(() => undefined)
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
