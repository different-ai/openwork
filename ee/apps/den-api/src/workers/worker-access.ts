import { and, asc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"
import type { RuntimeInstanceInspection, RuntimeInstanceRecord } from "@openwork-ee/cloud-runtime/orchestrator"
import { CLOUD_INSTANCE_BACKEND } from "./cloud-constants.js"
import { cloudRuntimeStore, currentCloudImageVersion, getCloudRuntime } from "./cloud-runtime.js"
import { recoverClaimedCloudWorker, wakeCloudWorker } from "./cloud-lifecycle.js"
import { probeCloudWorkerActivity, type ProbeCloudWorkerActivity } from "./cloud-activity.js"
import { env } from "../env.js"
import { fetchWithConnectRetry, previewFetch } from "./preview-fetch.js"
import {
  cloudStartupFailureFromWorker,
  cloudStartupFailureUpdate,
  createKnownCloudStartupFailure,
  type CloudStartupFailure,
} from "./cloud-failure.js"

export type CloudRuntimeWorker = Pick<typeof WorkerTable.$inferSelect, "id" | "name" | "status"> & Partial<Pick<
  typeof WorkerTable.$inferSelect,
  "cloud_failure_code" | "cloud_failure_stage" | "cloud_failure_reference" | "cloud_failure_at"
>> & {
  image_version?: typeof WorkerTable.$inferSelect.image_version
}
export type CloudRuntimeToken = Pick<typeof WorkerTokenTable.$inferSelect, "scope" | "token">
/** The endpoint half of a runtime record; `sandbox` is present when the host instance is known. */
export type CloudRuntimeSandboxRecord = Pick<RuntimeInstanceRecord, "endpointUrl" | "endpointExpiresAt">
  & Partial<Pick<RuntimeInstanceRecord, "sandbox">>
export type CloudRuntimeSandboxInspection = RuntimeInstanceInspection | null
export type CloudRuntimeStore = {
  claimFailedWorker: (workerId: CloudRuntimeWorker["id"]) => Promise<boolean>
  claimRecycleWorker: (workerId: CloudRuntimeWorker["id"]) => Promise<boolean>
  getActiveTokens: (workerId: CloudRuntimeWorker["id"]) => Promise<CloudRuntimeToken[]>
  markProvisioningWorkerFailed: (workerId: CloudRuntimeWorker["id"], failure?: CloudStartupFailure) => Promise<void>
  markHealthyWorkerFailed: (workerId: CloudRuntimeWorker["id"], failure?: CloudStartupFailure) => Promise<void>
}

type OrganizationId = typeof WorkerTable.$inferSelect.org_id
type UserId = NonNullable<typeof WorkerTable.$inferSelect.created_by_user_id>
type WorkerId = typeof WorkerTable.$inferSelect.id
type GetSandboxRecord = (workerId: WorkerId) => Promise<CloudRuntimeSandboxRecord | null>
type InspectSandbox = (workerId: WorkerId) => Promise<CloudRuntimeSandboxInspection>
type RefreshSignedPreview = (workerId: WorkerId) => Promise<CloudRuntimeSandboxRecord | null>
type ProbeSignedPreview = (signedPreviewUrl: string) => Promise<boolean>
type StartWake = (workerId: WorkerId) => void

export type CloudRuntimeOwnership =
  | { organizationId: OrganizationId; userId: UserId }
  | { organizationId: OrganizationId; workerId: WorkerId }

export type CloudRuntimeState =
  | { status: "ready"; url: string; expiresAt: Date }
  | { status: "waking"; url: null; reason?: "stopped" | "recovering" | "reprovisioning" | "unreachable"; failure?: CloudStartupFailure }
  | { status: "provisioning"; url: null; reason?: "unreachable"; failure?: CloudStartupFailure }
  | { status: "failed"; url: null; reason?: "missing_tokens" | "unreachable" | "preview_expired"; failure?: CloudStartupFailure }

export type CloudWorkerAccess = {
  url: string
  expiresAt: Date
  clientToken: string
  hostToken: string
  workerId: DenTypeId<"worker">
}

export type CloudRuntimeAccessResult =
  | ({ status: "ready" } & CloudWorkerAccess)
  | { status: "waking"; workerId: WorkerId; reason?: "stopped" | "recovering" | "reprovisioning" | "unreachable"; failure?: CloudStartupFailure }
  | { status: "provisioning"; workerId: WorkerId; reason?: "unreachable"; failure?: CloudStartupFailure }
  | { status: "failed"; workerId: WorkerId; reason?: "missing_tokens" | "unreachable" | "preview_expired"; failure?: CloudStartupFailure }
  | { status: "missing" }

export type ResolveCloudRuntimeStateOptions = {
  refreshSignedPreview: RefreshSignedPreview
  getSandboxRecord: GetSandboxRecord
  inspectSandbox: InspectSandbox
  probeSignedPreview: ProbeSignedPreview
  startWake: StartWake
  startRecovery: StartWake
  store: CloudRuntimeStore
  now: () => number
  /** The image version new instances boot; a stopped worker on an older one is recycled. */
  currentImageVersion?: () => string | null
  forceFailedRecovery?: boolean
  /** Asks the instance's own server; any answer proves a slow health probe wrong. */
  probeActivity?: ProbeCloudWorkerActivity
  /** How long a running instance must answer nothing before it is restarted. */
  unreachableGraceMs?: number
  /** Consecutive silent resolves required on top of the grace window. */
  unreachableMisses?: number
}

export type ResolveCloudRuntimeAccessOptions = Partial<ResolveCloudRuntimeStateOptions> & {
  loadWorker?: (ownership: CloudRuntimeOwnership) => Promise<CloudRuntimeWorker | null>
}

type UpdateResultRecord = {
  rowsAffected?: unknown
  affectedRows?: unknown
}

const logger = appLogger.child({ component: "cloud_runtime_access" })
const failedHealCooldownMs = 60_000
const explicitFailedHealCooldownMs = 60_000
const signedPreviewProbeTimeoutMs = 2_500
const signedPreviewHealthCacheMs = 15_000
/** Consecutive silent resolves required, on top of the grace window, before a running instance is restarted. */
export const unreachableMissesBeforeRecovery = 3
const explicitFailedHealAttempts = new Map<WorkerId, number>()
const signedPreviewHealthCache = new Map<WorkerId, { url: string; healthyUntilMs: number }>()
const wakingWorkers = new Set<WorkerId>()
const unreachableWorkers = new Set<WorkerId>()
// Replica-local like the caches above: the floor is "this long of silence as
// seen by the deciding replica", never less.
const unreachableSince = new Map<WorkerId, { firstMissAt: number; misses: number }>()

/** Test seam: forget unreachable windows between scenarios. */
export function resetCloudRuntimeUnreachableWindows() {
  unreachableSince.clear()
}

function isUpdateResultRecord(value: unknown): value is UpdateResultRecord {
  return typeof value === "object" && value !== null
}

function changedRows(result: unknown): number | null {
  if (Array.isArray(result)) {
    for (const value of result) {
      const nestedRows = changedRows(value)
      if (nestedRows !== null) return nestedRows
    }
    return null
  }
  if (!isUpdateResultRecord(result)) return null
  if (typeof result.rowsAffected === "number") return result.rowsAffected
  if (typeof result.affectedRows === "number") return result.affectedRows
  return null
}

const databaseCloudRuntimeStore: CloudRuntimeStore = {
  async claimFailedWorker(workerId) {
    const result: unknown = await db.update(WorkerTable).set({ status: "provisioning" }).where(and(
      eq(WorkerTable.id, workerId),
      eq(WorkerTable.status, "failed"),
    ))
    const rows = changedRows(result)
    return rows !== null && rows > 0
  },
  async claimRecycleWorker(workerId) {
    const result: unknown = await db.update(WorkerTable).set({ status: "provisioning" }).where(and(
      eq(WorkerTable.id, workerId),
      inArray(WorkerTable.status, ["healthy", "stopped"]),
    ))
    const rows = changedRows(result)
    return rows !== null && rows > 0
  },
  async getActiveTokens(workerId) {
    return db.select({ scope: WorkerTokenTable.scope, token: WorkerTokenTable.token })
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
      .orderBy(asc(WorkerTokenTable.created_at))
  },
  async markProvisioningWorkerFailed(workerId, failure) {
    await db.update(WorkerTable).set({
      status: "failed",
      ...(failure ? cloudStartupFailureUpdate(failure) : {}),
    }).where(and(
      eq(WorkerTable.id, workerId),
      eq(WorkerTable.status, "provisioning"),
    ))
  },
  async markHealthyWorkerFailed(workerId, failure) {
    await db.update(WorkerTable).set({
      status: "failed",
      ...(failure ? cloudStartupFailureUpdate(failure) : {}),
    }).where(and(
      eq(WorkerTable.id, workerId),
      eq(WorkerTable.status, "healthy"),
    ))
  },
}

async function loadOwnedCloudWorker(ownership: CloudRuntimeOwnership) {
  const ownershipPredicate = "userId" in ownership
    ? eq(WorkerTable.created_by_user_id, ownership.userId)
    : eq(WorkerTable.id, ownership.workerId)
  const rows = await db.select({
    id: WorkerTable.id,
    name: WorkerTable.name,
    status: WorkerTable.status,
    image_version: WorkerTable.image_version,
    cloud_failure_code: WorkerTable.cloud_failure_code,
    cloud_failure_stage: WorkerTable.cloud_failure_stage,
    cloud_failure_reference: WorkerTable.cloud_failure_reference,
    cloud_failure_at: WorkerTable.cloud_failure_at,
  }).from(WorkerTable).where(and(
    eq(WorkerTable.org_id, ownership.organizationId),
    ownershipPredicate,
    eq(WorkerTable.destination, "cloud"),
    eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
  )).orderBy(asc(WorkerTable.created_at), asc(WorkerTable.id)).limit(1)
  return rows[0] ?? null
}

function tokenByScope(tokens: CloudRuntimeToken[], scope: CloudRuntimeToken["scope"]) {
  return tokens.find((entry) => entry.scope === scope)?.token ?? null
}

function healthUrlForPreview(signedPreviewUrl: string) {
  return `${signedPreviewUrl.replace(/\/+$/, "")}/health`
}

export async function probeCloudRuntimeSignedPreview(signedPreviewUrl: string) {
  try {
    const response = await fetchWithConnectRetry({
      fetchImpl: previewFetch(),
      url: healthUrlForPreview(signedPreviewUrl),
      init: {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(signedPreviewProbeTimeoutMs),
      },
    })
    return response.ok
  } catch {
    return false
  }
}

function startDefaultWake(workerId: WorkerId) {
  if (wakingWorkers.has(workerId)) return
  wakingWorkers.add(workerId)
  void wakeCloudWorker(workerId).catch(() => undefined).finally(() => wakingWorkers.delete(workerId))
}

function startDefaultRecovery(workerId: WorkerId) {
  if (wakingWorkers.has(workerId)) return
  wakingWorkers.add(workerId)
  void recoverClaimedCloudWorker(workerId).catch(() => undefined).finally(() => wakingWorkers.delete(workerId))
}

function cachedPreviewIsHealthy(workerId: WorkerId, url: string, now: number) {
  const cached = signedPreviewHealthCache.get(workerId)
  return cached?.url === url && cached.healthyUntilMs > now
}

function rememberHealthyPreview(workerId: WorkerId, url: string, now: number, expiresAtMs: number) {
  signedPreviewHealthCache.set(workerId, {
    url,
    healthyUntilMs: Math.min(now + signedPreviewHealthCacheMs, expiresAtMs),
  })
}

async function startClaimedCloudRecovery(input: {
  worker: CloudRuntimeWorker
  startRecovery: StartWake
  store: CloudRuntimeStore
}) {
  const claimed = await input.store.claimFailedWorker(input.worker.id)
  if (!claimed) return false
  input.startRecovery(input.worker.id)
  return true
}

function recoveryFailureIsCoolingDown(worker: CloudRuntimeWorker, now: number) {
  if (worker.cloud_failure_stage !== "recovery") return false
  const failedAt = worker.cloud_failure_at
  if (!(failedAt instanceof Date)) return false
  const elapsedMs = now - failedAt.getTime()
  return elapsedMs >= 0 && elapsedMs < failedHealCooldownMs
}

async function resolveFailedCloudRuntime(input: {
  worker: CloudRuntimeWorker
  getSandboxRecord: GetSandboxRecord
  startRecovery: StartWake
  store: CloudRuntimeStore
  now: () => number
  forceRecovery?: boolean
}): Promise<CloudRuntimeState> {
  const now = input.now()
  const failure = cloudStartupFailureFromWorker(input.worker) ?? undefined
  const lastExplicitAttempt = explicitFailedHealAttempts.get(input.worker.id)
  if (input.forceRecovery) {
    if (lastExplicitAttempt !== undefined && now - lastExplicitAttempt < explicitFailedHealCooldownMs) {
      return { status: "failed", url: null, ...(failure ? { failure } : {}) }
    }
    explicitFailedHealAttempts.set(input.worker.id, now)
  } else if (recoveryFailureIsCoolingDown(input.worker, now)) {
    return { status: "failed", url: null, ...(failure ? { failure } : {}) }
  }
  const sandbox = await input.getSandboxRecord(input.worker.id)
  const started = await startClaimedCloudRecovery(input)
  if (!started) return { status: "failed", url: null, ...(failure ? { failure } : {}) }
  return sandbox
    ? { status: "waking", url: null, reason: "recovering", ...(failure ? { failure } : {}) }
    : { status: "provisioning", url: null, ...(failure ? { failure } : {}) }
}

async function readyFromSignedPreview(input: {
  workerId: WorkerId
  signedPreviewUrl: string
  expiresAt: Date
  probeSignedPreview: ProbeSignedPreview
  now: () => number
}): Promise<CloudRuntimeState | null> {
  const now = input.now()
  const expiresAtMs = input.expiresAt.getTime()
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null
  if (cachedPreviewIsHealthy(input.workerId, input.signedPreviewUrl, now)) {
    return { status: "ready", url: input.signedPreviewUrl, expiresAt: input.expiresAt }
  }
  if (await input.probeSignedPreview(input.signedPreviewUrl)) {
    rememberHealthyPreview(input.workerId, input.signedPreviewUrl, now, expiresAtMs)
    return { status: "ready", url: input.signedPreviewUrl, expiresAt: input.expiresAt }
  }
  return null
}

async function refreshAndProbeSignedPreview(input: {
  workerId: WorkerId
  refreshSignedPreview: RefreshSignedPreview
  probeSignedPreview: ProbeSignedPreview
  now: () => number
}): Promise<{ state: CloudRuntimeState | null; endpoint: CloudRuntimeSandboxRecord | null }> {
  try {
    const refreshed = await input.refreshSignedPreview(input.workerId)
    if (!refreshed) return { state: null, endpoint: null }
    const expiresAtMs = refreshed.endpointExpiresAt.getTime()
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.now()) {
      return { state: { status: "failed", url: null, reason: "preview_expired" }, endpoint: null }
    }
    const state = await readyFromSignedPreview({
      workerId: input.workerId,
      signedPreviewUrl: refreshed.endpointUrl,
      expiresAt: refreshed.endpointExpiresAt,
      probeSignedPreview: input.probeSignedPreview,
      now: input.now,
    })
    return { state, endpoint: refreshed }
  } catch {
    return { state: null, endpoint: null }
  }
}

