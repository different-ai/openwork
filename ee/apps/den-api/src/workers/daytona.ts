import { Daytona, type Sandbox } from "@daytonaio/sdk"
import { eq } from "@openwork-ee/den-db/drizzle"
import { DaytonaSandboxTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const maxSignedPreviewExpirySeconds = 60 * 60 * 24
const signedPreviewRefreshLeadMs = 5 * 60 * 1000

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

function workerHint(workerId: WorkerId) {
  return workerId.replace(/-/g, "").slice(0, 12)
}

function sandboxLabels(workerId: WorkerId) {
  return {
    "openwork.den.provider": "daytona",
    "openwork.den.worker-id": workerId,
  }
}

function sandboxName(input: ProvisionInput) {
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
    "if ! command -v openwork >/dev/null 2>&1; then echo 'openwork binary missing from Daytona runtime image; rebuild and republish the Daytona snapshot' >&2; exit 1; fi",
    "if ! command -v opencode >/dev/null 2>&1; then echo 'opencode binary missing from Daytona runtime image; rebuild and republish the Daytona snapshot' >&2; exit 1; fi",
  ].join("; ")
  const openworkServe = [
    "OPENWORK_DATA_DIR=",
    shellQuote(env.daytona.runtimeDataPath),
    " OPENWORK_SIDECAR_DIR=",
    shellQuote(env.daytona.sidecarDir),
    " OPENWORK_TOKEN=",
    shellQuote(input.clientToken),
    " OPENWORK_HOST_TOKEN=",
    shellQuote(input.hostToken),
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
    " openwork serve",
    ` --workspace ${shellQuote(env.daytona.runtimeWorkspacePath)}`,
    ` --remote-access`,
    ` --openwork-port ${env.daytona.openworkPort}`,
    ` --opencode-host 127.0.0.1`,
    ` --opencode-port ${env.daytona.opencodePort}`,
    ` --connect-host 127.0.0.1`,
    ` --cors '*'`,
    ` --approval manual`,
    ` --allow-external`,
    ` --opencode-source external`,
    ` --opencode-bin $(command -v opencode)`,
    ` --no-opencode-router`,
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
  echo "openwork serve failed (attempt $attempt, exit $status); retrying in 3s"
  sleep 3
done
exit 1
`.trim()

  return `sh -lc ${shellQuote(script)}`
}

async function waitForVolumeReady(daytona: Daytona, name: string, timeoutMs: number) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const volume = await daytona.volume.get(name)
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
      daytona,
      sharedVolumeName(),
      env.daytona.createTimeoutSeconds * 1000,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[provisioner] failed to resolve shared Daytona volume for ${workerId}: ${message}`)
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
    const message = error instanceof Error ? error.message : "unknown_error"
    console.warn(`[provisioner] failed to cleanup Daytona worker data for ${workerId}: ${message}`)
  } finally {
    if (cleanupSandbox) {
      await cleanupSandbox.delete(env.daytona.deleteTimeoutSeconds).catch((error) => {
        const message = error instanceof Error ? error.message : "unknown_error"
        console.warn(`[provisioner] failed to delete Daytona cleanup sandbox for ${workerId}: ${message}`)
      })
    }
  }
}

async function waitForHealth(url: string, timeoutMs: number, sandbox: Sandbox, sessionId: string, commandId: string) {
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

async function upsertDaytonaSandbox(input: {
  workerId: WorkerId
  sandboxId: string
  workspaceVolumeId: string
  dataVolumeId: string
  signedPreviewUrl: string
  signedPreviewUrlExpiresAt: Date
  region: string | null
}) {
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

export async function provisionWorkerOnDaytona(
  input: ProvisionInput,
): Promise<ProvisionedInstance> {
  assertDaytonaConfig()

  const daytona = createDaytonaClient()
  const labels = sandboxLabels(input.workerId)
  const sharedVolumeNameValue = sharedVolumeName()
  await daytona.volume.get(sharedVolumeNameValue, true)
  const sharedVolume = await waitForVolumeReady(
    daytona,
    sharedVolumeNameValue,
    env.daytona.createTimeoutSeconds * 1000,
  )
  let sandbox: Awaited<ReturnType<typeof daytona.create>> | null = null

  try {
    sandbox = env.daytona.snapshot
      ? await daytona.create(
          {
            name: sandboxName(input),
            snapshot: env.daytona.snapshot,
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
          },
          { timeout: env.daytona.createTimeoutSeconds },
        )
      : await daytona.create(
          {
            name: sandboxName(input),
            image: env.daytona.image,
            autoStopInterval: env.daytona.autoStopInterval,
            autoArchiveInterval: env.daytona.autoArchiveInterval,
            autoDeleteInterval: env.daytona.autoDeleteInterval,
            public: env.daytona.public,
            labels,
            envVars: {
              DEN_WORKER_ID: input.workerId,
              DEN_RUNTIME_PROVIDER: "daytona",
            },
            resources: {
              cpu: env.daytona.resources.cpu,
              memory: env.daytona.resources.memory,
              disk: env.daytona.resources.disk,
            },
            volumes: sharedVolumeMounts(input.workerId, sharedVolume.id),
          },
          { timeout: env.daytona.createTimeoutSeconds },
        )

    const sessionId = `openwork-${workerHint(input.workerId)}`
    await sandbox.process.createSession(sessionId)
    const command = await sandbox.process.executeSessionCommand(
      sessionId,
      {
        command: buildOpenWorkStartCommand(input),
        runAsync: true,
      },
      0,
    )

    const expiresInSeconds = normalizedSignedPreviewExpirySeconds()
    const preview = await sandbox.getSignedPreviewUrl(env.daytona.openworkPort, expiresInSeconds)
    await waitForHealth(preview.url, env.daytona.healthcheckTimeoutMs, sandbox, sessionId, command.cmdId)
    await upsertDaytonaSandbox({
      workerId: input.workerId,
      sandboxId: sandbox.id,
      workspaceVolumeId: sharedVolume.id,
      dataVolumeId: sharedVolume.id,
      signedPreviewUrl: preview.url,
      signedPreviewUrlExpiresAt: signedPreviewRefreshAt(expiresInSeconds),
      region: sandbox.target ?? null,
    })

    return {
      provider: "daytona",
      url: workerProxyUrl(input.workerId),
      status: "healthy",
      region: sandbox.target,
    }
  } catch (error) {
    if (sandbox) {
      await sandbox.delete(env.daytona.deleteTimeoutSeconds).catch(() => {})
    }
    throw error
  }
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
      const message = error instanceof Error ? error.message : "unknown_error"
      console.warn(`[provisioner] failed to delete Daytona sandbox ${record.sandbox_id}: ${message}`)
    }

    await cleanupWorkerDataOnDaytona(daytona, workerId)

    return
  }

  const sandboxes = await daytona.list(sandboxLabels(workerId), 1, 20)

  for (const sandbox of sandboxes.items) {
    await sandbox.delete(env.daytona.deleteTimeoutSeconds).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown_error"
      console.warn(`[provisioner] failed to delete Daytona sandbox ${sandbox.id}: ${message}`)
    })
  }

  await cleanupWorkerDataOnDaytona(daytona, workerId)
}
