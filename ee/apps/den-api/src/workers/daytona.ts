import { randomUUID } from "node:crypto"
import { Daytona, DaytonaConflictError, DaytonaNotFoundError, type CreateSandboxFromImageParams, type CreateSandboxFromSnapshotParams, type Sandbox } from "@daytonaio/sdk"
import { eq } from "@openwork-ee/den-db/drizzle"
import { DaytonaSandboxTable, WorkerTable } from "@openwork-ee/den-db/schema"
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
type SandboxNameInput = Pick<ProvisionInput, "workerId" | "name">

type ProvisionedInstance = {
  provider: string
  url: string
  status: "provisioning" | "healthy"
  region?: string
  imageVersion?: string | null
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
  stop: (timeout?: number) => Promise<unknown>
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
  checkpointExists: (input: { workerId: WorkerId; sharedVolume: DaytonaVolumeRuntime }) => Promise<boolean>
  verifyRestoreMarker: (sandbox: DaytonaSandboxRuntime) => Promise<boolean>
  waitForHealth: typeof waitForHealth
  now?: () => number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const maxSignedPreviewExpirySeconds = 60 * 60 * 24
const signedPreviewRefreshLeadMs = 5 * 60 * 1000
const wakeStartMaxAttempts = 3
const wakeStartRetryBackoffMs = 250
const wakeStartStateChangeTimeoutMs = 60_000
const healthRequestTimeoutMs = 5_000
const createConflictLookupMaxAttempts = 6
const createConflictLookupBackoffMs = 2_000
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

  for await (const sandbox of daytona.list({ labels, limit: 100 })) {
    ids.push(sandbox.id)
  }

  return ids
}

function normalizedSignedPreviewExpirySeconds() {
  return Math.max(
    1,
    Math.min(env.daytona.signedPreviewExpiresSeconds, maxSignedPreviewExpirySeconds),
  )
}