function isStoppedSandboxState(inspection: CloudRuntimeSandboxInspection) {
  return inspection?.state === "stopped"
}

function workerNeedsSnapshotRecycle(worker: CloudRuntimeWorker, imageVersion: string | null) {
  return Boolean(imageVersion && "image_version" in worker && worker.image_version !== imageVersion)
}

async function startStaleStoppedRecycle(input: {
  worker: CloudRuntimeWorker
  sandboxExists: boolean
  inspectSandbox: InspectSandbox
  startRecovery: StartWake
  store: CloudRuntimeStore
  currentImageVersion: () => string | null
}) {
  if (!input.sandboxExists || !workerNeedsSnapshotRecycle(input.worker, input.currentImageVersion())) return false
  let inspection: CloudRuntimeSandboxInspection = null
  try {
    inspection = await input.inspectSandbox(input.worker.id)
  } catch {
    return false
  }
  if (!isStoppedSandboxState(inspection)) return false
  const claimed = await input.store.claimRecycleWorker(input.worker.id)
  if (claimed) input.startRecovery(input.worker.id)
  return true
}

/**
 * The health probe missed. A stopped instance wakes at once; a running one is
 * restarted only after it has answered nothing for the grace window, because a
 * sandbox busy with the member's own work can be slow on `/health` while its
 * server still answers an authenticated request. Restarting it would abort
 * that work and lose everything since the last checkpoint.
 */
