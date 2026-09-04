import { randomUUID } from "node:crypto"
import { Daytona, type CreateSandboxFromImageParams, type CreateSandboxFromSnapshotParams, type Sandbox } from "@daytonaio/sdk"
import { shellQuote } from "@openwork-ee/cloud-runtime/bootstrap"
import {
  RuntimeProviderError,
  type Endpoint,
  type ExecHandle,
  type ExecSpec,
  type ImageRef,
  type ProviderCapabilities,
  type ProviderTimeout,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxQuery,
  type SandboxRef,
  type SandboxResources,
  type SandboxSpec,
  type SandboxState,
  type SandboxStorage,
} from "@openwork-ee/cloud-runtime/contract"
import { toRuntimeProviderError } from "./errors"

export const DAYTONA_PROVIDER_ID = "daytona"

export type DaytonaProviderConfig = {
  apiKey: string
  apiUrl: string
  target?: string
  /** The pinned runtime snapshot; `null` boots `image` with `resources` instead. */
  snapshot: string | null
  image: string
  resources: SandboxResources
  pollIntervalMs: number
}

/** The slice of the SDK the provider drives; production wraps `Daytona`, tests substitute. */
export type DaytonaSandboxClient = {
  readonly id: string
  readonly state: string | null
  readonly target: string | null
  refreshData(): Promise<unknown>
  start(timeoutSeconds?: number): Promise<unknown>
  stop(timeoutSeconds?: number): Promise<unknown>
  delete(timeoutSeconds?: number): Promise<unknown>
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<{ url: string }>
  process: {
    createSession(sessionId: string): Promise<unknown>
    executeSessionCommand(sessionId: string, request: { command: string; runAsync: boolean }, timeoutSeconds?: number): Promise<{ cmdId: string }>
    getSessionCommand(sessionId: string, commandId: string): Promise<{ exitCode?: number | null }>
    getSessionCommandLogs(sessionId: string, commandId: string): Promise<{ stdout?: string | null; stderr?: string | null }>
  }
}

export type DaytonaCreateParams = CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams

export type DaytonaClient = {
  create(params: DaytonaCreateParams, options: { timeout: number }): Promise<DaytonaSandboxClient>
  get(sandboxIdOrName: string): Promise<DaytonaSandboxClient>
  list(query: { labels: Record<string, string>; limit: number }): AsyncIterable<{ id: string }>
  volume: {
    get(name: string, create?: boolean): Promise<{ id: string; state?: string | null }>
  }
}

export type DaytonaProviderDeps = {
  client?: DaytonaClient
  sleep?: (ms: number) => Promise<unknown>
  now?: () => number
  randomSuffix?: () => string
}

const maxSignedPreviewExpirySeconds = 60 * 60 * 24
const helperResources: SandboxResources = { cpu: 1, memoryGb: 1, diskGb: 4 }
const probeMountPath = "/mnt/openwork-probe"
const eraseMountRoot = "/mnt/openwork-erase"

const stateMap: Record<string, SandboxState> = {
  started: "running",
  stopped: "stopped",
  stopping: "stopping",
  archiving: "stopping",
  pausing: "stopping",
  paused: "stopped",
  archived: "archived",
  destroyed: "missing",
  destroying: "missing",
  error: "error",
  build_failed: "error",
  starting: "starting",
  resuming: "starting",
  restoring: "starting",
  creating: "creating",
  pulling_snapshot: "creating",
  pending_build: "creating",
  building_snapshot: "creating",
  resizing: "creating",
  snapshotting: "creating",
  forking: "creating",
}

export function mapDaytonaState(state: string | null | undefined): SandboxState {
  if (!state) return "error"
  return stateMap[state.toLowerCase()] ?? "error"
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function seconds(timeoutMs: number) {
  return Math.max(1, Math.ceil(timeoutMs / 1000))
}

function toSandboxClient(sandbox: Sandbox): DaytonaSandboxClient {
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

export function createDaytonaClient(config: Pick<DaytonaProviderConfig, "apiKey" | "apiUrl" | "target">): DaytonaClient {
  const daytona = new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    ...(config.target ? { target: config.target } : {}),
  })
  return {
    async create(params, options) {
      const sandbox = "image" in params
        ? await daytona.create(params, options)
        : await daytona.create(params, options)
      return toSandboxClient(sandbox)
    },
    async get(sandboxIdOrName) {
      return toSandboxClient(await daytona.get(sandboxIdOrName))
    },
    list(query) {
      return daytona.list(query)
    },
    volume: {
      get: (name, create) => daytona.volume.get(name, create),
    },
  }
}

