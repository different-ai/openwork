import { timingSafeEqual } from "node:crypto"
import { and, asc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { organizationCloudEnabled } from "../../capability-sources/cloud-rollout.js"
import { db } from "../../db.js"
import { env, type DenOrgMode } from "../../env.js"
import { orgMemberRoute } from "../../middleware/index.js"
import { jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { materializeCloudWorkerProviders } from "../../llm/cloud-provider-materialization.js"
import { currentDaytonaSandboxName, flushWorkerCheckpointOnDaytona, getDaytonaSandboxRecord, inspectDaytonaSandbox, refreshDaytonaSignedPreview, stopWorkerOnDaytona } from "../../workers/daytona.js"
import { CLOUD_INSTANCE_BACKEND, CLOUD_INSTANCE_NAME } from "../../workers/cloud-constants.js"
import { wakeCloudWorker as defaultWakeCloudWorker } from "../../workers/cloud-lifecycle.js"
import { appLogger } from "../../observability/logger.js"
import type { OrgRouteVariables } from "../org/shared.js"
import { continueCloudProvisioning, token } from "../workers/shared.js"

type CloudRouteOptions = {
  memberRoute?: MiddlewareHandler<{ Variables: OrgRouteVariables }>
  orgMode?: DenOrgMode
  provisionerMode?: "stub" | "render" | "daytona"
  daytonaApiKey?: string
  gatewayKey?: string
  continueProvisioning?: typeof continueCloudProvisioning
  refreshSignedPreview?: typeof refreshDaytonaSignedPreview
  cloudWorkerStore?: CloudWorkerStore
  ensureCloudWorker?: EnsureCloudWorker
  getSandboxRecord?: GetSandboxRecord
  inspectSandbox?: InspectSandbox
  probeSignedPreview?: ProbeSignedPreview
  wakeCloudWorker?: WakeCloudWorker
  flushWorkerCheckpoint?: FlushWorkerCheckpoint
  stopCloudWorker?: StopCloudWorker
  materializeProviders?: typeof materializeCloudWorkerProviders
  now?: () => number
}

type CloudWorker = Pick<typeof WorkerTable.$inferSelect, "id" | "name" | "status"> & {
  image_version?: typeof WorkerTable.$inferSelect.image_version
}
type WorkerToken = Pick<typeof WorkerTokenTable.$inferSelect, "scope" | "token">
type CloudSandboxRecord = Pick<NonNullable<Awaited<ReturnType<typeof getDaytonaSandboxRecord>>>, "signed_preview_url" | "signed_preview_url_expires_at"> & {
  sandbox_id?: string | null
}
type CloudSandboxInspection = { state: string | null } | null
type OrgId = typeof WorkerTable.$inferSelect.org_id
type UserId = NonNullable<typeof WorkerTable.$inferSelect.created_by_user_id>
type WorkerId = typeof WorkerTable.$inferSelect.id
type CloudRouteUser = {
  id: UserId
  name?: string | null
  email?: string | null
}
type CloudInstanceResponse = {
  status: "provisioning" | "waking" | "ready" | "failed"
  url: string | null
}
type CloudInstanceMemberResponse = CloudInstanceResponse & {
  imageVersion?: string | null
  instanceName?: string | null
  latestVersion?: string | null
}
type CloudGatewayInstanceResponse = CloudInstanceResponse & {
  clientToken: string | null
  hostToken: string | null
  providerSync?: { status: "degraded"; reason?: "unsupported" }
}
type CloudInstanceUpdateResponse =
  | { ok: true; status: "update_requested" }
  | { ok: false; error: "already_current" | "flush_failed" }
type CloudWorkerStore = {
  getCloudWorker: (input: { orgId: OrgId; userId: UserId }) => Promise<CloudWorker | null>
  insertCloudWorker: (input: { workerId: WorkerId; orgId: OrgId; userId: UserId; name: string }) => Promise<void>
  insertWorkerTokens: (input: { workerId: WorkerId; hostToken: string; clientToken: string; activityToken: string }) => Promise<void>
  deleteCreateRaceLoser: (workerId: WorkerId) => Promise<void>
  claimFailedWorker: (workerId: WorkerId) => Promise<boolean>
  claimRecycleWorker: (workerId: WorkerId) => Promise<boolean>
  getActiveTokens: (workerId: WorkerId) => Promise<WorkerToken[]>
  markProvisioningWorkerFailed: (workerId: WorkerId) => Promise<void>
  markHealthyWorkerFailed: (workerId: WorkerId) => Promise<void>
}
type EnsureCloudWorker = (input: {
  orgId: OrgId
  createdByUserId: UserId
  name: string
  continueProvisioning: typeof continueCloudProvisioning
  store: CloudWorkerStore
}) => Promise<CloudWorker>
type GetSandboxRecord = (workerId: CloudWorker["id"]) => Promise<CloudSandboxRecord | null>
type InspectSandbox = (workerId: CloudWorker["id"]) => Promise<CloudSandboxInspection>
type ProbeSignedPreview = (signedPreviewUrl: string) => Promise<boolean>
type WakeCloudWorker = (workerId: CloudWorker["id"]) => Promise<void>
type FlushWorkerCheckpoint = (workerId: CloudWorker["id"]) => Promise<boolean>
type StopCloudWorker = (workerId: CloudWorker["id"]) => Promise<unknown>

type UpdateResultRecord = {
  rowsAffected?: unknown
  affectedRows?: unknown
}

const cloudInstanceResponseSchema = z.object({
  status: z.enum(["provisioning", "waking", "ready", "failed"]),
  url: z.string().url().nullable(),
  imageVersion: z.string().nullable().optional(),
  instanceName: z.string().nullable().optional(),
  latestVersion: z.string().nullable().optional(),
}).meta({ ref: "CloudInstanceResponse" })

const cloudInstanceUpdateResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    status: z.literal("update_requested"),
  }),
  z.object({
    ok: z.literal(false),
    error: z.enum(["already_current", "flush_failed"]),
  }),
]).meta({ ref: "CloudInstanceUpdateResponse" })