async function recoverUnhealthyCloudSandbox(input: {
  worker: CloudRuntimeWorker
  endpoint: CloudRuntimeSandboxRecord | null
  inspectSandbox: InspectSandbox
  probeActivity: ProbeCloudWorkerActivity
  startRecovery: StartWake
  store: CloudRuntimeStore
  now: () => number
  unreachableGraceMs: number
  unreachableMisses: number
}): Promise<CloudRuntimeState> {
  const workerId = input.worker.id
  let inspection: CloudRuntimeSandboxInspection = null
  try {
    inspection = await input.inspectSandbox(workerId)
  } catch {
    inspection = null
  }
  if (isStoppedSandboxState(inspection)) {
    unreachableWorkers.delete(workerId)
    unreachableSince.delete(workerId)
    const claimed = await input.store.claimRecycleWorker(workerId)
    if (claimed) input.startRecovery(workerId)
    return { status: "waking", url: null, reason: "stopped" }
  }

  const nowMs = input.now()
  const endpoint = input.endpoint && input.endpoint.endpointExpiresAt.getTime() > nowMs ? input.endpoint : null
  if (endpoint) {
    const hostToken = tokenByScope(await input.store.getActiveTokens(workerId), "host")
    if (hostToken) {
      const activity = await input.probeActivity({ instanceUrl: endpoint.endpointUrl, hostToken })
      if (activity.alive) {
        unreachableWorkers.delete(workerId)
        unreachableSince.delete(workerId)
        rememberHealthyPreview(workerId, endpoint.endpointUrl, nowMs, endpoint.endpointExpiresAt.getTime())
        logger.warn("cloud runtime health probe missed but the instance answered", {
          worker_id: workerId,
          activity_verdict: activity.verdict,
          activity_reason: activity.reason,
          busy_sessions: activity.busySessions,
        })
        return { status: "ready", url: endpoint.endpointUrl, expiresAt: endpoint.endpointExpiresAt }
      }
    }
  }

  const window = unreachableSince.get(workerId)
  const firstMissAt = window?.firstMissAt ?? nowMs
  const misses = (window?.misses ?? 0) + 1
  if (nowMs - firstMissAt < input.unreachableGraceMs || misses < input.unreachableMisses) {
    unreachableSince.set(workerId, { firstMissAt, misses })
    logger.warn("cloud runtime instance silent; waiting before recovery", {
      worker_id: workerId,
      misses,
      silent_ms: nowMs - firstMissAt,
      grace_ms: input.unreachableGraceMs,
    })
    // Keep handing out the last endpoint so a live stream is not cut by a
    // status poll; real traffic reports its own errors if the instance is gone.
    if (endpoint) return { status: "ready", url: endpoint.endpointUrl, expiresAt: endpoint.endpointExpiresAt }
    unreachableWorkers.add(workerId)
    return { status: "waking", url: null, reason: "unreachable" }
  }

  unreachableSince.delete(workerId)
  unreachableWorkers.add(workerId)
  const failure = createKnownCloudStartupFailure({ code: "runtime_unreachable", stage: "runtime" })
  await input.store.markHealthyWorkerFailed(workerId, failure)
  await startClaimedCloudRecovery(input)
  return { status: "waking", url: null, reason: "unreachable", failure }
}

