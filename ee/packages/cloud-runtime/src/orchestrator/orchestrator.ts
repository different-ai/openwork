import { randomUUID } from "node:crypto"
import {
  renderCheckpointFlushCommand,
  renderOpenWorkBootstrapCommand,
  renderRestoreMarkerExistsCommand,
  type OpenWorkBootstrapConfig,
  type OpenWorkCheckpointConfig,
} from "../bootstrap/openwork-runtime"
import { runtimeProviderErrorCode } from "../contract/errors"
import type {
  ExecHandle,
  ImageRef,
  SandboxHandle,
  SandboxLifecyclePolicy,
  SandboxProvider,
  SandboxResources,
  SandboxSpec,
  StorageAttachment,
  VolumeRef,
} from "../contract/provider"
import { CloudRuntimeError } from "./errors"
import {
  currentInstanceName,
  instanceLookupNames,
  recoveryInstanceName,
  workerHint,
  type InstanceNameInput,
} from "./names"
import type { RuntimeInstanceInspection, RuntimeInstanceRecord, RuntimeInstanceStore } from "./store"

export type ProvisionInput = {
  workerId: string
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}

export type ProvisionedInstance = {
  provider: string
  url: string
  status: "provisioning" | "healthy"
  region?: string
  imageVersion?: string | null
}

export type StopInstanceResult =
  | { status: "no_instance" }
  | { status: "stopped" }

export type CloudRuntimeOrchestratorConfig = {
  instanceNamePrefix: string
  sharedVolumeName: string
  workspaceMountPath: string
  dataMountPath: string
  runtimeWorkspacePath: string
  runtimeDataPath: string
  sidecarDir: string
  checkpointIntervalSeconds: number
  checkpointKeep: number
  port: number
  publicEndpoint: boolean
  lifecycle: SandboxLifecyclePolicy
  resources: SandboxResources
  /** Requested endpoint lifetime; the provider may cap it. */
  endpointTtlSeconds: number
  /** Stop handing out an endpoint this long before it expires. */
  endpointRefreshLeadMs: number
  createTimeoutMs: number
  stopTimeoutMs: number
  destroyTimeoutMs: number
  healthcheckTimeoutMs: number
  pollIntervalMs: number
  activityHeartbeatUrl: (workerId: string) => string
  bootstrap: {
    imageDescription: string
    rebuildHint: string
  }
}

