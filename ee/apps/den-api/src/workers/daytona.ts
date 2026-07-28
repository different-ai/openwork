import { Daytona, DaytonaConflictError, type CreateSandboxFromImageParams, type CreateSandboxFromSnapshotParams, type Sandbox } from "@daytonaio/sdk"
import { eq } from "@openwork-ee/den-db/drizzle"
import { DaytonaSandboxTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"

type WorkerId = typeof DaytonaSandboxTable.$inferSelect.worker_id

type ProvisionInput = {
  workerId: WorkerId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}

type ProvisionedInstance = {
  provider: string
  url: string
  status: "provisioning" | "healthy"
  region?: string
}

export class DaytonaSandboxMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DaytonaSandboxMissingError"
  }
}

export type StopWorkerOnDaytonaResult =
  | { status: "no_sandbox" }
  | { status: "stopped" }

type DaytonaCreateParams = CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams
type DaytonaVolumeRuntime = {
  id: string
  state?: string | null
}
type DaytonaSessionCommand = {
  exitCode?: number | null
}
type DaytonaSessionCommandLogs = {
  stdout?: string | null
  stderr?: string | null
}
type DaytonaSessionCommandResult = {
  cmdId: string
}
export type DaytonaSandboxRuntime = {
  id: string
  state: string | null
  target: string | null
  refreshData: () => Promise<unknown>
  start: (timeout?: number) => Promise<unknown>
  delete: (timeout?: number) => Promise<unknown>
  getSignedPreviewUrl: (port: number, expiresInSeconds?: number) => Promise<{ url: string }>
  process: {
    createSession: (sessionId: string) => Promise<unknown>
    executeSessionCommand: (sessionId: string, request: { command: string; runAsync: boolean }, timeout?: number) => Promise<DaytonaSessionCommandResult>
    getSessionCommand: (sessionId: string, commandId: string) => Promise<DaytonaSessionCommand>
    getSessionCommandLogs: (sessionId: string, commandId: string) => Promise<DaytonaSessionCommandLogs>
  }
}
type UpsertDaytonaSandboxInput = {
  workerId: WorkerId
  sandboxId: string
  workspaceVolumeId: string
  dataVolumeId: string
  signedPreviewUrl: string
  signedPreviewUrlExpiresAt: Date
  region: string | null
}
export type DaytonaProvisioningRuntime = {
  getVolume: (name: string, create?: boolean) => Promise<DaytonaVolumeRuntime>
  getSandbox: (sandboxIdOrName: string) => Promise<DaytonaSandboxRuntime>
  createSandbox: (params: DaytonaCreateParams) => Promise<DaytonaSandboxRuntime>
  upsertSandbox: (input: UpsertDaytonaSandboxInput) => Promise<void>
  waitForHealth: typeof waitForHealth
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const maxSignedPreviewExpirySeconds = 60 * 60 * 24
const signedPreviewRefreshLeadMs = 5 * 60 * 1000
const logger = appLogger.child({ component: "daytona_provisioner" })

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function createDaytonaClient() {
  return new Daytona({
    apiKey: env.daytona.apiKey,
    apiUrl: env.daytona.apiUrl,
    ...(env.daytona.target ? { target: env.daytona.target } : {}),
  })
}

async function listDaytonaSandboxIdsByLabels(labels: Record<string, string>) {
  const daytona = createDaytonaClient()
  const ids: string[] = []
  let page = 1
  const limit = 100

  while (true) {
    const sandboxes = await daytona.list(labels, page, limit)
    for (const sandbox of sandboxes.items) {
      ids.push(sandbox.id)
    }

    if (sandboxes.items.length < limit) {
      break
    }

    page += 1
  }

  return ids
}

function normalizedSignedPreviewExpirySeconds() {
  return Math.max(
    1,
    Math.min(env.daytona.signedPreviewExpiresSeconds, maxSignedPreviewExpirySeconds),
  )
}

function signedPreviewRefreshAt(expiresInSeconds: number) {
  return new Date(
    Date.now() + Math.max(0, expiresInSeconds * 1000 - signedPreviewRefreshLeadMs),
  )
}

function workerProxyUrl(workerId: WorkerId) {
  return `${env.daytona.workerProxyBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(workerId)}`
}

function workerActivityHeartbeatUrl(workerId: WorkerId) {
  const base = env.workerActivityBaseUrl.replace(/\/+$/, "")
  return `${base}/v1/workers/${encodeURIComponent(workerId)}/activity-heartbeat`
}

function assertDaytonaConfig() {
  if (!env.daytona.apiKey) {
    throw new Error("DAYTONA_API_KEY is required for daytona provisioner")
  }
}

function isDaytonaNotFoundError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes("not found") || message.includes("404")
}