export async function resolveCloudRuntimeState(input: {
  worker: CloudRuntimeWorker
  organizationId: OrganizationId
}, options: ResolveCloudRuntimeStateOptions): Promise<CloudRuntimeState> {
  if (input.worker.status === "failed") {
    return resolveFailedCloudRuntime({
      worker: input.worker,
      getSandboxRecord: options.getSandboxRecord,
      startRecovery: options.startRecovery,
      store: options.store,
      now: options.now,
      forceRecovery: options.forceFailedRecovery,
    })
  }
  if (input.worker.status === "stopped") {
    unreachableWorkers.delete(input.worker.id)
    const sandbox = await options.getSandboxRecord(input.worker.id)
    if (await startStaleStoppedRecycle({
      worker: input.worker,
      sandboxExists: Boolean(sandbox),
      inspectSandbox: options.inspectSandbox,
      startRecovery: options.startRecovery,
      store: options.store,
      currentImageVersion: options.currentImageVersion ?? currentCloudImageVersion,
    })) return { status: "waking", url: null, reason: "stopped" }
    options.startWake(input.worker.id)
    return { status: "waking", url: null, reason: "stopped" }
  }

  const sandbox = await options.getSandboxRecord(input.worker.id)
  if (input.worker.status === "provisioning" && sandbox) {
    return { status: "waking", url: null }
  }
  if (!sandbox) {
    if (input.worker.status === "healthy") {
      const failure = createKnownCloudStartupFailure({ code: "sandbox_missing", stage: "runtime" })
      await options.store.markHealthyWorkerFailed(input.worker.id, failure)
      await startClaimedCloudRecovery({
        worker: input.worker,
        startRecovery: options.startRecovery,
        store: options.store,
      })
      return { status: "waking", url: null, reason: "reprovisioning", failure }
    }
    return { status: "provisioning", url: null }
  }
  if (await startStaleStoppedRecycle({
    worker: input.worker,
    sandboxExists: true,
    inspectSandbox: options.inspectSandbox,
    startRecovery: options.startRecovery,
    store: options.store,
    currentImageVersion: options.currentImageVersion ?? currentCloudImageVersion,
  })) return { status: "waking", url: null, reason: "stopped" }

  if (sandbox.endpointExpiresAt.getTime() > options.now()) {
    const ready = await readyFromSignedPreview({
      workerId: input.worker.id,
      signedPreviewUrl: sandbox.endpointUrl,
      expiresAt: sandbox.endpointExpiresAt,
      probeSignedPreview: options.probeSignedPreview,
      now: options.now,
    })
    if (ready) {
      unreachableSince.delete(input.worker.id)
      return ready
    }
  }
  const refreshed = await refreshAndProbeSignedPreview({
    workerId: input.worker.id,
    refreshSignedPreview: options.refreshSignedPreview,
    probeSignedPreview: options.probeSignedPreview,
    now: options.now,
  })
  const refreshedReady = refreshed.state
  if (refreshedReady?.status === "failed") {
    const failure = createKnownCloudStartupFailure({ code: "preview_expired", stage: "runtime" })
    await options.store.markHealthyWorkerFailed(input.worker.id, failure)
    return { ...refreshedReady, failure }
  }
  if (refreshedReady) {
    unreachableSince.delete(input.worker.id)
    return refreshedReady
  }
  return recoverUnhealthyCloudSandbox({
    worker: input.worker,
    endpoint: refreshed.endpoint ?? sandbox,
    inspectSandbox: options.inspectSandbox,
    probeActivity: options.probeActivity ?? probeCloudWorkerActivity,
    startRecovery: options.startRecovery,
    store: options.store,
    now: options.now,
    unreachableGraceMs: options.unreachableGraceMs ?? env.cloudUnreachableGraceMs,
    unreachableMisses: options.unreachableMisses ?? unreachableMissesBeforeRecovery,
  })
}