export type CloudRuntimeLogger = {
  warn: (message: string, meta?: Record<string, unknown>) => void
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type CloudRuntimeOrchestratorDeps = {
  provider: SandboxProvider
  store: RuntimeInstanceStore
  config: CloudRuntimeOrchestratorConfig
  logger: CloudRuntimeLogger
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<unknown>
  now?: () => number
  randomSuffix?: () => string
}

export interface CloudRuntimeOrchestrator {
  readonly providerId: string
  currentImage(): ImageRef | null
  currentImageVersion(): string | null
  instanceName(input: InstanceNameInput): string
  provision(input: ProvisionInput): Promise<ProvisionedInstance>
  /** Throws `instance_missing` when there is nothing to wake; callers fall back to `provision`. */
  wake(input: ProvisionInput): Promise<ProvisionedInstance>
  stop(workerId: string): Promise<StopInstanceResult>
  deprovision(workerId: string): Promise<void>
  flushCheckpoint(workerId: string): Promise<boolean>
  inspect(workerId: string): Promise<RuntimeInstanceInspection | null>
  refreshEndpoint(workerId: string): Promise<RuntimeInstanceRecord | null>
  getRecord(workerId: string): Promise<RuntimeInstanceRecord | null>
}

const wakeStartMaxAttempts = 3
const wakeStartRetryBackoffMs = 250
const wakeStartStateChangeTimeoutMs = 60_000
const healthRequestTimeoutMs = 5_000
const createConflictLookupMaxAttempts = 6
const createConflictLookupBackoffMs = 2_000
const maxEndpointTtlSeconds = 60 * 60 * 24

type StartedProcess = {
  endpointUrl: string
  endpointExpiresAt: Date
}

type WakeContext = {
  input: ProvisionInput
  handle: SandboxHandle
  workspaceVolumeId: string
  dataVolumeId: string
  imageVersion?: string | null
}

export function createCloudRuntimeOrchestrator(deps: CloudRuntimeOrchestratorDeps): CloudRuntimeOrchestrator {
  const { provider, store, config, logger } = deps
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init))
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const randomSuffix = deps.randomSuffix ?? (() => randomUUID().replace(/-/g, "").slice(0, 8))

  function currentImage() {
    return provider.currentImage()
  }

  function currentImageVersion() {
    return currentImage()?.version ?? null
  }

  function endpointTtlSeconds() {
    return Math.max(1, Math.min(config.endpointTtlSeconds, maxEndpointTtlSeconds))
  }

  function endpointSafeUntil(expiresAt: Date | null, issuedAtMs: number, ttlSeconds: number) {
    const expiresAtMs = expiresAt?.getTime() ?? issuedAtMs + ttlSeconds * 1000
    return new Date(Math.max(issuedAtMs, expiresAtMs - config.endpointRefreshLeadMs))
  }

  function checkpointConfig(): OpenWorkCheckpointConfig {
    return {
      dataMountPath: config.dataMountPath,
      runtimeDataPath: config.runtimeDataPath,
      runtimeWorkspacePath: config.runtimeWorkspacePath,
      sidecarDir: config.sidecarDir,
      intervalSeconds: config.checkpointIntervalSeconds,
      keep: config.checkpointKeep,
    }
  }

  function bootstrapConfig(input: ProvisionInput): OpenWorkBootstrapConfig {
    return {
      ...checkpointConfig(),
      workspaceMountPath: config.workspaceMountPath,
      port: config.port,
      workerId: input.workerId,
      clientToken: input.clientToken,
      hostToken: input.hostToken,
      activityHeartbeat: {
        url: config.activityHeartbeatUrl(input.workerId),
        token: input.activityToken,
      },
      runtimeProvider: provider.id,
      imageDescription: config.bootstrap.imageDescription,
      rebuildHint: config.bootstrap.rebuildHint,
    }
  }

  function workerVolumeSubpaths(workerId: string) {
    const root = `workers/${workerId}`
    return { workspace: `${root}/workspace`, data: `${root}/data` }
  }

  function storageAttachments(workerId: string, volume: VolumeRef): StorageAttachment[] {
    const subpaths = workerVolumeSubpaths(workerId)
    return [
      { volume, mountPath: config.workspaceMountPath, subpath: subpaths.workspace },
      { volume, mountPath: config.dataMountPath, subpath: subpaths.data },
    ]
  }

  function labels(workerId: string) {
    return {
      "openwork.den.provider": provider.id,
      "openwork.den.worker-id": workerId,
    }
  }

  function instanceSpec(input: ProvisionInput, name: string, volume: VolumeRef): SandboxSpec {
    return {
      workerId: input.workerId,
      idempotencyKey: name,
      image: currentImage(),
      resources: config.resources,
      labels: labels(input.workerId),
      env: {
        DEN_WORKER_ID: input.workerId,
        DEN_RUNTIME_PROVIDER: provider.id,
      },
      storage: storageAttachments(input.workerId, volume),
      exposePorts: [config.port],
      lifecycle: config.lifecycle,
      public: config.publicEndpoint,
    }
  }

  function instanceName(input: InstanceNameInput) {
    return currentInstanceName(config.instanceNamePrefix, input, currentImageVersion())
  }

  function provisioned(url: string, region: string | null, imageVersion: string | null | undefined = currentImageVersion()): ProvisionedInstance {
    return {
      provider: provider.id,
      url,
      status: "healthy",
      region: region ?? undefined,
      imageVersion,
    }
  }

  async function sharedVolume() {
    return provider.storage.ensureVolume(config.sharedVolumeName, { timeoutMs: config.createTimeoutMs })
  }

  async function findByName(name: string) {
    return provider.find({ idempotencyKey: name })
  }

  async function findAfterCreateConflict(lookupNames: string[]) {
    for (let attempt = 1; attempt <= createConflictLookupMaxAttempts; attempt += 1) {
      for (const lookupName of lookupNames) {
        const handle = await findByName(lookupName)
        if (handle) return handle
      }
      if (attempt < createConflictLookupMaxAttempts) {
        await sleep(createConflictLookupBackoffMs)
      }
    }
    return null
  }

  async function processExitFailure(exec: ExecHandle) {
    const exitCode = await exec.exitCode()
    if (typeof exitCode !== "number" || exitCode === 0) return null
    const logs = await exec.logs()
    return new CloudRuntimeError(
      "runtime_start_failed",
      [
        `openwork session exited with ${exitCode}`,
        logs.stdout.trim() ? `stdout:\n${logs.stdout.trim().slice(-4000)}` : "",
        logs.stderr.trim() ? `stderr:\n${logs.stderr.trim().slice(-4000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }

  async function waitForHealth(url: string, exec: ExecHandle) {
    const timeoutMs = config.healthcheckTimeoutMs
    const startedAt = now()
    const healthUrl = `${url.replace(/\/$/, "")}/health`

    while (now() - startedAt < timeoutMs) {
      try {
        const remainingMs = timeoutMs - (now() - startedAt)
        const response = await fetchImpl(healthUrl, {
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
        const failure = await processExitFailure(exec)
        if (failure) throw failure
      } catch (error) {
        if (isCloudRuntimeErrorWithCode(error, "runtime_start_failed")) {
          throw error
        }
      }

      const remainingAfterProbeMs = timeoutMs - (now() - startedAt)
      if (remainingAfterProbeMs > 0) {
        await sleep(Math.min(config.pollIntervalMs, remainingAfterProbeMs))
      }
    }

    const logs = await exec.logs().catch(() => null)
    throw new CloudRuntimeError(
      "runtime_health_timeout",
      [
        `Timed out waiting for Cloud runtime health at ${healthUrl}`,
        logs?.stdout.trim() ? `stdout:\n${logs.stdout.trim().slice(-4000)}` : "",
        logs?.stderr.trim() ? `stderr:\n${logs.stderr.trim().slice(-4000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }

  async function startProcess(input: ProvisionInput, handle: SandboxHandle, sessionId: string): Promise<StartedProcess> {
    const exec = await provider.exec(handle, {
      command: renderOpenWorkBootstrapCommand(bootstrapConfig(input)),
      detach: true,
      timeoutMs: 0,
      sessionId,
    })
    const ttlSeconds = endpointTtlSeconds()
    const issuedAtMs = now()
    const endpoint = await provider.endpoint(handle, config.port, { ttlSeconds })
    await waitForHealth(endpoint.url, exec)
    return {
      endpointUrl: endpoint.url,
      endpointExpiresAt: endpointSafeUntil(endpoint.expiresAt, issuedAtMs, ttlSeconds),
    }
  }

  async function persist(input: ProvisionInput, handle: SandboxHandle, started: StartedProcess, workspaceVolumeId: string, dataVolumeId: string) {
    await store.upsert({
      workerId: input.workerId,
      sandbox: handle.ref,
      storage: { workspaceVolumeId, dataVolumeId },
      endpointUrl: started.endpointUrl,
      endpointExpiresAt: started.endpointExpiresAt,
      region: handle.region,
    })
  }

  async function startOnInstance(context: WakeContext, sessionId: string): Promise<ProvisionedInstance> {
    const started = await startProcess(context.input, context.handle, sessionId)
    await persist(context.input, context.handle, started, context.workspaceVolumeId, context.dataVolumeId)
    return provisioned(started.endpointUrl, context.handle.region, context.imageVersion)
  }

  async function waitForStartToSettle(handle: SandboxHandle) {
    const startedAt = now()
    let sawTransitionState = false
    let current = handle

    while (now() - startedAt < wakeStartStateChangeTimeoutMs) {
      current = await provider.inspect(current)
      if (current.state === "running") return { state: "running" as const, handle: current }
      if (current.state === "stopped" && (sawTransitionState || now() - startedAt >= config.pollIntervalMs)) {
        return { state: "stopped" as const, handle: current }
      }
      if (current.state !== "stopped") {
        sawTransitionState = true
      }
      await sleep(config.pollIntervalMs)
    }

    throw new CloudRuntimeError("instance_start_failed", `Timed out waiting for instance ${describeHandle(handle)} state change to settle`)
  }

  async function startForWake(workerId: string, handle: SandboxHandle) {
    let lastError: unknown
    let current = handle

    for (let attempt = 1; attempt <= wakeStartMaxAttempts; attempt += 1) {
      try {
        await provider.start(current, { timeoutMs: config.createTimeoutMs })
        return current
      } catch (error) {
        lastError = error
        const code = runtimeProviderErrorCode(error)

        if (code === "invalid_state") {
          logger.warn("instance start already in progress; waiting for convergence", { worker_id: workerId, instance: describeHandle(current), error })
          const settled = await waitForStartToSettle(current)
          current = settled.handle
          if (settled.state === "running") return current
          continue
        }

        const transient = code === "transient" || code === "timeout"
        if (!transient || attempt === wakeStartMaxAttempts) {
          throw error
        }

        logger.warn("transient instance start failure; retrying", { worker_id: workerId, instance: describeHandle(current), attempt, error })
        await sleep(wakeStartRetryBackoffMs)
        current = await provider.inspect(current).catch(() => current)
        if (current.state === "running") return current
      }
    }

    throw lastError ?? new CloudRuntimeError("instance_start_failed", `Instance ${describeHandle(handle)} start failed`)
  }

  async function wakeExisting(context: WakeContext): Promise<ProvisionedInstance> {
    let handle = context.handle
    if (handle.state === "running") {
      // A failed health probe means an already-running OpenWork process cannot be
      // trusted. Restart the instance before launching a new process so recovery
      // cannot leave two servers competing for the same port and state files.
      await provider.stop(handle, { timeoutMs: config.stopTimeoutMs })
      handle = await provider.inspect(handle)
    }
    handle = await startForWake(context.input.workerId, handle)

    return startOnInstance({ ...context, handle }, `openwork-wake-${workerHint(context.input.workerId)}-${now()}`)
  }

  async function verifyRestoreMarker(handle: SandboxHandle) {
    const exec = await provider.exec(handle, {
      command: `sh -lc ${quote(renderRestoreMarkerExistsCommand(checkpointConfig()))}`,
      detach: false,
      timeoutMs: config.createTimeoutMs,
      sessionId: `openwork-restore-verify-${now()}`,
    })
    return (await exec.exitCode()) === 0
  }

  async function checkpointExists(workerId: string, volume: VolumeRef) {
    if (!provider.storage.exists) return false
    try {
      return await provider.storage.exists(
        volume,
        `${workerVolumeSubpaths(workerId).data}/checkpoints/ckpt-*.tar`,
        { timeoutMs: config.createTimeoutMs },
      )
    } catch (error) {
      logger.warn("failed to inspect checkpoint storage", { worker_id: workerId, error })
      return false
    }
  }

  async function recycle(input: {
    provisionInput: ProvisionInput
    oldHandle: SandboxHandle
    volume: VolumeRef
    oldWorkspaceVolumeId: string
    oldDataVolumeId: string
    oldImageVersion: string | null
    replacementName?: string
    requireRestoreMarker?: boolean
  }): Promise<ProvisionedInstance> {
    let replacement: SandboxHandle | null = null

    try {
      replacement = await provider.create(
        instanceSpec(input.provisionInput, input.replacementName ?? instanceName(input.provisionInput), input.volume),
        { timeoutMs: config.createTimeoutMs },
      )
      const started = await startProcess(
        input.provisionInput,
        replacement,
        `openwork-recycle-${workerHint(input.provisionInput.workerId)}-${now()}`,
      )
      const restored = input.requireRestoreMarker === false ? true : await verifyRestoreMarker(replacement)
      if (!restored) {
        throw new CloudRuntimeError("checkpoint_not_restored", "Replacement instance did not restore an OpenWork checkpoint")
      }

      await persist(input.provisionInput, replacement, started, input.volume.id, input.volume.id)
      await provider.destroy(input.oldHandle, { timeoutMs: config.destroyTimeoutMs })
      return provisioned(started.endpointUrl, replacement.region)
    } catch (error) {
      if (replacement) {
        await provider.destroy(replacement, { timeoutMs: config.destroyTimeoutMs }).catch((destroyError) => {
          logger.warn("failed to destroy failed replacement instance", { worker_id: input.provisionInput.workerId, error: destroyError })
        })
      }

      logger.warn("instance recycle failed; waking existing instance", { worker_id: input.provisionInput.workerId, error })
      return wakeExisting({
        input: input.provisionInput,
        handle: input.oldHandle,
        workspaceVolumeId: input.oldWorkspaceVolumeId,
        dataVolumeId: input.oldDataVolumeId,
        imageVersion: input.oldImageVersion,
      })
    }
  }

  async function adopt(input: ProvisionInput, handle: SandboxHandle, volume: VolumeRef) {
    return wakeExisting({ input, handle, workspaceVolumeId: volume.id, dataVolumeId: volume.id })
  }

  async function provision(input: ProvisionInput): Promise<ProvisionedInstance> {
    const name = instanceName(input)
    const lookupNames = instanceLookupNames(config.instanceNamePrefix, input, currentImageVersion())
    const volume = await sharedVolume()
    for (const lookupName of lookupNames) {
      const existing = await findByName(lookupName)
      if (existing) {
        return adopt(input, existing, volume)
      }
    }

    let created: SandboxHandle | null = null
    try {
      created = await provider.create(instanceSpec(input, name, volume), { timeoutMs: config.createTimeoutMs })
      return await startOnInstance(
        { input, handle: created, workspaceVolumeId: volume.id, dataVolumeId: volume.id },
        `openwork-${workerHint(input.workerId)}`,
      )
    } catch (error) {
      if (created) {
        await provider.destroy(created, { timeoutMs: config.destroyTimeoutMs }).catch(() => undefined)
      }

      if (runtimeProviderErrorCode(error) === "conflict") {
        const conflictHandle = await findAfterCreateConflict(lookupNames)
        if (conflictHandle) {
          return adopt(input, conflictHandle, volume)
        }
      }

      throw error
    }
  }

  function shouldRecycle(workerImageVersion: string | null, handle: SandboxHandle) {
    const imageVersion = currentImageVersion()
    return Boolean(imageVersion && workerImageVersion !== imageVersion && handle.state === "stopped")
  }

  async function requireLiveHandle(record: RuntimeInstanceRecord) {
    const handle = await provider.get(record.sandbox)
    if (!handle) {
      throw new CloudRuntimeError("instance_missing", `Instance ${record.sandbox.ref.sandboxId ?? JSON.stringify(record.sandbox.ref)} missing for worker ${record.workerId}`)
    }
    return provider.inspect(handle)
  }

  async function wake(input: ProvisionInput): Promise<ProvisionedInstance> {
    const record = await store.get(input.workerId)
    if (!record) {
      throw new CloudRuntimeError("instance_missing", `Instance record missing for worker ${input.workerId}`)
    }
    try {
      return await wakeRecorded(input, record)
    } catch (error) {
      if (runtimeProviderErrorCode(error) === "not_found") {
        throw new CloudRuntimeError("instance_missing", `Instance missing for worker ${input.workerId}`, { cause: error })
      }
      throw error
    }
  }

  async function wakeRecorded(input: ProvisionInput, record: RuntimeInstanceRecord): Promise<ProvisionedInstance> {
    const workerImageVersion = await store.getWorkerImageVersion(input.workerId)
    const handle = await requireLiveHandle(record)

    if (shouldRecycle(workerImageVersion, handle)) {
      const volume = await sharedVolume()
      if (await checkpointExists(input.workerId, volume)) {
        return recycle({
          provisionInput: input,
          oldHandle: handle,
          volume,
          oldWorkspaceVolumeId: record.storage.workspaceVolumeId,
          oldDataVolumeId: record.storage.dataVolumeId,
          oldImageVersion: workerImageVersion,
        })
      }
    }

    try {
      return await wakeExisting({
        input,
        handle,
        workspaceVolumeId: record.storage.workspaceVolumeId,
        dataVolumeId: record.storage.dataVolumeId,
        imageVersion: workerImageVersion,
      })
    } catch (wakeError) {
      const volume = await sharedVolume()
      const hasCheckpoint = await checkpointExists(input.workerId, volume)
      if (!hasCheckpoint && workerImageVersion !== null) {
        throw wakeError
      }

      logger.warn("instance wake failed; replacing the unhealthy instance", {
        worker_id: input.workerId,
        instance: describeHandle(handle),
        checkpoint_available: hasCheckpoint,
        error: wakeError,
      })
      return recycle({
        provisionInput: input,
        oldHandle: handle,
        volume,
        oldWorkspaceVolumeId: record.storage.workspaceVolumeId,
        oldDataVolumeId: record.storage.dataVolumeId,
        oldImageVersion: workerImageVersion,
        replacementName: recoveryInstanceName(config.instanceNamePrefix, input, currentImageVersion(), randomSuffix()),
        requireRestoreMarker: hasCheckpoint,
      })
    }
  }

  // This preserves customer data: deprovision erases workers/<id>/, while stop
  // must not destroy the instance, erase data, or touch volumes.
  async function stop(workerId: string): Promise<StopInstanceResult> {
    const record = await store.get(workerId)
    if (!record) {
      return { status: "no_instance" }
    }

    const handle = await requireLiveHandle(record)
    if (handle.state === "stopped") {
      return { status: "stopped" }
    }

    await provider.stop(handle, { timeoutMs: config.stopTimeoutMs })
    return { status: "stopped" }
  }

  async function flushCheckpoint(workerId: string) {
    const record = await store.get(workerId)
    if (!record) {
      return false
    }

    const handle = await requireLiveHandle(record)
    const exec = await provider.exec(handle, {
      command: `sh -lc ${quote(renderCheckpointFlushCommand(checkpointConfig()))}`,
      detach: false,
      timeoutMs: config.createTimeoutMs,
      sessionId: `openwork-update-flush-${workerHint(workerId)}-${now()}`,
    })
    return (await exec.exitCode()) === 0
  }

  async function inspect(workerId: string): Promise<RuntimeInstanceInspection | null> {
    const record = await store.get(workerId)
    if (!record) {
      return null
    }

    const handle = await provider.get(record.sandbox)
    if (!handle) {
      return null
    }
    const inspected = await provider.inspect(handle)
    return inspected.state === "missing" ? null : { state: inspected.state }
  }

  async function refreshEndpoint(workerId: string) {
    const record = await store.get(workerId)
    if (!record) {
      return null
    }

    const handle = await requireLiveHandle(record)
    const ttlSeconds = endpointTtlSeconds()
    const issuedAtMs = now()
    const endpoint = await provider.endpoint(handle, config.port, { ttlSeconds })
    const update = {
      endpointUrl: endpoint.url,
      endpointExpiresAt: endpointSafeUntil(endpoint.expiresAt, issuedAtMs, ttlSeconds),
      region: handle.region,
    }
    await store.updateEndpoint(workerId, update)
    return { ...record, ...update }
  }

  async function eraseWorkerData(workerId: string) {
    let volume: VolumeRef
    try {
      volume = await sharedVolume()
    } catch (error) {
      logger.warn("failed to resolve shared volume", { worker_id: workerId, error })
      return
    }

    const subpaths = workerVolumeSubpaths(workerId)
    try {
      await provider.storage.eraseSubpaths(volume, [subpaths.workspace, subpaths.data], { timeoutMs: config.destroyTimeoutMs })
    } catch (error) {
      logger.warn("failed to erase worker data", { worker_id: workerId, error })
    }
  }

  async function deprovision(workerId: string) {
    const record = await store.get(workerId)

    if (record) {
      try {
        const handle = await provider.get(record.sandbox)
        if (handle) {
          await provider.destroy(handle, { timeoutMs: config.destroyTimeoutMs })
        }
      } catch (error) {
        logger.warn("failed to destroy instance", { worker_id: workerId, instance: record.sandbox.ref, error })
      }

      await eraseWorkerData(workerId)
      return
    }

    const seen = new Set<string>()
    while (true) {
      const orphan = await provider.find({ labels: labels(workerId) })
      if (!orphan) break
      const key = JSON.stringify(orphan.ref.ref)
      if (seen.has(key)) break
      seen.add(key)
      await provider.destroy(orphan, { timeoutMs: config.destroyTimeoutMs }).catch((error) => {
        logger.warn("failed to destroy instance", { worker_id: workerId, instance: orphan.ref.ref, error })
      })
    }

    await eraseWorkerData(workerId)
  }

  return {
    providerId: provider.id,
    currentImage,
    currentImageVersion,
    instanceName,
    provision,
    wake,
    stop,
    deprovision,
    flushCheckpoint,
    inspect,
    refreshEndpoint,
    getRecord: (workerId) => store.get(workerId),
  }
}

function describeHandle(handle: SandboxHandle) {
  return handle.ref.ref.sandboxId ?? JSON.stringify(handle.ref.ref)
}

function isCloudRuntimeErrorWithCode(error: unknown, code: CloudRuntimeError["code"]) {
  return error instanceof CloudRuntimeError && error.code === code
}

function quote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