function signedPreviewRefreshAt(expiresInSeconds: number, issuedAtMs = Date.now()) {
  return new Date(
    issuedAtMs + Math.max(0, expiresInSeconds * 1000 - signedPreviewRefreshLeadMs),
  )
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

  if (error instanceof DaytonaNotFoundError || error.name === "DaytonaNotFoundError") {
    return true
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

export function daytonaSandboxName(input: SandboxNameInput) {
  return slug(
    `${env.daytona.sandboxNamePrefix}-${input.name}-${workerHint(input.workerId)}`,
  ).slice(0, 63)
}

function currentDaytonaImageVersion() {
  return env.daytona.snapshot ?? null
}

function snapshotShortVersion(snapshot: string) {
  return slug(snapshot).slice(0, 24) || "snapshot"
}

export function daytonaSandboxNameForSnapshot(input: SandboxNameInput, snapshot: string) {
  const shortVersion = snapshotShortVersion(snapshot)
  const base = daytonaSandboxName(input)
  const baseLength = Math.max(1, 63 - shortVersion.length - 1)
  return slug(`${base.slice(0, baseLength)}-${shortVersion}`).slice(0, 63)
}

export function currentDaytonaSandboxName(input: SandboxNameInput) {
  const snapshot = currentDaytonaImageVersion()
  return snapshot ? daytonaSandboxNameForSnapshot(input, snapshot) : daytonaSandboxName(input)
}

function daytonaSandboxLookupNames(input: ProvisionInput) {
  const names: string[] = []
  for (const name of [currentDaytonaSandboxName(input), daytonaSandboxName(input)]) {
    if (!names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

function recoveryDaytonaSandboxName(input: SandboxNameInput) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8)
  const base = currentDaytonaSandboxName(input)
  const baseLength = Math.max(1, 63 - suffix.length - 10)
  return slug(`${base.slice(0, baseLength)}-recovery-${suffix}`).slice(0, 63)
}

function isStoppedSandboxState(state: string | null) {
  return state?.toLowerCase() === "stopped"
}

function isStartedSandboxState(state: string | null) {
  return state?.toLowerCase() === "started"
}

function daytonaErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : ""
}

function isDaytonaStateChangeInProgressConflict(error: unknown) {
  const message = daytonaErrorMessage(error)
  return isDaytonaConflictError(error) && message.includes("state change") && message.includes("progress")
}

function isTransientDaytonaStartError(error: unknown) {
  const message = daytonaErrorMessage(error)
  if (!message) {
    return false
  }

  return /\b5\d\d\b/.test(message)
    || [
      "econnreset",
      "econnrefused",
      "etimedout",
      "enotfound",
      "fetch failed",
      "network",
      "socket hang up",
      "temporarily unavailable",
      "timeout",
    ].some((marker) => message.includes(marker))
}

async function waitForDaytonaStartConflictToSettle(sandbox: DaytonaSandboxRuntime) {
  const startedAt = Date.now()
  let sawTransitionState = false

  while (Date.now() - startedAt < wakeStartStateChangeTimeoutMs) {
    await sandbox.refreshData()

    if (isStartedSandboxState(sandbox.state)) {
      return "started"
    }

    if (isStoppedSandboxState(sandbox.state) && (sawTransitionState || Date.now() - startedAt >= env.daytona.pollIntervalMs)) {
      return "stopped"
    }

    if (!isStoppedSandboxState(sandbox.state)) {
      sawTransitionState = true
    }

    await sleep(env.daytona.pollIntervalMs)
  }

  throw new Error(`Timed out waiting for Daytona sandbox ${sandbox.id} state change to settle`)
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

function checkpointRestoreMarkerPath() {
  return `${env.daytona.runtimeDataPath}/.openwork-restore-marker`
}

function checkpointStateManifest() {
  return `${env.daytona.runtimeDataPath} ${env.daytona.runtimeWorkspacePath}`
}

function checkpointDir() {
  return `${env.daytona.dataMountPath}/checkpoints`
}

function checkpointLastFlushMarkerPath() {
  return `${env.daytona.sidecarDir}/checkpoint.last-flush`
}

function checkpointEnvironmentScript() {
  // The engine keeps its sessions in a SQLite database under its own data dir
  // (opencode.db), which lives on the container overlay rather than a volume.
  // It was missing from the checkpoint, so every recycle onto a new snapshot
  // started the user from scratch. Resolved from $HOME in-shell so it tracks
  // the image instead of a hardcoded /root.
  return `ENGINE_STATE_PATH=\${OPENWORK_ENGINE_STATE_PATH:-\$HOME/.local/share/opencode}
OPENWORK_STATE_MANIFEST="${checkpointStateManifest()} \$ENGINE_STATE_PATH"
CHECKPOINT_DIR=${shellQuote(checkpointDir())}
RESTORE_MARKER=${shellQuote(checkpointRestoreMarkerPath())}
LAST_FLUSH_MARKER=${shellQuote(checkpointLastFlushMarkerPath())}
DEN_CKPT_INTERVAL_SECONDS=\${DEN_CKPT_INTERVAL_SECONDS:-${shellQuote(String(env.daytona.checkpointIntervalSeconds))}}
DEN_CKPT_KEEP=\${DEN_CKPT_KEEP:-${shellQuote(String(env.daytona.checkpointKeep))}}`
}

function checkpointFlushFunctions(input: { failOnError: boolean }) {
  const failureReturn = input.failOnError ? "1" : "0"
  return `checkpoint_changed() {
  if [ ! -e "$LAST_FLUSH_MARKER" ]; then
    return 0
  fi
  for state_path in $OPENWORK_STATE_MANIFEST; do
    changed_entry=$(find "$state_path" -newer "$LAST_FLUSH_MARKER" -print -quit 2>/dev/null || true)
    if [ -n "$changed_entry" ]; then
      return 0
    fi
  done
  return 1
}

prune_checkpoints() {
  keep_count=$DEN_CKPT_KEEP
  if ! [ "$keep_count" -gt 0 ] 2>/dev/null; then
    keep_count=3
  fi
  checkpoint_count=0
  find "$CHECKPOINT_DIR" -maxdepth 1 -type f -name 'ckpt-*.tar' -print 2>/dev/null | sort -r | while IFS= read -r checkpoint_path; do
    checkpoint_count=$((checkpoint_count + 1))
    if [ "$checkpoint_count" -gt "$keep_count" ]; then
      rm -f "$checkpoint_path" || echo "checkpoint prune failed for $checkpoint_path" >&2
    fi
  done
}

flush_checkpoint() {
  mkdir -p "$CHECKPOINT_DIR" ${shellQuote(env.daytona.sidecarDir)}
  if ! checkpoint_changed; then
    return 0
  fi
  epoch=$(date +%s)
  tmp_checkpoint=${shellQuote(env.daytona.sidecarDir)}/ckpt-$epoch.tar
  set --
  for state_path in $OPENWORK_STATE_MANIFEST; do
    set -- "$@" "\${state_path#/}"
  done
  # Collapse the WAL so the copied database is self-consistent and small. Best
  # effort: a locked or absent database must never fail the flush.
  if [ -f "$ENGINE_STATE_PATH/opencode.db" ]; then
    node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA wal_checkpoint(TRUNCATE)");db.close()' "$ENGINE_STATE_PATH/opencode.db" >/dev/null 2>&1 || true
  fi
  # Credentials are re-materialized and re-delivered on every start, so they are
  # deliberately not persisted to the shared volume. Logs are noise.
  if tar -C / --exclude="\${ENGINE_STATE_PATH#/}/auth.json" --exclude="\${ENGINE_STATE_PATH#/}/log" -cf "$tmp_checkpoint" "$@"; then
    if cp "$tmp_checkpoint" "$CHECKPOINT_DIR/ckpt-$epoch.tar"; then
      touch "$LAST_FLUSH_MARKER"
      rm -f "$tmp_checkpoint"
      prune_checkpoints
      return 0
    fi
    echo "checkpoint flush copy failed for $CHECKPOINT_DIR/ckpt-$epoch.tar" >&2
  else
    echo "checkpoint flush tar failed for $tmp_checkpoint" >&2
  fi
  rm -f "$tmp_checkpoint"
  return ${failureReturn}
}`
}

export function checkpointFlushCommand() {
  return `set -u
${checkpointEnvironmentScript()}
${checkpointFlushFunctions({ failOnError: true })}
flush_checkpoint`
}

export function buildOpenWorkStartCommand(input: ProvisionInput) {
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
    // This single-user worker's SPA has no approvals responder, so manual mode makes gated writes such as chat-attachment uploads time out to 403.
    // Auto matches the desktop sidecar's approvalMode; viewer tokens remain blocked by scope checks.
    ` --approval auto`,
    ` --verbose`,
  ].join("")
  const script = `
set -u
mkdir -p ${shellQuote(env.daytona.workspaceMountPath)} ${shellQuote(env.daytona.dataMountPath)} ${shellQuote(env.daytona.runtimeWorkspacePath)} ${shellQuote(env.daytona.runtimeDataPath)} ${shellQuote(env.daytona.sidecarDir)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes`)}
ln -sfn ${shellQuote(env.daytona.workspaceMountPath)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes/workspace`) }
ln -sfn ${shellQuote(env.daytona.dataMountPath)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes/data`) }
${verifyRuntimeStep}
${checkpointEnvironmentScript()}