export async function resolveCloudRuntimeAccess(
  ownership: CloudRuntimeOwnership,
  options: ResolveCloudRuntimeAccessOptions = {},
): Promise<CloudRuntimeAccessResult> {
  const loadWorker = options.loadWorker ?? loadOwnedCloudWorker
  const worker = await loadWorker(ownership)
  if (!worker) return { status: "missing" }

  const store = options.store ?? databaseCloudRuntimeStore
  const state = await resolveCloudRuntimeState({ worker, organizationId: ownership.organizationId }, {
    refreshSignedPreview: options.refreshSignedPreview ?? ((workerId) => getCloudRuntime().refreshEndpoint(workerId)),
    getSandboxRecord: options.getSandboxRecord ?? ((workerId) => cloudRuntimeStore().get(workerId)),
    inspectSandbox: options.inspectSandbox ?? ((workerId) => getCloudRuntime().inspect(workerId)),
    probeSignedPreview: options.probeSignedPreview ?? probeCloudRuntimeSignedPreview,
    startWake: options.startWake ?? startDefaultWake,
    startRecovery: options.startRecovery ?? startDefaultRecovery,
    store,
    now: options.now ?? Date.now,
    currentImageVersion: options.currentImageVersion,
    forceFailedRecovery: options.forceFailedRecovery,
    probeActivity: options.probeActivity,
    unreachableGraceMs: options.unreachableGraceMs,
    unreachableMisses: options.unreachableMisses,
  })
  const failure = state.status === "ready" ? null : state.failure ?? cloudStartupFailureFromWorker(worker)
  if (state.status === "provisioning") {
    const reason: "unreachable" | undefined = unreachableWorkers.has(worker.id) ? "unreachable" : undefined
    return {
      status: "provisioning",
      workerId: worker.id,
      ...(reason ? { reason } : {}),
      ...(failure ? { failure } : {}),
    }
  }
  if (state.status === "waking") {
    const reason = state.reason ?? (unreachableWorkers.has(worker.id) ? "unreachable" : undefined)
    return { status: "waking", workerId: worker.id, ...(reason ? { reason } : {}), ...(failure ? { failure } : {}) }
  }
  if (state.status === "failed") {
    const reason = state.reason ?? (unreachableWorkers.has(worker.id) ? "unreachable" : undefined)
    return { status: "failed", workerId: worker.id, ...(reason ? { reason } : {}), ...(failure ? { failure } : {}) }
  }

  unreachableWorkers.delete(worker.id)
  explicitFailedHealAttempts.delete(worker.id)
  const tokens = await store.getActiveTokens(worker.id)
  const clientToken = tokenByScope(tokens, "client")
  const hostToken = tokenByScope(tokens, "host")
  if (!clientToken || !hostToken) {
    const accessFailure = createKnownCloudStartupFailure({ code: "access_tokens_missing", stage: "runtime" })
    await store.markHealthyWorkerFailed(worker.id, accessFailure)
    logger.error("cloud runtime ready instance missing access token", {
      worker_id: worker.id,
      failure_code: accessFailure.code,
      failure_stage: accessFailure.stage,
      failure_reference: accessFailure.reference,
    })
    return { status: "failed", workerId: worker.id, reason: "missing_tokens", failure: accessFailure }
  }
  return { status: "ready", workerId: worker.id, url: state.url, expiresAt: state.expiresAt, clientToken, hostToken }
}