export function createDaytonaProvider(config: DaytonaProviderConfig, deps: DaytonaProviderDeps = {}): SandboxProvider {
  const providerId = DAYTONA_PROVIDER_ID
  const client = deps.client ?? createDaytonaClient(config)
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const randomSuffix = deps.randomSuffix ?? (() => randomUUID().replace(/-/g, "").slice(0, 8))
  const sandboxes = new Map<string, DaytonaSandboxClient>()

  function wrap<T>(operation: () => Promise<T>): Promise<T> {
    return operation().catch((error: unknown) => {
      throw toRuntimeProviderError(error, providerId)
    })
  }

  function remember(sandbox: DaytonaSandboxClient) {
    sandboxes.set(sandbox.id, sandbox)
    return sandbox
  }

  function handleOf(sandbox: DaytonaSandboxClient): SandboxHandle {
    return {
      ref: { providerId, ref: { sandboxId: sandbox.id } },
      state: mapDaytonaState(sandbox.state),
      region: sandbox.target,
      observedAt: now(),
    }
  }

  function sandboxIdOf(ref: SandboxRef) {
    if (ref.providerId !== providerId) {
      throw new RuntimeProviderError({ providerId, code: "unknown", retryable: false, message: `sandbox reference belongs to provider ${ref.providerId}` })
    }
    const sandboxId = ref.ref.sandboxId
    if (!sandboxId) {
      throw new RuntimeProviderError({ providerId, code: "unknown", retryable: false, message: "sandbox reference is missing sandboxId" })
    }
    return sandboxId
  }

  async function resolve(handle: SandboxHandle) {
    const sandboxId = sandboxIdOf(handle.ref)
    return sandboxes.get(sandboxId) ?? remember(await wrap(() => client.get(sandboxId)))
  }

  async function getFresh(sandboxIdOrName: string) {
    try {
      const sandbox = remember(await client.get(sandboxIdOrName))
      await sandbox.refreshData()
      return sandbox
    } catch (error) {
      const mapped = toRuntimeProviderError(error, providerId)
      if (mapped.code === "not_found") return null
      throw mapped
    }
  }

  function createParams(spec: SandboxSpec): DaytonaCreateParams {
    const base = {
      name: spec.idempotencyKey,
      public: spec.public ?? false,
      labels: { ...spec.labels },
      envVars: { ...spec.env },
      volumes: spec.storage.map((attachment) => ({
        volumeId: attachment.volume.id,
        mountPath: attachment.mountPath,
        ...(attachment.subpath ? { subpath: attachment.subpath } : {}),
      })),
      ...(spec.ephemeral ? { ephemeral: true } : {}),
      ...(spec.lifecycle?.autoStopMinutes === undefined ? {} : { autoStopInterval: spec.lifecycle.autoStopMinutes }),
      ...(spec.lifecycle?.autoArchiveMinutes === undefined ? {} : { autoArchiveInterval: spec.lifecycle.autoArchiveMinutes }),
      ...(spec.lifecycle?.autoDeleteMinutes === undefined ? {} : { autoDeleteInterval: spec.lifecycle.autoDeleteMinutes }),
    }

    if (spec.image) {
      return { ...base, snapshot: spec.image.id }
    }

    const resources = spec.resources ?? config.resources
    return {
      ...base,
      image: config.image,
      resources: { cpu: resources.cpu, memory: resources.memoryGb, disk: resources.diskGb },
    }
  }

  function helperSpec(name: string, purpose: string, storage: SandboxSpec["storage"]): SandboxSpec {
    return {
      workerId: "",
      idempotencyKey: name,
      image: currentImage(),
      resources: helperResources,
      labels: {},
      env: { DEN_RUNTIME_PROVIDER: `${providerId}-${purpose}` },
      storage,
      exposePorts: [],
      lifecycle: { autoStopMinutes: 0, autoArchiveMinutes: 0, autoDeleteMinutes: 0 },
      ephemeral: true,
      public: false,
    }
  }

  async function runInHelper(spec: SandboxSpec, command: string, opts: ProviderTimeout) {
    const sandbox = remember(await wrap(() => client.create(createParams(spec), { timeout: seconds(opts.timeoutMs) })))
    try {
      const exec = await execOn(sandbox, { command: `sh -lc ${shellQuote(command)}`, detach: false, timeoutMs: opts.timeoutMs })
      return exec
    } finally {
      await wrap(() => sandbox.delete(seconds(opts.timeoutMs))).catch(() => undefined)
      sandboxes.delete(sandbox.id)
    }
  }

  async function execOn(sandbox: DaytonaSandboxClient, spec: ExecSpec): Promise<ExecHandle> {
    const sessionId = spec.sessionId ?? `openwork-exec-${randomSuffix()}`
    await wrap(() => sandbox.process.createSession(sessionId))
    const command = await wrap(() => sandbox.process.executeSessionCommand(
      sessionId,
      { command: spec.command, runAsync: spec.detach },
      spec.detach ? 0 : seconds(spec.timeoutMs),
    ))
    const handle: ExecHandle = {
      id: `${sessionId}/${command.cmdId}`,
      async exitCode() {
        const status = await wrap(() => sandbox.process.getSessionCommand(sessionId, command.cmdId))
        return typeof status.exitCode === "number" ? status.exitCode : null
      },
      async logs() {
        const logs = await wrap(() => sandbox.process.getSessionCommandLogs(sessionId, command.cmdId))
        return { stdout: logs.stdout ?? "", stderr: logs.stderr ?? "" }
      },
    }
    if (!spec.detach) {
      const startedAt = now()
      while (now() - startedAt < spec.timeoutMs) {
        if ((await handle.exitCode()) !== null) break
        await sleep(config.pollIntervalMs)
      }
    }
    return handle
  }

  function currentImage(): ImageRef | null {
    return config.snapshot ? { id: config.snapshot, version: config.snapshot } : null
  }

  const capabilities: ProviderCapabilities = {
    stopResume: true,
    persistentStorage: true,
    memorySnapshotRestore: false,
    warmPool: false,
    endpointKind: "signed-expiring",
    exec: true,
    regions: config.target ? [config.target] : [],
  }

  const storage: SandboxStorage = {
    async ensureVolume(name, opts) {
      const volumeName = slug(name).slice(0, 63)
      await wrap(() => client.volume.get(volumeName, true))
      const startedAt = now()
      while (now() - startedAt < opts.timeoutMs) {
        const volume = await wrap(() => client.volume.get(volumeName))
        if (volume.state === "ready") {
          return { providerId, id: volume.id, name: volumeName }
        }
        await sleep(config.pollIntervalMs)
      }
      throw new RuntimeProviderError({
        providerId,
        code: "timeout",
        message: `Timed out waiting for Daytona volume ${volumeName} to become ready`,
      })
    },
    async eraseSubpaths(volume, subpaths, opts) {
      if (subpaths.length === 0) return
      const mounts = subpaths.map((subpath, index) => ({
        volume,
        mountPath: `${eraseMountRoot}/${index}`,
        subpath,
      }))
      const script = [
        "node -e",
        shellQuote(
          [
            'const fs = require("node:fs")',
            'const path = require("node:path")',
            "for (const dir of process.argv.slice(1)) {",
            "  fs.mkdirSync(dir, { recursive: true })",
            "  for (const entry of fs.readdirSync(dir)) {",
            "    fs.rmSync(path.join(dir, entry), { recursive: true, force: true })",
            "  }",
            "}",
          ].join("; "),
        ),
        ...mounts.map((mount) => shellQuote(mount.mountPath)),
      ].join(" ")
      const exec = await runInHelper(
        { ...helperSpec(slug(`den-daytona-cleanup-${randomSuffix()}`).slice(0, 63), "cleanup", mounts), image: null },
        script,
        opts,
      )
      const exitCode = await exec.exitCode()
      if (exitCode !== 0) {
        const logs = await exec.logs().catch(() => ({ stdout: "", stderr: "" }))
        throw new RuntimeProviderError({
          providerId,
          code: "unknown",
          retryable: false,
          message: logs.stderr.trim() || logs.stdout.trim() || `cleanup command exited with ${exitCode ?? "no exit code"}`,
        })
      }
    },
    async exists(volume, path, opts) {
      const lastSlash = path.lastIndexOf("/")
      const directory = lastSlash === -1 ? "" : path.slice(0, lastSlash)
      const pattern = lastSlash === -1 ? path : path.slice(lastSlash + 1)
      const probe = /[*?]/.test(pattern)
        ? `test -n "$(find ${shellQuote(probeMountPath)} -maxdepth 1 -name ${shellQuote(pattern)} -print -quit 2>/dev/null)"`
        : `test -e ${shellQuote(`${probeMountPath}/${pattern}`)}`
      const exec = await runInHelper(
        helperSpec(
          slug(`den-daytona-probe-${randomSuffix()}`).slice(0, 63),
          "checkpoint-probe",
          [{ volume, mountPath: probeMountPath, ...(directory ? { subpath: directory } : {}) }],
        ),
        probe,
        opts,
      )
      return (await exec.exitCode()) === 0
    },
  }

  const provider: SandboxProvider = {
    id: providerId,
    describe: () => capabilities,
    currentImage,
    async create(spec, opts) {
      const sandbox = remember(await wrap(() => client.create(createParams(spec), { timeout: seconds(opts.timeoutMs) })))
      return handleOf(sandbox)
    },
    async find(query: SandboxQuery) {
      if (query.idempotencyKey) {
        const sandbox = await getFresh(query.idempotencyKey)
        return sandbox ? handleOf(sandbox) : null
      }
      if (query.labels) {
        const labels = query.labels
        const first = await wrap(async () => {
          for await (const entry of client.list({ labels: { ...labels }, limit: 100 })) {
            return entry
          }
          return null
        })
        if (!first) return null
        const sandbox = await getFresh(first.id)
        return sandbox ? handleOf(sandbox) : null
      }
      return null
    },
    async get(ref) {
      const sandbox = await getFresh(sandboxIdOf(ref))
      return sandbox ? handleOf(sandbox) : null
    },
    async inspect(handle) {
      try {
        const sandbox = await resolve(handle)
        await wrap(() => sandbox.refreshData())
        return handleOf(sandbox)
      } catch (error) {
        if (toRuntimeProviderError(error, providerId).code === "not_found") {
          return { ...handle, state: "missing", observedAt: now() }
        }
        throw error
      }
    },
    async start(handle, opts) {
      const sandbox = await resolve(handle)
      await wrap(() => sandbox.start(seconds(opts.timeoutMs)))
    },
    async stop(handle, opts) {
      const sandbox = await resolve(handle)
      await wrap(() => sandbox.stop(seconds(opts.timeoutMs)))
    },
    async destroy(handle, opts) {
      const sandbox = await resolve(handle)
      await wrap(() => sandbox.delete(seconds(opts.timeoutMs)))
      sandboxes.delete(sandbox.id)
    },
    async exec(handle, spec) {
      return execOn(await resolve(handle), spec)
    },
    async endpoint(handle, port, opts) {
      const sandbox = await resolve(handle)
      const ttlSeconds = Math.max(1, Math.min(opts?.ttlSeconds ?? maxSignedPreviewExpirySeconds, maxSignedPreviewExpirySeconds))
      const issuedAt = now()
      const preview = await wrap(() => sandbox.getSignedPreviewUrl(port, ttlSeconds))
      const endpoint: Endpoint = {
        url: preview.url,
        expiresAt: new Date(issuedAt + ttlSeconds * 1000),
        kind: "signed-expiring",
      }
      return endpoint
    },
    storage,
  }

  return provider
}