const cloudGatewayInstanceResponseSchema = z.object({
  status: z.enum(["provisioning", "waking", "ready", "failed"]),
  url: z.string().url().nullable(),
  clientToken: z.string().nullable(),
  hostToken: z.string().nullable(),
  providerSync: z.object({
    status: z.literal("degraded"),
    reason: z.literal("unsupported").optional(),
  }).optional(),
}).meta({ ref: "CloudGatewayInstanceResponse" })

function cloudNotFound() {
  return { error: "cloud_not_found" }
}

const logger = appLogger.child({ component: "cloud_routes" })
const cloudWorkerNameMaxLength = 255
const failedHealCooldownMs = 60_000
const signedPreviewProbeTimeoutMs = 2_500
const signedPreviewHealthCacheMs = 15_000
const gatewayKeyHeader = "X-OpenWork-Gateway-Key"
const ensureCloudWorkerInFlight = new Map<string, Promise<CloudWorker>>()
const failedHealAttempts = new Map<WorkerId, number>()
const signedPreviewHealthCache = new Map<WorkerId, { url: string; healthyUntilMs: number }>()

function isUpdateResultRecord(value: unknown): value is UpdateResultRecord {
  return typeof value === "object" && value !== null
}

function changedRows(result: unknown): number | null {
  if (Array.isArray(result)) {
    for (const value of result) {
      const nestedRows = changedRows(value)
      if (nestedRows !== null) {
        return nestedRows
      }
    }
    return null
  }

  if (!isUpdateResultRecord(result)) {
    return null
  }

  if (typeof result.rowsAffected === "number") {
    return result.rowsAffected
  }

  if (typeof result.affectedRows === "number") {
    return result.affectedRows
  }

  return null
}

function hasChangedRows(result: unknown) {
  const rows = changedRows(result)
  return rows !== null && rows > 0
}

function tokenByScope(tokens: WorkerToken[], scope: WorkerToken["scope"]) {
  return tokens.find((entry) => entry.scope === scope)?.token ?? null
}

function truncateForWorkerName(value: string) {
  return Array.from(value).slice(0, cloudWorkerNameMaxLength).join("").trim()
}

function emailLocalPart(email: string | null | undefined) {
  const trimmed = email?.trim() ?? ""
  if (!trimmed) {
    return null
  }

  return trimmed.split("@")[0]?.trim() || trimmed
}

function displayNameForCloudWorker(payload: NonNullable<OrgRouteVariables["organizationContext"]>, user: CloudRouteUser) {
  const member = payload.members.find((entry) => entry.userId === payload.currentMember.userId) ?? null
  const memberName = member?.user.name.trim()
  if (memberName) {
    return memberName
  }

  const userName = user.name?.trim()
  if (userName) {
    return userName
  }

  return emailLocalPart(member?.user.email) ?? emailLocalPart(user.email) ?? "member"
}

function cloudWorkerName(payload: NonNullable<OrgRouteVariables["organizationContext"]>, user: CloudRouteUser) {
  return truncateForWorkerName(`${CLOUD_INSTANCE_NAME} — ${displayNameForCloudWorker(payload, user)}`)
}

function ensureKey(orgId: OrgId, userId: UserId) {
  return `${orgId}:${userId}`
}