export function isDaytonaSandboxMissingError(error: unknown) {
  return error instanceof DaytonaSandboxMissingError
    || (error instanceof Error && error.name === "DaytonaSandboxMissingError")
}

export function isDaytonaConflictError(error: unknown) {
  return error instanceof DaytonaConflictError
    || (error instanceof Error && error.name === "DaytonaConflictError")
}

function workerHint(workerId: WorkerId) {
  return workerId.replace(/-/g, "").slice(0, 12)
}

function sandboxLabels(workerId: WorkerId) {
  return {
    "openwork.den.provider": "daytona",
    "openwork.den.worker-id": workerId,
  }
}

export function daytonaSandboxName(input: ProvisionInput) {
  return slug(
    `${env.daytona.sandboxNamePrefix}-${input.name}-${workerHint(input.workerId)}`,
  ).slice(0, 63)
}

function sharedVolumeName() {
  return slug(env.daytona.sharedVolumeName).slice(0, 63)
}

function workerVolumeRootSubpath(workerId: WorkerId) {
  return `workers/${workerId}`
}

function workspaceVolumeSubpath(workerId: WorkerId) {
  return `${workerVolumeRootSubpath(workerId)}/workspace`
}

function dataVolumeSubpath(workerId: WorkerId) {
  return `${workerVolumeRootSubpath(workerId)}/data`
}

function sharedVolumeMounts(workerId: WorkerId, volumeId: string) {
  return [
    {
      volumeId,
      mountPath: env.daytona.workspaceMountPath,
      subpath: workspaceVolumeSubpath(workerId),
    },
    {
      volumeId,
      mountPath: env.daytona.dataMountPath,
      subpath: dataVolumeSubpath(workerId),
    },
  ]
}

function buildOpenWorkStartCommand(input: ProvisionInput) {
  const verifyRuntimeStep = [
    "if ! command -v openwork-server >/dev/null 2>&1; then echo 'openwork-server binary missing from Daytona runtime image; rebuild and republish the Daytona snapshot' >&2; exit 1; fi",
    "if ! command -v opencode >/dev/null 2>&1; then echo 'opencode binary missing from Daytona runtime image; rebuild and republish the Daytona snapshot' >&2; exit 1; fi",
  ].join("; ")
  const openworkServe = [
    "OPENWORK_DATA_DIR=",
    shellQuote(env.daytona.runtimeDataPath),
    " OPENWORK_SERVER_CONFIG=",
    shellQuote(`${env.daytona.runtimeDataPath}/server.json`),
    " OPENWORK_TOKEN=",
    shellQuote(input.clientToken),
    " OPENWORK_HOST_TOKEN=",
    shellQuote(input.hostToken),
    " OPENWORK_MANAGE_OPENCODE=",
    shellQuote("1"),
    " OPENWORK_OPENCODE_BIN=",
    shellQuote("/usr/local/bin/opencode"),
    " OPENWORK_WEB_ROOT=",
    shellQuote("/opt/openwork/web"),
    // The instance still serves its own SPA copy for direct/debug access, but
    // without a bootstrap token that path is intentionally inert; the gateway
    // is the supported entry.
    " OPENWORK_WEB_BOOTSTRAP_TOKEN=",
    shellQuote("0"),
    " OPENWORK_EXTENSIONS_PLUGIN_DIR=",
    shellQuote("/opt/openwork/opencode-plugins"),
    " DEN_RUNTIME_PROVIDER=",
    shellQuote("daytona"),
    " DEN_WORKER_ID=",
    shellQuote(input.workerId),
    " DEN_ACTIVITY_HEARTBEAT_ENABLED=",
    shellQuote("1"),
    " DEN_ACTIVITY_HEARTBEAT_URL=",
    shellQuote(workerActivityHeartbeatUrl(input.workerId)),
    " DEN_ACTIVITY_HEARTBEAT_TOKEN=",
    shellQuote(input.activityToken),
    " openwork-server",
    ` --workspace ${shellQuote(env.daytona.runtimeWorkspacePath)}`,
    ` --host 0.0.0.0`,
    ` --port ${shellQuote(String(env.daytona.openworkPort))}`,
    ` --cors '*'`,
    ` --approval manual`,
    ` --verbose`,
  ].join("")

  const script = `
set -u
mkdir -p ${shellQuote(env.daytona.workspaceMountPath)} ${shellQuote(env.daytona.dataMountPath)} ${shellQuote(env.daytona.runtimeWorkspacePath)} ${shellQuote(env.daytona.runtimeDataPath)} ${shellQuote(env.daytona.sidecarDir)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes`)}
ln -sfn ${shellQuote(env.daytona.workspaceMountPath)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes/workspace`) }
ln -sfn ${shellQuote(env.daytona.dataMountPath)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes/data`) }
${verifyRuntimeStep}
attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  if ${openworkServe}; then
    exit 0
  fi
  status=$?
  echo "openwork-server failed (attempt $attempt, exit $status); rebuild and republish the Daytona snapshot if this persists; retrying in 3s"
  sleep 3