state_dirs_pristine() {
  if [ -e "$RESTORE_MARKER" ]; then
    return 1
  fi
  data_entry=$(find ${shellQuote(env.daytona.runtimeDataPath)} -mindepth 1 -print -quit 2>/dev/null || true)
  if [ -n "$data_entry" ]; then
    return 1
  fi
  workspace_entry=$(find ${shellQuote(env.daytona.runtimeWorkspacePath)} -mindepth 1 ! -path ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes`)} ! -path ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes/*`)} -print -quit 2>/dev/null || true)
  if [ -n "$workspace_entry" ]; then
    return 1
  fi
  return 0
}

hydrate_checkpoint() {
  mkdir -p "$CHECKPOINT_DIR"
  latest_checkpoint=$(find "$CHECKPOINT_DIR" -maxdepth 1 -type f -name 'ckpt-*.tar' -print 2>/dev/null | sort | tail -n 1 || true)
  if [ -z "$latest_checkpoint" ]; then
    return 0
  fi
  if ! state_dirs_pristine; then
    echo "checkpoint hydrate skipped; local OpenWork state is not pristine or was already restored"
    return 0
  fi
  echo "checkpoint hydrate restoring $latest_checkpoint"
  if tar -C / -xf "$latest_checkpoint"; then
    printf '%s\n' "$latest_checkpoint" > "$RESTORE_MARKER"
    return 0
  fi
  echo "checkpoint hydrate failed for $latest_checkpoint; continuing with fresh OpenWork state" >&2
  rm -rf ${shellQuote(env.daytona.runtimeDataPath)} ${shellQuote(env.daytona.runtimeWorkspacePath)}
  mkdir -p ${shellQuote(env.daytona.runtimeDataPath)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes`)}
  ln -sfn ${shellQuote(env.daytona.workspaceMountPath)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes/workspace`) }
  ln -sfn ${shellQuote(env.daytona.dataMountPath)} ${shellQuote(`${env.daytona.runtimeWorkspacePath}/volumes/data`) }
}