function healthUrlForPreview(signedPreviewUrl: string) {
  return `${signedPreviewUrl.replace(/\/+$/, "")}/health`
}

async function probeSignedPreview(signedPreviewUrl: string) {
  try {
    const response = await fetch(healthUrlForPreview(signedPreviewUrl), {
      method: "GET",
      signal: AbortSignal.timeout(signedPreviewProbeTimeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

const databaseCloudWorkerStore: CloudWorkerStore = {
  async getCloudWorker(input) {
    // Cloud is per-user. Legacy shared rows already have created_by_user_id set
    // to the first clicker; that member keeps the row while others get fresh
    // instances. Follow-up: admin user deletion currently nulls
    // created_by_user_id (src/user-deletion.ts), orphaning instances; cleanup is
    // tracked separately.
    const rows = await db
      .select()
      .from(WorkerTable)
      .where(and(
        eq(WorkerTable.org_id, input.orgId),
        eq(WorkerTable.created_by_user_id, input.userId),
        eq(WorkerTable.destination, "cloud"),
        eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
      ))
      .orderBy(asc(WorkerTable.created_at), asc(WorkerTable.id))
      .limit(1)

    return rows[0] ?? null
  },
  async insertCloudWorker(input) {
    await db.insert(WorkerTable).values({
      id: input.workerId,
      org_id: input.orgId,
      created_by_user_id: input.userId,
      name: input.name,
      description: "OpenWork Cloud browser instance",
      destination: "cloud",
      status: "provisioning",
      sandbox_backend: CLOUD_INSTANCE_BACKEND,
    })
  },
  async insertWorkerTokens(input) {
    await db.insert(WorkerTokenTable).values([
      {
        id: createDenTypeId("workerToken"),
        worker_id: input.workerId,
        scope: "host",
        token: input.hostToken,
      },
      {
        id: createDenTypeId("workerToken"),
        worker_id: input.workerId,
        scope: "client",
        token: input.clientToken,
      },
      {
        id: createDenTypeId("workerToken"),
        worker_id: input.workerId,
        scope: "activity",
        token: input.activityToken,
      },
    ])
  },
  async deleteCreateRaceLoser(workerId) {
    await db.transaction(async (tx) => {
      await tx.delete(WorkerTokenTable).where(eq(WorkerTokenTable.worker_id, workerId))
      await tx.delete(WorkerTable).where(eq(WorkerTable.id, workerId))
    })
  },
  async claimFailedWorker(workerId) {
    const result: unknown = await db
      .update(WorkerTable)
      .set({ status: "provisioning" })
      .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.status, "failed")))

    return hasChangedRows(result)
  },
  async claimRecycleWorker(workerId) {
    const result: unknown = await db
      .update(WorkerTable)
      .set({ status: "provisioning" })
      .where(and(eq(WorkerTable.id, workerId), inArray(WorkerTable.status, ["healthy", "stopped"])))

    return hasChangedRows(result)
  },
  async getActiveTokens(workerId) {
    return db
      .select({ scope: WorkerTokenTable.scope, token: WorkerTokenTable.token })
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
  },
  async markProvisioningWorkerFailed(workerId) {
    await db
      .update(WorkerTable)
      .set({ status: "failed" })
      .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.status, "provisioning")))
  },
  async markHealthyWorkerFailed(workerId) {
    await db
      .update(WorkerTable)
      .set({ status: "failed" })
      .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.status, "healthy")))
  },
}

function hasDaytonaProvisioner(options: CloudRouteOptions) {
  const apiKey = options.daytonaApiKey !== undefined ? options.daytonaApiKey : env.daytona.apiKey
  return (options.provisionerMode ?? env.provisionerMode) === "daytona" && Boolean(apiKey?.trim())
}