done
exit 1
`.trim()

  return `sh -lc ${shellQuote(script)}`
}

async function waitForVolumeReady(getVolume: DaytonaProvisioningRuntime["getVolume"], name: string, timeoutMs: number) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const volume = await getVolume(name)
    if (volume.state === "ready") {
      return volume
    }
    await sleep(env.daytona.pollIntervalMs)
  }

  throw new Error(`Timed out waiting for Daytona volume ${name} to become ready`)
}

function buildVolumeCleanupCommand(workerId: WorkerId) {
  return [
    "node -e",
    shellQuote(
      [
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        'for (const dir of process.argv.slice(1)) {',
        '  fs.mkdirSync(dir, { recursive: true })',
        '  for (const entry of fs.readdirSync(dir)) {',
        '    fs.rmSync(path.join(dir, entry), { recursive: true, force: true })',
        '  }',
        '}',
      ].join("; "),
    ),
    shellQuote(env.daytona.workspaceMountPath),
    shellQuote(env.daytona.dataMountPath),
  ].join(" ")
}

async function cleanupWorkerDataOnDaytona(daytona: Daytona, workerId: WorkerId) {
  let sharedVolume

  try {
    sharedVolume = await waitForVolumeReady(
      (name, create) => daytona.volume.get(name, create),
      sharedVolumeName(),
      env.daytona.createTimeoutSeconds * 1000,
    )
  } catch (error) {
    logger.warn("failed to resolve shared Daytona volume", { worker_id: workerId, error })
    return
  }

  let cleanupSandbox: Awaited<ReturnType<typeof daytona.create>> | null = null

  try {
    cleanupSandbox = await daytona.create(
      {
        name: slug(`den-daytona-cleanup-${workerHint(workerId)}`).slice(0, 63),
        image: env.daytona.image,
        public: false,
        autoStopInterval: 0,
        autoArchiveInterval: 0,
        autoDeleteInterval: 0,
        ephemeral: true,
        envVars: {
          DEN_RUNTIME_PROVIDER: "daytona-cleanup",
          DEN_WORKER_ID: workerId,
        },
        resources: {
          cpu: 1,
          memory: 1,
          disk: 4,
        },
        volumes: sharedVolumeMounts(workerId, sharedVolume.id),
      },
      { timeout: env.daytona.createTimeoutSeconds },
    )

    const result = await cleanupSandbox.process.executeCommand(
      buildVolumeCleanupCommand(workerId),
      undefined,
      undefined,
      env.daytona.deleteTimeoutSeconds,
    )

    if (result.exitCode !== 0) {
      throw new Error(result.result?.trim() || `cleanup command exited with ${result.exitCode}`)
    }
  } catch (error) {
    logger.warn("failed to cleanup Daytona worker data", { worker_id: workerId, error })
  } finally {
    if (cleanupSandbox) {
      await cleanupSandbox.delete(env.daytona.deleteTimeoutSeconds).catch((error) => {
        logger.warn("failed to delete Daytona cleanup sandbox", { worker_id: workerId, error })
      })
    }
  }
}

async function waitForHealth(url: string, timeoutMs: number, sandbox: DaytonaSandboxRuntime, sessionId: string, commandId: string) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`, { method: "GET" })
      if (response.ok) {
        return
      }
    } catch {
      // ignore transient startup failures
    }

    try {
      const command = await sandbox.process.getSessionCommand(sessionId, commandId)
      if (typeof command.exitCode === "number" && command.exitCode !== 0) {
        const logs = await sandbox.process.getSessionCommandLogs(sessionId, commandId)
        throw new Error(
          [
            `openwork session exited with ${command.exitCode}`,
            logs.stdout?.trim() ? `stdout:\n${logs.stdout.trim().slice(-4000)}` : "",
            logs.stderr?.trim() ? `stderr:\n${logs.stderr.trim().slice(-4000)}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("openwork session exited")) {
        throw error
      }
    }

    await sleep(env.daytona.pollIntervalMs)
  }

  const logs = await sandbox.process.getSessionCommandLogs(sessionId, commandId).catch(
    () => null,
  )
  throw new Error(
    [
      `Timed out waiting for Daytona worker health at ${url.replace(/\/$/, "")}/health`,
      logs?.stdout?.trim() ? `stdout:\n${logs.stdout.trim().slice(-4000)}` : "",
      logs?.stderr?.trim() ? `stderr:\n${logs.stderr.trim().slice(-4000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  )
}

async function upsertDaytonaSandbox(input: UpsertDaytonaSandboxInput) {
  const existing = await db
    .select({ id: DaytonaSandboxTable.id })
    .from(DaytonaSandboxTable)
    .where(eq(DaytonaSandboxTable.worker_id, input.workerId))
    .limit(1)

  if (existing.length > 0) {
    await db
      .update(DaytonaSandboxTable)
      .set({
        sandbox_id: input.sandboxId,
        workspace_volume_id: input.workspaceVolumeId,
        data_volume_id: input.dataVolumeId,
        signed_preview_url: input.signedPreviewUrl,
        signed_preview_url_expires_at: input.signedPreviewUrlExpiresAt,
        region: input.region,
      })
      .where(eq(DaytonaSandboxTable.worker_id, input.workerId))
    return
  }

  await db.insert(DaytonaSandboxTable).values({
    id: createDenTypeId("daytonaSandbox"),
    worker_id: input.workerId,
    sandbox_id: input.sandboxId,
    workspace_volume_id: input.workspaceVolumeId,
    data_volume_id: input.dataVolumeId,
    signed_preview_url: input.signedPreviewUrl,
    signed_preview_url_expires_at: input.signedPreviewUrlExpiresAt,
    region: input.region,
  })
}

export async function getDaytonaSandboxRecord(workerId: WorkerId) {
  const rows = await db
    .select()
    .from(DaytonaSandboxTable)
    .where(eq(DaytonaSandboxTable.worker_id, workerId))
    .limit(1)

  return rows[0] ?? null
}

export async function inspectDaytonaSandbox(workerId: WorkerId) {
  assertDaytonaConfig()

  const record = await getDaytonaSandboxRecord(workerId)
  if (!record) {
    return null
  }

  const daytona = createDaytonaClient()
  try {
    const sandbox = await daytona.get(record.sandbox_id)
    await sandbox.refreshData()
    return { state: sandbox.state ?? null }
  } catch (error) {
    if (isDaytonaNotFoundError(error)) {
      return null
    }

    throw error
  }
}

export async function refreshDaytonaSignedPreview(workerId: WorkerId) {
  assertDaytonaConfig()

  const record = await getDaytonaSandboxRecord(workerId)
  if (!record) {
    return null
  }

  const daytona = createDaytonaClient()
  const sandbox = await daytona.get(record.sandbox_id)
  await sandbox.refreshData()

  const expiresInSeconds = normalizedSignedPreviewExpirySeconds()
  const preview = await sandbox.getSignedPreviewUrl(env.daytona.openworkPort, expiresInSeconds)
  const expiresAt = signedPreviewRefreshAt(expiresInSeconds)

  await db
    .update(DaytonaSandboxTable)
    .set({
      signed_preview_url: preview.url,
      signed_preview_url_expires_at: expiresAt,
      region: sandbox.target,
    })
    .where(eq(DaytonaSandboxTable.worker_id, workerId))

  return {
    ...record,
    signed_preview_url: preview.url,
    signed_preview_url_expires_at: expiresAt,
    region: sandbox.target,
  }
}

export async function getDaytonaSignedPreviewForProxy(workerId: WorkerId) {
  const record = await getDaytonaSandboxRecord(workerId)
  if (!record) {
    return null
  }

  if (record.signed_preview_url_expires_at.getTime() > Date.now()) {
    return record.signed_preview_url
  }

  const refreshed = await refreshDaytonaSignedPreview(workerId)
  return refreshed?.signed_preview_url ?? null
}

function toDaytonaSandboxRuntime(sandbox: Sandbox): DaytonaSandboxRuntime {
  return {
    get id() {
      return sandbox.id
    },
    get state() {
      return sandbox.state ?? null
    },
    get target() {
      return sandbox.target ?? null
    },
    refreshData: () => sandbox.refreshData(),
    start: (timeout) => sandbox.start(timeout),
    delete: (timeout) => sandbox.delete(timeout),
    getSignedPreviewUrl: (port, expiresInSeconds) => sandbox.getSignedPreviewUrl(port, expiresInSeconds),
    process: {
      createSession: (sessionId) => sandbox.process.createSession(sessionId),
      executeSessionCommand: (sessionId, request, timeout) => sandbox.process.executeSessionCommand(sessionId, request, timeout),
      getSessionCommand: (sessionId, commandId) => sandbox.process.getSessionCommand(sessionId, commandId),
      getSessionCommandLogs: (sessionId, commandId) => sandbox.process.getSessionCommandLogs(sessionId, commandId),
    },
  }
}

function createDaytonaProvisioningRuntime(daytona: Daytona): DaytonaProvisioningRuntime {
  return {
    getVolume: (name, create) => daytona.volume.get(name, create),
    getSandbox: async (sandboxIdOrName) => toDaytonaSandboxRuntime(await daytona.get(sandboxIdOrName)),
    createSandbox: async (params) => {
      if ("image" in params) {
        return toDaytonaSandboxRuntime(await daytona.create(params, { timeout: env.daytona.createTimeoutSeconds }))
      }

      return toDaytonaSandboxRuntime(await daytona.create(params, { timeout: env.daytona.createTimeoutSeconds }))
    },
    upsertSandbox: upsertDaytonaSandbox,
    waitForHealth,
  }
}

async function getSharedDaytonaVolume(runtime: DaytonaProvisioningRuntime) {
  const sharedVolumeNameValue = sharedVolumeName()
  await runtime.getVolume(sharedVolumeNameValue, true)
  return waitForVolumeReady(
    runtime.getVolume,
    sharedVolumeNameValue,
    env.daytona.createTimeoutSeconds * 1000,
  )
}

function buildDaytonaCreateParams(input: ProvisionInput, name: string, sharedVolume: DaytonaVolumeRuntime): DaytonaCreateParams {
  const labels = sandboxLabels(input.workerId)
  const base = {
    name,
    autoStopInterval: env.daytona.autoStopInterval,
    autoArchiveInterval: env.daytona.autoArchiveInterval,
    autoDeleteInterval: env.daytona.autoDeleteInterval,
    public: env.daytona.public,
    labels,
    envVars: {
      DEN_WORKER_ID: input.workerId,
      DEN_RUNTIME_PROVIDER: "daytona",
    },
    volumes: sharedVolumeMounts(input.workerId, sharedVolume.id),
  }

  if (env.daytona.snapshot) {
    return {
      ...base,
      snapshot: env.daytona.snapshot,
    }
  }

  return {
    ...base,
    image: env.daytona.image,
    resources: {
      cpu: env.daytona.resources.cpu,
      memory: env.daytona.resources.memory,
      disk: env.daytona.resources.disk,
    },
  }
}

async function getSandboxByName(runtime: DaytonaProvisioningRuntime, name: string) {
  try {
    const sandbox = await runtime.getSandbox(name)
    await sandbox.refreshData()
    return sandbox
  } catch (error) {
    if (isDaytonaNotFoundError(error)) {
      return null
    }

    throw error
  }
}

async function startOpenWorkOnDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  sandbox: DaytonaSandboxRuntime
  sessionId: string
  workspaceVolumeId: string
  dataVolumeId: string
}): Promise<ProvisionedInstance> {
  await input.sandbox.process.createSession(input.sessionId)
  const command = await input.sandbox.process.executeSessionCommand(
    input.sessionId,
    {
      command: buildOpenWorkStartCommand(input.provisionInput),
      runAsync: true,
    },
    0,
  )

  const expiresInSeconds = normalizedSignedPreviewExpirySeconds()
  const preview = await input.sandbox.getSignedPreviewUrl(env.daytona.openworkPort, expiresInSeconds)
  await input.runtime.waitForHealth(preview.url, env.daytona.healthcheckTimeoutMs, input.sandbox, input.sessionId, command.cmdId)
  await input.runtime.upsertSandbox({
    workerId: input.provisionInput.workerId,
    sandboxId: input.sandbox.id,
    workspaceVolumeId: input.workspaceVolumeId,
    dataVolumeId: input.dataVolumeId,
    signedPreviewUrl: preview.url,
    signedPreviewUrlExpiresAt: signedPreviewRefreshAt(expiresInSeconds),
    region: input.sandbox.target,
  })

  return {
    provider: "daytona",
    url: workerProxyUrl(input.provisionInput.workerId),
    status: "healthy",
    region: input.sandbox.target ?? undefined,
  }
}

async function adoptDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  sandbox: DaytonaSandboxRuntime
  sharedVolume: DaytonaVolumeRuntime
}): Promise<ProvisionedInstance> {
  if (input.sandbox.state === "stopped") {
    await input.sandbox.start(env.daytona.createTimeoutSeconds)
  }

  return startOpenWorkOnDaytonaSandbox({
    provisionInput: input.provisionInput,
    runtime: input.runtime,
    sandbox: input.sandbox,
    sessionId: `openwork-wake-${workerHint(input.provisionInput.workerId)}-${Date.now()}`,
    workspaceVolumeId: input.sharedVolume.id,
    dataVolumeId: input.sharedVolume.id,
  })
}