${checkpointFlushFunctions({ failOnError: false })}

checkpoint_loop() {
  while true; do
    sleep "$DEN_CKPT_INTERVAL_SECONDS"
    flush_checkpoint
  done
}

server_pid=""
checkpoint_pid=""
on_term() {
  echo "termination requested; flushing OpenWork checkpoint"
  flush_checkpoint
  if [ -n "$server_pid" ]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -n "$checkpoint_pid" ]; then
    kill "$checkpoint_pid" 2>/dev/null || true
    wait "$checkpoint_pid" 2>/dev/null || true
  fi
  exit 143
}
trap on_term TERM INT

hydrate_checkpoint
attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  ${openworkServe} &
  server_pid=$!
  checkpoint_loop &
  checkpoint_pid=$!
  wait "$server_pid"
  status=$?
  kill "$checkpoint_pid" 2>/dev/null || true
  wait "$checkpoint_pid" 2>/dev/null || true
  server_pid=""
  checkpoint_pid=""
  if [ "$status" -eq 0 ]; then
    flush_checkpoint
    exit 0
  fi
  echo "openwork-server failed (attempt $attempt, exit $status); rebuild and republish the Daytona snapshot if this persists; retrying in 3s"
  sleep 3
done
flush_checkpoint
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

export async function waitForHealth(url: string, timeoutMs: number, sandbox: DaytonaSandboxRuntime, sessionId: string, commandId: string) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const remainingMs = timeoutMs - (Date.now() - startedAt)
      const response = await fetch(`${url.replace(/\/$/, "")}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs, healthRequestTimeoutMs))),
      })
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

    const remainingAfterProbeMs = timeoutMs - (Date.now() - startedAt)
    if (remainingAfterProbeMs > 0) {
      await sleep(Math.min(env.daytona.pollIntervalMs, remainingAfterProbeMs))
    }
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

async function waitForSessionCommandExit(sandbox: DaytonaSandboxRuntime, sessionId: string, commandId: string, timeoutMs: number) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const command = await sandbox.process.getSessionCommand(sessionId, commandId)
    if (typeof command.exitCode === "number") {
      return command.exitCode
    }

    await sleep(env.daytona.pollIntervalMs)
  }

  return null
}

async function runSandboxShellCommand(sandbox: DaytonaSandboxRuntime, sessionId: string, command: string, timeoutSeconds: number) {
  await sandbox.process.createSession(sessionId)
  const result = await sandbox.process.executeSessionCommand(
    sessionId,
    { command: `sh -lc ${shellQuote(command)}`, runAsync: false },
    timeoutSeconds,
  )
  return waitForSessionCommandExit(sandbox, sessionId, result.cmdId, timeoutSeconds * 1000)
}

function checkpointExistsCommand() {
  return `test -n "$(find ${shellQuote(`${env.daytona.dataMountPath}/checkpoints`)} -maxdepth 1 -type f -name 'ckpt-*.tar' -print -quit 2>/dev/null)"`
}

function restoreMarkerExistsCommand() {
  return `test -s ${shellQuote(checkpointRestoreMarkerPath())}`
}

async function verifyRestoreMarker(sandbox: DaytonaSandboxRuntime) {
  const exitCode = await runSandboxShellCommand(
    sandbox,
    `openwork-restore-verify-${Date.now()}`,
    restoreMarkerExistsCommand(),
    env.daytona.createTimeoutSeconds,
  )
  return exitCode === 0
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
  const issuedAtMs = Date.now()
  const preview = await sandbox.getSignedPreviewUrl(env.daytona.openworkPort, expiresInSeconds)
  const expiresAt = signedPreviewRefreshAt(expiresInSeconds, issuedAtMs)

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
    stop: (timeout) => sandbox.stop(timeout),
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

async function checkpointExistsOnDaytonaVolume(daytona: Daytona, workerId: WorkerId, sharedVolume: DaytonaVolumeRuntime) {
  let probeSandbox: DaytonaSandboxRuntime | null = null

  try {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8)
    probeSandbox = toDaytonaSandboxRuntime(await daytona.create(
      buildCheckpointProbeCreateParams({
        workerId,
        name: slug(`den-daytona-ckpt-${workerHint(workerId)}-${suffix}`).slice(0, 63),
        sharedVolume,
      }),
      { timeout: env.daytona.createTimeoutSeconds },
    ))

    const exitCode = await runSandboxShellCommand(
      probeSandbox,
      `openwork-ckpt-probe-${workerHint(workerId)}-${Date.now()}`,
      checkpointExistsCommand(),
      env.daytona.createTimeoutSeconds,
    )
    return exitCode === 0
  } catch (error) {
    logger.warn("failed to inspect Daytona checkpoint volume", { worker_id: workerId, error })
    return false
  } finally {
    if (probeSandbox) {
      await probeSandbox.delete(env.daytona.deleteTimeoutSeconds).catch((error) => {
        logger.warn("failed to delete Daytona checkpoint probe sandbox", { worker_id: workerId, error })
      })
    }
  }
}

function buildCheckpointProbeCreateParams(input: { workerId: WorkerId; name: string; sharedVolume: DaytonaVolumeRuntime }): DaytonaCreateParams {
  const base = {
    name: input.name,
    public: false,
    autoStopInterval: 0,
    autoArchiveInterval: 0,
    autoDeleteInterval: 0,
    ephemeral: true,
    envVars: {
      DEN_RUNTIME_PROVIDER: "daytona-checkpoint-probe",
      DEN_WORKER_ID: input.workerId,
    },
    volumes: sharedVolumeMounts(input.workerId, input.sharedVolume.id),
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
      cpu: 1,
      memory: 1,
      disk: 4,
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
    checkpointExists: (input) => checkpointExistsOnDaytonaVolume(daytona, input.workerId, input.sharedVolume),
    verifyRestoreMarker,
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

async function getSandboxAfterCreateConflict(
  runtime: DaytonaProvisioningRuntime,
  lookupNames: string[],
  wait: (ms: number) => Promise<unknown>,
) {
  for (let attempt = 1; attempt <= createConflictLookupMaxAttempts; attempt += 1) {
    for (const lookupName of lookupNames) {
      const sandbox = await getSandboxByName(runtime, lookupName)
      if (sandbox) return sandbox
    }

    if (attempt < createConflictLookupMaxAttempts) {
      await wait(createConflictLookupBackoffMs)
    }
  }

  return null
}

type StartedOpenWorkProcess = {
  signedPreviewUrl: string
  signedPreviewUrlExpiresAt: Date
}

function provisionedInstance(url: string, region: string | null, imageVersion: string | null | undefined = currentDaytonaImageVersion()): ProvisionedInstance {
  return {
    provider: "daytona",
    url,
    status: "healthy",
    region: region ?? undefined,
    imageVersion,
  }
}

async function startOpenWorkProcessOnDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  sandbox: DaytonaSandboxRuntime
  sessionId: string
}): Promise<StartedOpenWorkProcess> {
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
  const issuedAtMs = input.runtime.now ? input.runtime.now() : Date.now()
  const preview = await input.sandbox.getSignedPreviewUrl(env.daytona.openworkPort, expiresInSeconds)
  await input.runtime.waitForHealth(preview.url, env.daytona.healthcheckTimeoutMs, input.sandbox, input.sessionId, command.cmdId)
  return {
    signedPreviewUrl: preview.url,
    signedPreviewUrlExpiresAt: signedPreviewRefreshAt(expiresInSeconds, issuedAtMs),
  }
}

async function persistDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  sandbox: DaytonaSandboxRuntime
  started: StartedOpenWorkProcess
  workspaceVolumeId: string
  dataVolumeId: string
}) {
  await input.runtime.upsertSandbox({
    workerId: input.provisionInput.workerId,
    sandboxId: input.sandbox.id,
    workspaceVolumeId: input.workspaceVolumeId,
    dataVolumeId: input.dataVolumeId,
    signedPreviewUrl: input.started.signedPreviewUrl,
    signedPreviewUrlExpiresAt: input.started.signedPreviewUrlExpiresAt,
    region: input.sandbox.target,
  })
}

async function startOpenWorkOnDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  sandbox: DaytonaSandboxRuntime
  sessionId: string
  workspaceVolumeId: string
  dataVolumeId: string
  imageVersion?: string | null
}): Promise<ProvisionedInstance> {
  const started = await startOpenWorkProcessOnDaytonaSandbox(input)
  await persistDaytonaSandbox({
    provisionInput: input.provisionInput,
    runtime: input.runtime,
    sandbox: input.sandbox,
    started,
    workspaceVolumeId: input.workspaceVolumeId,
    dataVolumeId: input.dataVolumeId,
  })

  return provisionedInstance(started.signedPreviewUrl, input.sandbox.target, input.imageVersion)
}

async function startDaytonaSandboxForWake(input: { workerId: WorkerId; sandbox: DaytonaSandboxRuntime }) {
  let lastError: unknown

  for (let attempt = 1; attempt <= wakeStartMaxAttempts; attempt += 1) {
    try {
      await input.sandbox.start(env.daytona.createTimeoutSeconds)
      return
    } catch (error) {
      lastError = error

      if (isDaytonaStateChangeInProgressConflict(error)) {
        logger.warn("Daytona sandbox start already in progress; waiting for convergence", { worker_id: input.workerId, sandbox_id: input.sandbox.id, error })
        const settledState = await waitForDaytonaStartConflictToSettle(input.sandbox)
        if (settledState === "started") {
          return
        }
        continue
      }

      if (!isTransientDaytonaStartError(error) || attempt === wakeStartMaxAttempts) {
        throw error
      }

      logger.warn("transient Daytona sandbox start failure; retrying", { worker_id: input.workerId, sandbox_id: input.sandbox.id, attempt, error })
      await sleep(wakeStartRetryBackoffMs)
      await input.sandbox.refreshData().catch(() => undefined)
      if (isStartedSandboxState(input.sandbox.state)) {
        return
      }
    }
  }

  throw lastError ?? new Error(`Daytona sandbox ${input.sandbox.id} start failed`)
}

function shouldRecycleDaytonaSandbox(input: { workerImageVersion: string | null; sandboxState: string | null }) {
  const imageVersion = currentDaytonaImageVersion()
  return Boolean(imageVersion && input.workerImageVersion !== imageVersion && isStoppedSandboxState(input.sandboxState))
}

async function wakeExistingDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  sandbox: DaytonaSandboxRuntime
  workspaceVolumeId: string
  dataVolumeId: string
  imageVersion?: string | null
}) {
  if (isStartedSandboxState(input.sandbox.state)) {
    // A failed health probe means an already-running OpenWork process cannot be
    // trusted. Restart the sandbox before launching a new process so recovery
    // cannot leave two servers competing for the same port and state files.
    await input.sandbox.stop(env.daytona.stopTimeoutSeconds ?? env.daytona.deleteTimeoutSeconds)
    await input.sandbox.refreshData()
  }
  await startDaytonaSandboxForWake({ workerId: input.provisionInput.workerId, sandbox: input.sandbox })

  return startOpenWorkOnDaytonaSandbox({
    provisionInput: input.provisionInput,
    runtime: input.runtime,
    sandbox: input.sandbox,
    sessionId: `openwork-wake-${workerHint(input.provisionInput.workerId)}-${Date.now()}`,
    workspaceVolumeId: input.workspaceVolumeId,
    dataVolumeId: input.dataVolumeId,
    imageVersion: input.imageVersion,
  })
}

async function recycleDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  oldSandbox: DaytonaSandboxRuntime
  sharedVolume: DaytonaVolumeRuntime
  oldWorkspaceVolumeId: string
  oldDataVolumeId: string
  oldImageVersion: string | null
  replacementName?: string
  requireRestoreMarker?: boolean
}): Promise<ProvisionedInstance> {
  let replacementSandbox: DaytonaSandboxRuntime | null = null

  try {
    replacementSandbox = await input.runtime.createSandbox(
      buildDaytonaCreateParams(
        input.provisionInput,
        input.replacementName ?? currentDaytonaSandboxName(input.provisionInput),
        input.sharedVolume,
      ),
    )
    const started = await startOpenWorkProcessOnDaytonaSandbox({
      provisionInput: input.provisionInput,
      runtime: input.runtime,
      sandbox: replacementSandbox,
      sessionId: `openwork-recycle-${workerHint(input.provisionInput.workerId)}-${Date.now()}`,
    })
    const restored = input.requireRestoreMarker === false
      ? true
      : await input.runtime.verifyRestoreMarker(replacementSandbox)
    if (!restored) {
      throw new Error("Daytona replacement did not restore an OpenWork checkpoint")
    }

    await persistDaytonaSandbox({
      provisionInput: input.provisionInput,
      runtime: input.runtime,
      sandbox: replacementSandbox,
      started,
      workspaceVolumeId: input.sharedVolume.id,
      dataVolumeId: input.sharedVolume.id,
    })
    await input.oldSandbox.delete(env.daytona.deleteTimeoutSeconds)
    return provisionedInstance(started.signedPreviewUrl, replacementSandbox.target)
  } catch (error) {
    if (replacementSandbox) {
      await replacementSandbox.delete(env.daytona.deleteTimeoutSeconds).catch((deleteError) => {
        logger.warn("failed to delete failed Daytona replacement sandbox", { worker_id: input.provisionInput.workerId, error: deleteError })
      })
    }

    logger.warn("Daytona sandbox recycle failed; waking existing sandbox", { worker_id: input.provisionInput.workerId, error })
    return wakeExistingDaytonaSandbox({
      provisionInput: input.provisionInput,
      runtime: input.runtime,
      sandbox: input.oldSandbox,
      workspaceVolumeId: input.oldWorkspaceVolumeId,
      dataVolumeId: input.oldDataVolumeId,
      imageVersion: input.oldImageVersion,
    })
  }
}

async function adoptDaytonaSandbox(input: {
  provisionInput: ProvisionInput
  runtime: DaytonaProvisioningRuntime
  sandbox: DaytonaSandboxRuntime
  sharedVolume: DaytonaVolumeRuntime
}): Promise<ProvisionedInstance> {
  return wakeExistingDaytonaSandbox({
    provisionInput: input.provisionInput,
    runtime: input.runtime,
    sandbox: input.sandbox,
    workspaceVolumeId: input.sharedVolume.id,
    dataVolumeId: input.sharedVolume.id,
  })
}

export async function provisionWorkerOnDaytonaWithRuntime(
  input: ProvisionInput,
  runtime: DaytonaProvisioningRuntime,
  options: { sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<ProvisionedInstance> {
  const name = currentDaytonaSandboxName(input)
  const lookupNames = daytonaSandboxLookupNames(input)
  const sharedVolume = await getSharedDaytonaVolume(runtime)
  for (const lookupName of lookupNames) {
    const existingSandbox = await getSandboxByName(runtime, lookupName)
    if (existingSandbox) {
      return adoptDaytonaSandbox({ provisionInput: input, runtime, sandbox: existingSandbox, sharedVolume })
    }
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
      const conflictSandbox = await getSandboxAfterCreateConflict(runtime, lookupNames, options.sleep ?? sleep)
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

export async function flushWorkerCheckpointOnDaytona(workerId: WorkerId) {
  assertDaytonaConfig()

  const record = await getDaytonaSandboxRecord(workerId)
  if (!record) {
    return false
  }

  const daytona = createDaytonaClient()
  const sandbox = await daytona.get(record.sandbox_id)
  await sandbox.refreshData()
  const exitCode = await runSandboxShellCommand(
    toDaytonaSandboxRuntime(sandbox),
    `openwork-update-flush-${workerHint(workerId)}-${Date.now()}`,
    checkpointFlushCommand(),
    env.daytona.createTimeoutSeconds,
  )

  return exitCode === 0
}

export type DaytonaSandboxWakeRecord = {
  sandbox_id: string
  workspace_volume_id: string
  data_volume_id: string
}

async function getWorkerImageVersion(workerId: WorkerId) {
  const rows = await db
    .select({ image_version: WorkerTable.image_version })
    .from(WorkerTable)
    .where(eq(WorkerTable.id, workerId))
    .limit(1)

  return rows[0]?.image_version ?? null
}

export async function wakeWorkerOnDaytonaWithRuntime(
  input: ProvisionInput,
  runtime: DaytonaProvisioningRuntime,
  record: DaytonaSandboxWakeRecord,
  workerImageVersion: string | null,
): Promise<ProvisionedInstance> {
  const sandbox = await runtime.getSandbox(record.sandbox_id)
  await sandbox.refreshData()

  if (shouldRecycleDaytonaSandbox({ workerImageVersion, sandboxState: sandbox.state })) {
    const sharedVolume = await getSharedDaytonaVolume(runtime)
    const hasCheckpoint = await runtime.checkpointExists({ workerId: input.workerId, sharedVolume })
    if (hasCheckpoint) {
      return recycleDaytonaSandbox({
        provisionInput: input,
        runtime,
        oldSandbox: sandbox,
        sharedVolume,
        oldWorkspaceVolumeId: record.workspace_volume_id,
        oldDataVolumeId: record.data_volume_id,
        oldImageVersion: workerImageVersion,
      })
    }
  }

  try {
    return await wakeExistingDaytonaSandbox({
      provisionInput: input,
      runtime,
      sandbox,
      workspaceVolumeId: record.workspace_volume_id,
      dataVolumeId: record.data_volume_id,
      imageVersion: workerImageVersion,
    })
  } catch (wakeError) {
    const sharedVolume = await getSharedDaytonaVolume(runtime)
    const hasCheckpoint = await runtime.checkpointExists({ workerId: input.workerId, sharedVolume })
    if (!hasCheckpoint && workerImageVersion !== null) {
      throw wakeError
    }

    logger.warn("Daytona sandbox wake failed; replacing the unhealthy sandbox", {
      worker_id: input.workerId,
      sandbox_id: sandbox.id,
      checkpoint_available: hasCheckpoint,
      error: wakeError,
    })
    return recycleDaytonaSandbox({
      provisionInput: input,
      runtime,
      oldSandbox: sandbox,
      sharedVolume,
      oldWorkspaceVolumeId: record.workspace_volume_id,
      oldDataVolumeId: record.data_volume_id,
      oldImageVersion: workerImageVersion,
      replacementName: recoveryDaytonaSandboxName(input),
      requireRestoreMarker: hasCheckpoint,
    })
  }
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
  const workerImageVersion = await getWorkerImageVersion(input.workerId)
  try {
    return await wakeWorkerOnDaytonaWithRuntime(input, runtime, record, workerImageVersion)
  } catch (error) {
    if (isDaytonaNotFoundError(error)) {
      throw new DaytonaSandboxMissingError(`Daytona sandbox ${record.sandbox_id} missing for worker ${input.workerId}`)
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