function cloudAvailable(payload: NonNullable<OrgRouteVariables["organizationContext"]>, options: CloudRouteOptions) {
  return organizationCloudEnabled(payload.organization.metadata, { orgMode: options.orgMode ?? env.orgMode }) && hasDaytonaProvisioner(options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function hasCloudUserId(user: unknown): user is CloudRouteUser {
  if (!isRecord(user)) {
    return false
  }

  if (typeof user.id !== "string" || !user.id.trim()) {
    return false
  }

  if (user.name !== undefined && user.name !== null && typeof user.name !== "string") {
    return false
  }

  if (user.email !== undefined && user.email !== null && typeof user.email !== "string") {
    return false
  }

  return true
}

const textEncoder = new TextEncoder()

function timingSafeStringEqual(left: string, right: string) {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  if (leftBytes.byteLength === rightBytes.byteLength) {
    return timingSafeEqual(leftBytes, rightBytes)
  }

  const byteLength = Math.max(leftBytes.byteLength, rightBytes.byteLength)
  const paddedLeft = new Uint8Array(byteLength)
  const paddedRight = new Uint8Array(byteLength)
  paddedLeft.set(leftBytes)
  paddedRight.set(rightBytes)
  timingSafeEqual(paddedLeft, paddedRight)
  return false
}

function gatewaySecretMatches(requestSecret: string | undefined, configuredSecret: string | undefined) {
  const expected = configuredSecret?.trim()
  const candidate = requestSecret?.trim()
  if (!expected || !candidate) {
    return false
  }

  return timingSafeStringEqual(candidate, expected)
}

async function getCloudWorker(orgId: OrgId, userId: UserId, store: CloudWorkerStore) {
  return store.getCloudWorker({ orgId, userId })
}

async function createCloudWorker(input: {
  orgId: OrgId
  createdByUserId: UserId
  name: string
  continueProvisioning: typeof continueCloudProvisioning
  store: CloudWorkerStore
}): Promise<CloudWorker> {
  const workerId = createDenTypeId("worker")
  const hostToken = token()
  const clientToken = token()
  const activityToken = token()

  await input.store.insertCloudWorker({ workerId, orgId: input.orgId, userId: input.createdByUserId, name: input.name })
  await input.store.insertWorkerTokens({ workerId, hostToken, clientToken, activityToken })

  const canonical = await getCloudWorker(input.orgId, input.createdByUserId, input.store)
  if (canonical && canonical.id !== workerId) {
    // No unique index exists for (org_id, created_by_user_id, destination,
    // sandbox_backend), and a partial unique is not viable across legacy rows.
    // Converge create races by keeping the oldest canonical row and deleting the
    // losing worker plus the tokens that were minted for it before provisioning.
    await input.store.deleteCreateRaceLoser(workerId)
    return canonical
  }

  void input.continueProvisioning({
    workerId,
    orgId: input.orgId,
    name: input.name,
    hostToken,
    clientToken,
    activityToken,
  })

  return canonical ?? { id: workerId, name: input.name, status: "provisioning" }
}

async function ensureCloudWorker(input: {
  orgId: OrgId
  createdByUserId: UserId
  name: string
  continueProvisioning: typeof continueCloudProvisioning
  store: CloudWorkerStore
}) {
  const key = ensureKey(input.orgId, input.createdByUserId)
  const existingPromise = ensureCloudWorkerInFlight.get(key)
  if (existingPromise) {
    return existingPromise
  }

  const promise = (async () => {
    const existing = await getCloudWorker(input.orgId, input.createdByUserId, input.store)
    if (existing) {
      return existing
    }

    return createCloudWorker(input)
  })()
    .finally(() => {
      if (ensureCloudWorkerInFlight.get(key) === promise) {
        ensureCloudWorkerInFlight.delete(key)
      }
    })
  ensureCloudWorkerInFlight.set(key, promise)

  return promise
}

function cachedPreviewIsHealthy(workerId: WorkerId, url: string, now: number) {
  const cached = signedPreviewHealthCache.get(workerId)
  return cached?.url === url && cached.healthyUntilMs > now
}

function rememberHealthyPreview(workerId: WorkerId, url: string, now: number) {
  signedPreviewHealthCache.set(workerId, { url, healthyUntilMs: now + signedPreviewHealthCacheMs })
}

async function startFailedCloudHeal(input: {
  worker: CloudWorker
  orgId: OrgId
  continueProvisioning: typeof continueCloudProvisioning
  store: CloudWorkerStore
}) {
  const claimed = await input.store.claimFailedWorker(input.worker.id)
  if (!claimed) {
    return false
  }

  void (async () => {
    const tokens = await input.store.getActiveTokens(input.worker.id)
    const hostToken = tokenByScope(tokens, "host")
    const clientToken = tokenByScope(tokens, "client")
    const activityToken = tokenByScope(tokens, "activity")

    if (!hostToken || !clientToken || !activityToken) {
      await input.store.markProvisioningWorkerFailed(input.worker.id)
      logger.error("cloud failed-worker heal failed", { worker_id: input.worker.id, reason: "missing_worker_tokens" })
      return
    }

    await input.continueProvisioning({
      workerId: input.worker.id,
      orgId: input.orgId,
      name: input.worker.name,
      hostToken,
      clientToken,
      activityToken,
    })
  })()
    .catch(async (error) => {
      await input.store.markProvisioningWorkerFailed(input.worker.id).catch(() => undefined)
      logger.error("cloud failed-worker heal failed", { worker_id: input.worker.id, error })
    })

  return true
}

async function resolveFailedCloudInstance(input: {
  worker: CloudWorker
  orgId: OrgId
  continueProvisioning: typeof continueCloudProvisioning
  getSandboxRecord: GetSandboxRecord
  startWake: (workerId: CloudWorker["id"]) => void
  store: CloudWorkerStore
  now: () => number
}): Promise<CloudInstanceResponse> {
  const now = input.now()
  const lastAttempt = failedHealAttempts.get(input.worker.id)
  if (lastAttempt !== undefined && now - lastAttempt < failedHealCooldownMs) {
    return { status: "failed", url: null }
  }

  failedHealAttempts.set(input.worker.id, now)
  const sandbox = await input.getSandboxRecord(input.worker.id)
  if (sandbox) {
    const claimed = await input.store.claimFailedWorker(input.worker.id)
    if (!claimed) {
      return { status: "failed", url: null }
    }

    input.startWake(input.worker.id)
    return { status: "waking", url: null }
  }

  const started = await startFailedCloudHeal(input)
  if (!started) {
    return { status: "failed", url: null }
  }

  return { status: "provisioning", url: null }
}

async function readyFromSignedPreview(input: {
  workerId: WorkerId
  signedPreviewUrl: string
  probeSignedPreview: ProbeSignedPreview
  now: () => number
}): Promise<CloudInstanceResponse | null> {
  const now = input.now()
  if (cachedPreviewIsHealthy(input.workerId, input.signedPreviewUrl, now)) {
    return { status: "ready", url: input.signedPreviewUrl }
  }

  if (await input.probeSignedPreview(input.signedPreviewUrl)) {
    rememberHealthyPreview(input.workerId, input.signedPreviewUrl, now)
    return { status: "ready", url: input.signedPreviewUrl }
  }

  return null
}

async function refreshAndProbeSignedPreview(input: {
  workerId: WorkerId
  refreshSignedPreview: typeof refreshDaytonaSignedPreview
  probeSignedPreview: ProbeSignedPreview
  now: () => number
}): Promise<CloudInstanceResponse | null> {
  try {
    const refreshed = await input.refreshSignedPreview(input.workerId)
    if (!refreshed) {
      return null
    }

    return readyFromSignedPreview({
      workerId: input.workerId,
      signedPreviewUrl: refreshed.signed_preview_url,
      probeSignedPreview: input.probeSignedPreview,
      now: input.now,
    })
  } catch {
    return null
  }
}

function isStoppedSandboxState(state: string | null) {
  return state?.toLowerCase() === "stopped"
}

function workerNeedsSnapshotRecycle(worker: CloudWorker) {
  const snapshot = env.daytona.snapshot
  return Boolean(snapshot && "image_version" in worker && worker.image_version !== snapshot)
}

function workerNeedsUserRequestedUpdate(worker: CloudWorker) {
  const snapshot = env.daytona.snapshot
  return Boolean(snapshot && (worker.image_version ?? null) !== snapshot)
}

function isRunningSandboxState(state: string | null) {
  const normalized = state?.toLowerCase() ?? ""
  return normalized === "running" || normalized === "started"
}

function cloudInstanceName(worker: CloudWorker, sandbox: CloudSandboxRecord | null) {
  if (!sandbox) return null
  const storedName = sandbox.sandbox_id?.trim() ?? ""
  if (storedName) return storedName
  if ("sandbox_id" in sandbox) {
    return currentDaytonaSandboxName({ workerId: worker.id, name: worker.name })
  }
  return null
}

function memberCloudInstanceResponse(worker: CloudWorker, instance: CloudInstanceResponse, sandbox: CloudSandboxRecord | null): CloudInstanceMemberResponse {
  const instanceName = cloudInstanceName(worker, sandbox)
  return {
    ...instance,
    imageVersion: worker.image_version ?? null,
    ...(instanceName ? { instanceName } : {}),
    latestVersion: env.daytona.snapshot ?? null,
  }
}

async function startStaleStoppedRecycle(input: {
  worker: CloudWorker
  sandboxExists: boolean
  inspectSandbox: InspectSandbox
  startWake: (workerId: CloudWorker["id"]) => void
  store: CloudWorkerStore
}): Promise<boolean> {
  if (!input.sandboxExists || !workerNeedsSnapshotRecycle(input.worker)) {
    return false
  }

  let inspection: CloudSandboxInspection = null
  try {
    inspection = await input.inspectSandbox(input.worker.id)
  } catch {
    return false
  }

  if (!isStoppedSandboxState(inspection?.state ?? null)) {
    return false
  }

  const claimed = await input.store.claimRecycleWorker(input.worker.id)
  if (claimed) {
    input.startWake(input.worker.id)
  }
  return true
}

async function recoverUnhealthyCloudSandbox(input: {
  worker: CloudWorker
  orgId: OrgId
  continueProvisioning: typeof continueCloudProvisioning
  inspectSandbox: InspectSandbox
  startWake: (workerId: CloudWorker["id"]) => void
  store: CloudWorkerStore
}): Promise<CloudInstanceResponse> {
  let inspection: CloudSandboxInspection = null
  try {
    inspection = await input.inspectSandbox(input.worker.id)
  } catch {
    inspection = null
  }

  if (inspection?.state === "stopped") {
    input.startWake(input.worker.id)
    return { status: "waking", url: null }
  }

  await input.store.markHealthyWorkerFailed(input.worker.id)
  await startFailedCloudHeal(input)
  return { status: "waking", url: null }
}

async function resolveCloudInstance(input: {
  worker: CloudWorker
  orgId: OrgId
  continueProvisioning: typeof continueCloudProvisioning
  refreshSignedPreview: typeof refreshDaytonaSignedPreview
  getSandboxRecord: GetSandboxRecord
  inspectSandbox: InspectSandbox
  probeSignedPreview: ProbeSignedPreview
  startWake: (workerId: CloudWorker["id"]) => void
  store: CloudWorkerStore
  now: () => number
}): Promise<CloudInstanceResponse> {
  if (input.worker.status === "failed") {
    return resolveFailedCloudInstance(input)
  }

  if (input.worker.status === "stopped") {
    const sandbox = await input.getSandboxRecord(input.worker.id)
    if (await startStaleStoppedRecycle({
      worker: input.worker,
      sandboxExists: Boolean(sandbox),
      inspectSandbox: input.inspectSandbox,
      startWake: input.startWake,
      store: input.store,
    })) {
      return { status: "waking", url: null }
    }

    input.startWake(input.worker.id)
    return { status: "waking", url: null }
  }

  const sandbox = await input.getSandboxRecord(input.worker.id)
  if (input.worker.status === "provisioning" && sandbox) {
    return { status: "waking", url: null }
  }

  if (!sandbox) {
    if (input.worker.status === "healthy") {
      await input.store.markHealthyWorkerFailed(input.worker.id)
      await startFailedCloudHeal(input)
      return { status: "waking", url: null }
    }

    return { status: "provisioning", url: null }
  }

  if (await startStaleStoppedRecycle({
    worker: input.worker,
    sandboxExists: true,
    inspectSandbox: input.inspectSandbox,
    startWake: input.startWake,
    store: input.store,
  })) {
    return { status: "waking", url: null }
  }

  if (sandbox.signed_preview_url_expires_at.getTime() > input.now()) {
    const ready = await readyFromSignedPreview({
      workerId: input.worker.id,
      signedPreviewUrl: sandbox.signed_preview_url,
      probeSignedPreview: input.probeSignedPreview,
      now: input.now,
    })
    if (ready) {
      return ready
    }
  }

  const refreshedReady = await refreshAndProbeSignedPreview({
    workerId: input.worker.id,
    refreshSignedPreview: input.refreshSignedPreview,
    probeSignedPreview: input.probeSignedPreview,
    now: input.now,
  })
  if (refreshedReady) {
    return refreshedReady
  }

  return recoverUnhealthyCloudSandbox(input)
}

async function resolveCloudInstanceForMember(input: {
  payload: NonNullable<OrgRouteVariables["organizationContext"]>
  user: CloudRouteUser
  continueProvisioning: typeof continueCloudProvisioning
  refreshSignedPreview: typeof refreshDaytonaSignedPreview
  store: CloudWorkerStore
  ensureWorker: EnsureCloudWorker
  getSandboxRecord: GetSandboxRecord
  inspectSandbox: InspectSandbox
  probeSignedPreview: ProbeSignedPreview
  startWake: (workerId: CloudWorker["id"]) => void
  now: () => number
}) {
  const worker = await input.ensureWorker({
    orgId: input.payload.organization.id,
    createdByUserId: input.user.id,
    name: cloudWorkerName(input.payload, input.user),
    continueProvisioning: input.continueProvisioning,
    store: input.store,
  })
  const instance = await resolveCloudInstance({
    worker,
    orgId: input.payload.organization.id,
    continueProvisioning: input.continueProvisioning,
    refreshSignedPreview: input.refreshSignedPreview,
    getSandboxRecord: input.getSandboxRecord,
    inspectSandbox: input.inspectSandbox,
    probeSignedPreview: input.probeSignedPreview,
    startWake: input.startWake,
    store: input.store,
    now: input.now,
  })

  return { worker, instance }
}

async function requestCloudInstanceUpdate(input: {
  worker: CloudWorker | null
  getSandboxRecord: GetSandboxRecord
  inspectSandbox: InspectSandbox
  flushWorkerCheckpoint: FlushWorkerCheckpoint
  stopCloudWorker: StopCloudWorker
}): Promise<CloudInstanceUpdateResponse> {
  if (!input.worker) {
    return { ok: true, status: "update_requested" }
  }

  if (!workerNeedsUserRequestedUpdate(input.worker)) {
    return { ok: false, error: "already_current" }
  }

  const sandbox = await input.getSandboxRecord(input.worker.id)
  if (!sandbox) {
    return { ok: true, status: "update_requested" }
  }

  let inspection: CloudSandboxInspection = null
  try {
    inspection = await input.inspectSandbox(input.worker.id)
  } catch (error) {
    logger.warn("cloud update failed to inspect sandbox", { worker_id: input.worker.id, error })
    return { ok: false, error: "flush_failed" }
  }

  const state = inspection?.state ?? null
  if (isStoppedSandboxState(state) || !isRunningSandboxState(state)) {
    return { ok: true, status: "update_requested" }
  }

  const flushed = await input.flushWorkerCheckpoint(input.worker.id).catch((error) => {
    logger.warn("cloud update checkpoint flush failed", { worker_id: input.worker?.id, error })
    return false
  })
  if (!flushed) {
    return { ok: false, error: "flush_failed" }
  }

  await input.stopCloudWorker(input.worker.id)
  return { ok: true, status: "update_requested" }
}

async function resolveCloudInstanceForGateway(input: {
  payload: NonNullable<OrgRouteVariables["organizationContext"]>
  user: CloudRouteUser
  continueProvisioning: typeof continueCloudProvisioning
  refreshSignedPreview: typeof refreshDaytonaSignedPreview
  store: CloudWorkerStore
  ensureWorker: EnsureCloudWorker
  getSandboxRecord: GetSandboxRecord
  inspectSandbox: InspectSandbox
  probeSignedPreview: ProbeSignedPreview
  startWake: (workerId: CloudWorker["id"]) => void
  materializeProviders: typeof materializeCloudWorkerProviders
  now: () => number
}): Promise<CloudGatewayInstanceResponse> {
  const resolved = await resolveCloudInstanceForMember(input)
  if (resolved.instance.status !== "ready") {
    return { status: resolved.instance.status, url: null, clientToken: null, hostToken: null }
  }

  const tokens = await input.store.getActiveTokens(resolved.worker.id)
  const clientToken = tokenByScope(tokens, "client")
  const hostToken = tokenByScope(tokens, "host")
  if (!resolved.instance.url || !clientToken || !hostToken) {
    logger.error("cloud gateway ready instance missing gateway token", { worker_id: resolved.worker.id })
    return { status: "failed", url: null, clientToken: null, hostToken: null }
  }

  let providerSync: CloudGatewayInstanceResponse["providerSync"] | null = null
  try {
    const result = await input.materializeProviders({
      organizationId: input.payload.organization.id,
      workerId: resolved.worker.id,
      instanceUrl: resolved.instance.url,
      hostToken,
      clientToken,
    })
    if (!result.ok) {
      providerSync = result.status === "unsupported"
        ? { status: "degraded", reason: "unsupported" }
        : { status: "degraded" }
    }
  } catch (error) {
    providerSync = { status: "degraded" }
    logger.warn("cloud gateway provider materialization warning", {
      worker_id: resolved.worker.id,
      message: error instanceof Error ? error.message : "provider_materialization_failed",
    })
  }

  return {
    status: "ready",
    url: resolved.instance.url,
    clientToken,
    hostToken,
    ...(providerSync ? { providerSync } : {}),
  }
}

export function registerCloudRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  options: CloudRouteOptions = {},
) {
  const orgMemberRouteMiddleware = options.memberRoute ?? orgMemberRoute()
  const materializeProviders = options.materializeProviders ?? materializeCloudWorkerProviders
  const continueProvisioning: typeof continueCloudProvisioning = options.continueProvisioning
    ?? ((input, continueOptions = {}) => continueCloudProvisioning(input, { ...continueOptions, materializeProviders }))
  const refreshSignedPreview = options.refreshSignedPreview ?? refreshDaytonaSignedPreview
  const store = options.cloudWorkerStore ?? databaseCloudWorkerStore
  const ensureWorker = options.ensureCloudWorker ?? ensureCloudWorker
  const getSandboxRecord = options.getSandboxRecord ?? getDaytonaSandboxRecord
  const inspectSandbox = options.inspectSandbox ?? inspectDaytonaSandbox
  const signedPreviewProbe = options.probeSignedPreview ?? probeSignedPreview
  const wakeCloudWorker = options.wakeCloudWorker ?? defaultWakeCloudWorker
  const flushWorkerCheckpoint = options.flushWorkerCheckpoint ?? flushWorkerCheckpointOnDaytona
  const stopCloudWorker = options.stopCloudWorker ?? stopWorkerOnDaytona
  const now = options.now ?? Date.now
  const gatewayKey = options.gatewayKey !== undefined ? options.gatewayKey : env.gatewayKey
  const wakingWorkers = new Set<CloudWorker["id"]>()

  function startWake(workerId: CloudWorker["id"]) {
    if (wakingWorkers.has(workerId)) {
      return
    }

    wakingWorkers.add(workerId)
    void wakeCloudWorker(workerId)
      .catch(() => undefined)
      .finally(() => {
        wakingWorkers.delete(workerId)
      })
  }

  app.get(
    "/v1/cloud/instance",
    describeRoute({
      tags: ["Cloud"],
      summary: "Get the active organization's Cloud instance",
      description: "Starts the active organization's OpenWork Cloud browser instance when needed and returns its browser URL once ready.",
      responses: {
        200: jsonResponse("Cloud instance status returned successfully.", cloudInstanceResponseSchema),
        401: jsonResponse("The caller must be signed in to open Cloud.", unauthorizedSchema),
        404: jsonResponse("Cloud is not available for this organization.", notFoundSchema),
      },
    }),
    orgMemberRouteMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      if (!cloudAvailable(payload, options)) {
        return c.json(cloudNotFound(), 404)
      }

      const user = c.get("user")
      if (!hasCloudUserId(user)) {
        return c.json({ error: "unauthorized" }, 401)
      }

      const resolved = await resolveCloudInstanceForMember({
        payload,
        user,
        continueProvisioning,
        refreshSignedPreview,
        store,
        ensureWorker,
        getSandboxRecord,
        inspectSandbox,
        probeSignedPreview: signedPreviewProbe,
        startWake,
        now,
      })

      const sandbox = await getSandboxRecord(resolved.worker.id)
      return c.json(memberCloudInstanceResponse(resolved.worker, resolved.instance, sandbox))
    },
  )

  app.post(
    "/v1/cloud/instance/update",
    describeRoute({
      tags: ["Cloud"],
      summary: "Request an update for the active organization's Cloud instance",
      description: "Flushes a running Cloud workspace checkpoint and stops the sandbox so the next resolve can recycle it onto the latest snapshot.",
      responses: {
        200: jsonResponse("Cloud instance update request handled.", cloudInstanceUpdateResponseSchema),
        401: jsonResponse("The caller must be signed in to update Cloud.", unauthorizedSchema),
        404: jsonResponse("Cloud is not available for this organization.", notFoundSchema),
      },
    }),
    orgMemberRouteMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      if (!cloudAvailable(payload, options)) {
        return c.json(cloudNotFound(), 404)
      }

      const user = c.get("user")
      if (!hasCloudUserId(user)) {
        return c.json({ error: "unauthorized" }, 401)
      }

      const worker = await getCloudWorker(payload.organization.id, user.id, store)
      const result = await requestCloudInstanceUpdate({
        worker,
        getSandboxRecord,
        inspectSandbox,
        flushWorkerCheckpoint,
        stopCloudWorker,
      })

      return c.json(result)
    },
  )

  app.get(
    "/v1/cloud/gateway/resolve",
    describeRoute({
      tags: ["Cloud"],
      summary: "Resolve the caller's Cloud instance for the browser gateway",
      description: "Starts or wakes the caller's own OpenWork Cloud browser instance when needed and returns the collaborator token only to the trusted gateway.",
      responses: {
        200: jsonResponse("Cloud instance status returned successfully for the gateway.", cloudGatewayInstanceResponseSchema),
        401: jsonResponse("The caller must be signed in to open Cloud.", unauthorizedSchema),
        404: jsonResponse("Cloud is not available for this organization or gateway.", notFoundSchema),
      },
    }),
    async (c, next) => {
      if (!gatewaySecretMatches(c.req.header(gatewayKeyHeader), gatewayKey)) {
        return c.json(cloudNotFound(), 404)
      }

      await next()
    },
    orgMemberRouteMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      if (!cloudAvailable(payload, options)) {
        return c.json(cloudNotFound(), 404)
      }

      const user = c.get("user")
      if (!hasCloudUserId(user)) {
        return c.json({ error: "unauthorized" }, 401)
      }

      const instance = await resolveCloudInstanceForGateway({
        payload,
        user,
        continueProvisioning,
        refreshSignedPreview,
        store,
        ensureWorker,
        getSandboxRecord,
        inspectSandbox,
        probeSignedPreview: signedPreviewProbe,
        startWake,
        materializeProviders,
        now,
      })

      return c.json(instance)
    },
  )
}