export async function provisionWorkerOnDaytonaWithRuntime(
  input: ProvisionInput,
  runtime: DaytonaProvisioningRuntime,
): Promise<ProvisionedInstance> {
  const name = daytonaSandboxName(input)
  const sharedVolume = await getSharedDaytonaVolume(runtime)
  const existingSandbox = await getSandboxByName(runtime, name)
  if (existingSandbox) {
    return adoptDaytonaSandbox({ provisionInput: input, runtime, sandbox: existingSandbox, sharedVolume })
  }

  let createdSandbox: DaytonaSandboxRuntime | null = null
  try {
    createdSandbox = await runtime.createSandbox(buildDaytonaCreateParams(input, name, sharedVolume))
    return startOpenWorkOnDaytonaSandbox({
      provisionInput: input,
      runtime,
      sandbox: createdSandbox,
      sessionId: `openwork-${workerHint(input.workerId)}`,
      workspaceVolumeId: sharedVolume.id,
      dataVolumeId: sharedVolume.id,
    })
  } catch (error) {
    if (createdSandbox) {
      await createdSandbox.delete(env.daytona.deleteTimeoutSeconds).catch(() => undefined)
    }

    if (isDaytonaConflictError(error)) {
      const conflictSandbox = await getSandboxByName(runtime, name)
      if (conflictSandbox) {
        return adoptDaytonaSandbox({ provisionInput: input, runtime, sandbox: conflictSandbox, sharedVolume })
      }
    }

    throw error
  }
}

