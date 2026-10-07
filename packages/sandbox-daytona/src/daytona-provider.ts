import { randomUUID } from "node:crypto"
import { Daytona, type CreateSandboxFromImageParams, type CreateSandboxFromSnapshotParams, type Sandbox } from "@daytonaio/sdk"
import {
  RuntimeProviderError,
  shellQuote,
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
  type SandboxPlatform,
} from "@openwork/sandbox"
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
  helperCreateTimeoutMs: number
  /** Explicit platform for the configured snapshot; never inferred from its name. */
  platform?: SandboxPlatform
  /** Operator verified this Daytona class supports memory-preserving pause. */
  supportsPause?: boolean
}

/** The slice of the SDK the provider drives; production wraps `Daytona`, tests substitute. */
export type DaytonaSandboxClient = {
  readonly id: string
  readonly name?: string
  readonly state: string | null
  readonly target: string | null
  readonly labels?: Readonly<Record<string, string>>
  readonly public?: boolean
  readonly toolboxProxyUrl?: string
  refreshData(): Promise<unknown>
  start(timeoutSeconds?: number): Promise<unknown>
  stop(timeoutSeconds?: number): Promise<unknown>
  delete(timeoutSeconds?: number): Promise<unknown>
  pause?(timeoutSeconds?: number): Promise<unknown>
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<{ url: string }>
  fs: {
    createFolder(path: string, mode: string): Promise<unknown>
    uploadFile(source: Buffer, path: string, timeoutSeconds?: number): Promise<unknown>
    setFilePermissions(path: string, permissions: { mode?: string; owner?: string; group?: string }): Promise<unknown>
    deleteFile(path: string, recursive?: boolean): Promise<unknown>
    downloadFile?(path: string, timeoutSeconds?: number): Promise<Uint8Array>
    getFileDetails?(path: string): Promise<{ size: number; isDir: boolean }>
  }
  process: {
    createSession(sessionId: string): Promise<unknown>
    executeSessionCommand(sessionId: string, request: { command: string; runAsync: boolean; suppressInputEcho?: boolean }, timeoutSeconds?: number): Promise<{ cmdId: string }>
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
const sandboxCacheCapacity = 256
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
    get name() {
      return sandbox.name
    },
    get state() {
      return sandbox.state ?? null
    },
    get target() {
      return sandbox.target ?? null
    },
    get labels() {
      return sandbox.labels
    },
    get public() { return sandbox.public },
    get toolboxProxyUrl() { return sandbox.toolboxProxyUrl },
    refreshData: () => sandbox.refreshData(),
    start: (timeout) => sandbox.start(timeout),
    stop: (timeout) => sandbox.stop(timeout),
    delete: (timeout) => sandbox.delete(timeout),
    pause: (timeout) => sandbox.pause(timeout),
    getSignedPreviewUrl: (port, expiresInSeconds) => sandbox.getSignedPreviewUrl(port, expiresInSeconds),
    fs: {
      createFolder: (path, mode) => sandbox.fs.createFolder(path, mode),
      uploadFile: (source, path, timeout) => sandbox.fs.uploadFile(source, path, timeout),
      setFilePermissions: (path, permissions) => sandbox.fs.setFilePermissions(path, permissions),
      deleteFile: (path, recursive) => sandbox.fs.deleteFile(path, recursive),
      downloadFile: async (path, timeout) => new Uint8Array(await sandbox.fs.downloadFile(path, timeout)),
      getFileDetails: (path) => sandbox.fs.getFileDetails(path),
    },
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
  const sandboxes = new Map<string, { sandbox: DaytonaSandboxClient; name?: string }>()

  function wrap<T>(operation: () => Promise<T>): Promise<T> {
    return operation().catch((error: unknown) => {
      throw toRuntimeProviderError(error, providerId)
    })
  }

  function forget(sandboxIdOrName: string) {
    for (const [id, cached] of sandboxes) {
      if (id === sandboxIdOrName || cached.name === sandboxIdOrName || cached.sandbox.name === sandboxIdOrName) sandboxes.delete(id)
    }
  }

  function remember(sandbox: DaytonaSandboxClient, sandboxIdOrName = sandbox.id) {
    const name = sandboxIdOrName === sandbox.id ? sandboxes.get(sandbox.id)?.name : sandboxIdOrName
    sandboxes.delete(sandbox.id)
    if (mapDaytonaState(sandbox.state) === "missing") return sandbox
    sandboxes.set(sandbox.id, { sandbox, name })
    if (sandboxes.size > sandboxCacheCapacity) {
      const oldest = sandboxes.keys().next().value
      if (oldest !== undefined) sandboxes.delete(oldest)
    }
    return sandbox
  }

  function handleOf(sandbox: DaytonaSandboxClient): SandboxHandle {
    const state = mapDaytonaState(sandbox.state)
    if (state === "missing") forget(sandbox.id)
    return {
      ref: { providerId, ref: { sandboxId: sandbox.id } },
      name: sandbox.name,
      state,
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
    const cached = sandboxes.get(sandboxId)
    if (cached) return remember(cached.sandbox)
    try {
      return remember(await client.get(sandboxId), sandboxId)
    } catch (error) {
      const mapped = toRuntimeProviderError(error, providerId)
      if (mapped.code === "not_found") forget(sandboxId)
      throw mapped
    }
  }

  async function getFresh(sandboxIdOrName: string) {
    let sandbox: DaytonaSandboxClient | undefined
    try {
      sandbox = await client.get(sandboxIdOrName)
      await sandbox.refreshData()
      return remember(sandbox, sandboxIdOrName)
    } catch (error) {
      const mapped = toRuntimeProviderError(error, providerId)
      if (mapped.code === "not_found") {
        forget(sandboxIdOrName)
        if (sandbox) forget(sandbox.id)
        return null
      }
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

  async function runInHelper(spec: SandboxSpec, command: string, opts: ProviderTimeout, createTimeoutMs = opts.timeoutMs) {
    const sandbox = remember(await wrap(() => client.create(createParams(spec), { timeout: seconds(createTimeoutMs) })), spec.idempotencyKey)
    try {
      const exec = await execOn(sandbox, { command: `sh -lc ${shellQuote(command)}`, detach: false, timeoutMs: opts.timeoutMs })
      // The helper's toolbox disappears on deletion; capture the result first.
      return {
        exitCode: await exec.exitCode(),
        logs: await exec.logs().catch(() => ({ stdout: "", stderr: "" })),
      }
    } finally {
      await wrap(() => sandbox.delete(seconds(opts.timeoutMs))).catch(() => undefined)
      forget(sandbox.id)
    }
  }

  async function boundedScriptOperation<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => RuntimeProviderError): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(onTimeout()), timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function execScript(sandbox: DaytonaSandboxClient, sessionId: string, spec: ExecSpec & { script: string }) {
    const directory = `/tmp/openwork-exec-${randomUUID()}`
    const path = `${directory}/script.sh`
    const timeoutMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : 30_000
    const deadline = now() + timeoutMs
    let pending: Promise<unknown> = Promise.resolve()
    let directoryCreated = false
    let uploadAttempted = false
    let uploadAcknowledged = false
    let launchAttempted = false
    let phase = "directory creation"

    function timedOut() {
      return new RuntimeProviderError({
        providerId,
        code: "timeout",
        retryable: !launchAttempted,
        message: `Timed out during Daytona script ${phase}`,
      })
    }

    async function run<T>(operation: (timeoutSeconds: number) => Promise<T>): Promise<T> {
      const remainingMs = deadline - now()
      if (remainingMs <= 0) throw timedOut()
      const promise = operation(remainingMs / 1000)
      pending = promise
      return boundedScriptOperation(promise, remainingMs, timedOut)
    }

    try {
      await run(async () => {
        await sandbox.fs.createFolder(directory, "700")
        directoryCreated = true
      })
      phase = "upload"
      const script = `set +xv\nrm -f -- "$0" || exit 1\nrmdir -- ${shellQuote(directory)} 2>/dev/null || true\n${spec.script}\n`
      await run(async (timeout) => {
        uploadAttempted = true
        await sandbox.fs.uploadFile(Buffer.from(script), path, timeout)
        uploadAcknowledged = true
      })
      phase = "permissions"
      await run(() => sandbox.fs.setFilePermissions(path, { mode: "600" }))
      phase = "session creation"
      await run(() => sandbox.process.createSession(sessionId))
      phase = "launch"
      return await run((timeout) => {
        launchAttempted = true
        return sandbox.process.executeSessionCommand(sessionId, {
          command: `sh -lc ${shellQuote(`exec sh ${path}`)}`,
          runAsync: spec.detach,
          suppressInputEcho: true,
        }, timeout)
      })
    } catch (error) {
      const mapped = toRuntimeProviderError(error, providerId)
      const failure = new RuntimeProviderError({
        providerId,
        code: mapped.code,
        retryable: launchAttempted || (uploadAttempted && !uploadAcknowledged) ? false : mapped.retryable,
        message: launchAttempted
          ? `Daytona script launch outcome is unknown (${mapped.code}); inspect the session before retrying`
          : `Daytona script ${phase} failed (${mapped.code})`,
      })
      if (!launchAttempted) {
        const cleanup = pending.catch(() => undefined).then(async () => {
          if (!directoryCreated) return
          if (uploadAttempted && !uploadAcknowledged) await sandbox.fs.deleteFile(path, false)
          else await sandbox.fs.deleteFile(directory, true)
        })
        await boundedScriptOperation(cleanup, Math.min(timeoutMs, 5_000), () => failure).catch(() => undefined)
      }
      throw failure
    }
  }

  async function execOn(sandbox: DaytonaSandboxClient, spec: ExecSpec): Promise<ExecHandle> {
    const sessionId = spec.sessionId ?? `openwork-exec-${randomSuffix()}`
    let command: { cmdId: string }
    if (spec.script === undefined) {
      await wrap(() => sandbox.process.createSession(sessionId))
      command = await wrap(() => sandbox.process.executeSessionCommand(
        sessionId,
        { command: spec.command, runAsync: spec.detach },
        spec.detach ? 0 : seconds(spec.timeoutMs),
      ))
    } else {
      command = await execScript(sandbox, sessionId, spec)
    }
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
    ...(config.platform ? { platform: config.platform } : {}),
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
      const { exitCode, logs } = await runInHelper(
        { ...helperSpec(slug(`den-daytona-cleanup-${randomSuffix()}`).slice(0, 63), "cleanup", mounts), image: null },
        script,
        opts,
        config.helperCreateTimeoutMs,
      )
      if (exitCode !== 0) {
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
      const result = await runInHelper(
        helperSpec(
          slug(`den-daytona-probe-${randomSuffix()}`).slice(0, 63),
          "checkpoint-probe",
          [{ volume, mountPath: probeMountPath, ...(directory ? { subpath: directory } : {}) }],
        ),
        probe,
        opts,
      )
      return result.exitCode === 0
    },
  }

  const provider: SandboxProvider = {
    id: providerId,
    describe: () => capabilities,
    currentImage,
    async create(spec, opts) {
      const sandbox = remember(await wrap(() => client.create(createParams(spec), { timeout: seconds(opts.timeoutMs) })), spec.idempotencyKey)
      return handleOf(sandbox)
    },
    async find(query: SandboxQuery) {
      let sandbox: DaytonaSandboxClient | null = null
      if (query.idempotencyKey) {
        sandbox = await getFresh(query.idempotencyKey)
      } else if (query.labels) {
        const labels = query.labels
        const first = await wrap(async () => {
          for await (const entry of client.list({ labels: { ...labels }, limit: 100 })) {
            return entry
          }
          return null
        })
        if (!first) return null
        sandbox = await getFresh(first.id)
      }
      if (!sandbox || (query.labels && Object.entries(query.labels).some(([key, value]) => sandbox.labels?.[key] !== value))) {
        return null
      }
      return handleOf(sandbox)
    },
    async list(query: SandboxQuery) {
      if (query.idempotencyKey) {
        const found = await provider.find(query)
        return found ? [found] : []
      }
      const matches: SandboxHandle[] = []
      const labels = query.labels ?? {}
      return wrap(async () => {
        const seen = new Set<string>()
        // Exhaust the iterator before callers delete anything and shift its pages.
        for await (const entry of client.list({ labels: { ...labels }, limit: 100 })) {
          if (seen.has(entry.id)) continue
          seen.add(entry.id)
          const sandbox = await getFresh(entry.id)
          if (!sandbox || Object.entries(labels).some(([key, value]) => sandbox.labels?.[key] !== value)) continue
          matches.push(handleOf(sandbox))
        }
        return matches
      })
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
          forget(sandboxIdOf(handle.ref))
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
      let sandboxId = sandboxIdOf(handle.ref)
      try {
        const sandbox = await resolve(handle)
        sandboxId = sandbox.id
        await wrap(() => sandbox.delete(seconds(opts.timeoutMs)))
      } finally {
        forget(sandboxId)
      }
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
    // Existing Web instances leave platform unset. Opting in to a verified
    // Linux flavor enables the POSIX process block; no Windows shell guessing.
    blocks: {
      ...(config.platform?.os === "linux" ? {
        run: async (handle, spec) => {
          if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "timeoutMs must be positive" })
          return boundedScriptOperation((async () => {
            if (spec.shell && spec.shell !== "sh") throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "This Daytona flavor supports sh only" })
            const env = Object.entries(spec.env ?? {}).map(([key, value]) => {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "Invalid environment variable name" })
              return `${key}=${shellQuote(value)}`
            })
            const command = `${spec.cwd ? `cd ${shellQuote(spec.cwd)} && ` : ""}exec env ${env.join(" ")} sh -c ${shellQuote(spec.command)}`
            const sandbox = await resolve(handle)
            const download = sandbox.fs.downloadFile
            if (!download) throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "Exact run output requires file downloads" })
            const directory = `/tmp/openwork-run-${randomUUID()}`
            await wrap(() => sandbox.fs.createFolder(directory, "700"))
            let completed = false
            try {
              // Session logs normalize line endings. Capture process streams as
              // bytes so run preserves trailing whitespace and separates stderr.
              const script = `(${command}) >${shellQuote(`${directory}/stdout`)} 2>${shellQuote(`${directory}/stderr`)}`
              const exec = await execOn(sandbox, { script, detach: false, timeoutMs: spec.timeoutMs })
              const exitCode = await exec.exitCode()
              if (exitCode === null) throw new RuntimeProviderError({ providerId, code: "timeout", retryable: false, message: "Command has not exited; execution outcome is unknown, do not retry" })
              completed = true
              const stdout = await wrap(() => download(`${directory}/stdout`, seconds(spec.timeoutMs)))
              const stderr = await wrap(() => download(`${directory}/stderr`, seconds(spec.timeoutMs)))
              return { exitCode, stdout: Buffer.from(stdout).toString("utf8"), stderr: Buffer.from(stderr).toString("utf8") }
            } finally {
              // An unacknowledged launch might still write these files. Do not
              // delete them or repeat the command while its outcome is unknown.
              if (completed) await wrap(() => sandbox.fs.deleteFile(directory, true)).catch(() => undefined)
            }
          })(), spec.timeoutMs, () => new RuntimeProviderError({ providerId, code: "timeout", retryable: false, message: "Run exceeded its deadline; execution outcome may be unknown, do not retry" }))
        },
      } : {}),
      files: {
        async read(handle, path, opts) {
          const sandbox = await resolve(handle)
          const download = sandbox.fs.downloadFile
          if (!download) throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "Client does not implement file downloads" })
          return wrap(() => download(path, seconds(opts.timeoutMs)))
        },
        async write(handle, path, bytes, opts) {
          if (opts.mode !== undefined && (!Number.isInteger(opts.mode) || opts.mode < 0 || opts.mode > 0o777)) throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "File mode must be 000-777" })
          const sandbox = await resolve(handle)
          await wrap(() => sandbox.fs.uploadFile(Buffer.from(bytes), path, seconds(opts.timeoutMs)))
          const mode = opts.mode
          if (mode !== undefined) await wrap(() => sandbox.fs.setFilePermissions(path, { mode: mode.toString(8).padStart(3, "0") }))
        },
        async stat(handle, path, opts) {
          const sandbox = await resolve(handle)
          const details = sandbox.fs.getFileDetails
          if (!details) throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "Client does not implement file metadata" })
          try {
            const info = await boundedScriptOperation(wrap(() => details(path)), opts.timeoutMs, () => new RuntimeProviderError({ providerId, code: "timeout", message: "File metadata timed out", retryable: false }))
            return { size: info.size, kind: info.isDir ? "directory" : "file" }
          } catch (error) {
            // A missing sandbox is NOT a missing file.
            if (toRuntimeProviderError(error, providerId).code === "not_found" && await provider.get(handle.ref)) return null
            throw error
          }
        },
      },
      ...(config.supportsPause ? {
        pause: async (handle, opts) => {
          const sandbox = await resolve(handle)
          const pause = sandbox.pause
          if (!pause) throw new RuntimeProviderError({ providerId, code: "invalid_state", retryable: false, message: "Client does not implement pause" })
          await wrap(() => pause(seconds(opts.timeoutMs)))
        },
      } : {}),
    },
  }

  return provider
}