export async function provisionWorkerOnDaytona(
  input: ProvisionInput,
): Promise<ProvisionedInstance> {
  assertDaytonaConfig()

  const daytona = createDaytonaClient()
  return provisionWorkerOnDaytonaWithRuntime(input, createDaytonaProvisioningRuntime(daytona))
}

// This preserves customer data: deprovisionWorkerOnDaytona erases workers/<id>/,
// while stopWorkerOnDaytona must not delete the sandbox, cleanup data, or touch volumes.
export async function stopWorkerOnDaytona(workerId: WorkerId): Promise<StopWorkerOnDaytonaResult> {
  assertDaytonaConfig()

  const record = await getDaytonaSandboxRecord(workerId)
  if (!record) {
    return { status: "no_sandbox" }
  }

  const daytona = createDaytonaClient()
  const sandbox = await daytona.get(record.sandbox_id)
  if (sandbox.state === "stopped") {
    return { status: "stopped" }
  }

  await sandbox.stop(env.daytona.stopTimeoutSeconds ?? env.daytona.deleteTimeoutSeconds)

  return { status: "stopped" }
}

export async function wakeWorkerOnDaytona(
  input: ProvisionInput,
): Promise<ProvisionedInstance> {
  assertDaytonaConfig()

  const record = await getDaytonaSandboxRecord(input.workerId)
  if (!record) {
    throw new DaytonaSandboxMissingError(`Daytona sandbox record missing for worker ${input.workerId}`)
  }

  const daytona = createDaytonaClient()
  const runtime = createDaytonaProvisioningRuntime(daytona)
  let sandbox: DaytonaSandboxRuntime
  try {
    sandbox = await runtime.getSandbox(record.sandbox_id)
  } catch (error) {
    if (isDaytonaNotFoundError(error)) {
      throw new DaytonaSandboxMissingError(`Daytona sandbox ${record.sandbox_id} missing for worker ${input.workerId}`)
    }

    throw error
  }
  try {
    await sandbox.start(env.daytona.createTimeoutSeconds)
  } catch (error) {
    if (isDaytonaNotFoundError(error)) {
      throw new DaytonaSandboxMissingError(`Daytona sandbox ${record.sandbox_id} missing for worker ${input.workerId}`)
    }

    throw error
  }

  return startOpenWorkOnDaytonaSandbox({
    provisionInput: input,
    runtime,
    sandbox,
    sessionId: `openwork-wake-${workerHint(input.workerId)}-${Date.now()}`,
    workspaceVolumeId: record.workspace_volume_id,
    dataVolumeId: record.data_volume_id,
  })
}

export async function deprovisionWorkerOnDaytona(workerId: WorkerId) {
  assertDaytonaConfig()

  const daytona = createDaytonaClient()
  const record = await getDaytonaSandboxRecord(workerId)

  if (record) {
    try {
      const sandbox = await daytona.get(record.sandbox_id)
      await sandbox.delete(env.daytona.deleteTimeoutSeconds)
    } catch (error) {
      logger.warn("failed to delete Daytona sandbox", { worker_id: workerId, sandbox_id: record.sandbox_id, error })
    }

    await cleanupWorkerDataOnDaytona(daytona, workerId)

    return
  }

  const sandboxIds = await listDaytonaSandboxIdsByLabels(sandboxLabels(workerId))

  for (const sandboxId of sandboxIds) {
    await daytona
      .get(sandboxId)
      .then((sandbox) => sandbox.delete(env.daytona.deleteTimeoutSeconds))
      .catch((error) => {
        logger.warn("failed to delete Daytona sandbox", { worker_id: workerId, sandbox_id: sandboxId, error })
      })
  }

  await cleanupWorkerDataOnDaytona(daytona, workerId)
}
