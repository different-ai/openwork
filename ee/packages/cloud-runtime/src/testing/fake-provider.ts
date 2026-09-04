import { RuntimeProviderError } from "../contract/errors"
import type {
  Endpoint,
  ExecHandle,
  ExecSpec,
  ImageRef,
  ProviderCapabilities,
  ProviderTimeout,
  SandboxHandle,
  SandboxProvider,
  SandboxQuery,
  SandboxRef,
  SandboxSpec,
  SandboxState,
  SandboxStorage,
  VolumeRef,
} from "../contract/provider"

export type FakeExecResult = {
  exitCode: number | null
  stdout?: string
  stderr?: string
}

export type FakeOperationName =
  | "create"
  | "find"
  | "get"
  | "inspect"
  | "start"
  | "stop"
  | "destroy"
  | "exec"
  | "endpoint"
  | "storage.ensureVolume"
  | "storage.eraseSubpaths"
  | "storage.exists"

export type FakeOperation = {
  name: FakeOperationName
  /** Per-operation-name call count, starting at 1. */
  attempt: number
  sandboxId?: string
  idempotencyKey?: string
}

export type FakeProviderOptions = {
  id?: string
  capabilities?: Partial<ProviderCapabilities>
  image?: ImageRef | null
  region?: string
  endpointTtlSeconds?: number
  now?: () => number
  /** Decide what a command does; defaults to exit 0 with no output. */
  onExec?: (input: { sandboxId: string; spec: ExecSpec }) => FakeExecResult | Promise<FakeExecResult>
  /**
   * Consulted before every operation. Throw to fail the operation (typically a
   * `RuntimeProviderError`); mutate the fake through `provider.fake` to model
   * a host that changes state underneath the orchestrator.
   */
  onOperation?: (operation: FakeOperation) => void | Promise<void>
}

export type FakeSandboxRecord = {
  id: string
  spec: SandboxSpec
  state: SandboxState
  region: string
  createdAt: number
  execs: Array<{ id: string; spec: ExecSpec; result: FakeExecResult }>
}

export type FakeProvider = SandboxProvider & {
  /** Test-side controls that no production caller sees. */
  readonly fake: {
    sandboxes(): FakeSandboxRecord[]
    sandbox(idempotencyKey: string): FakeSandboxRecord | null
    /** Register an instance the host already has, bypassing hooks and counters. */
    seed(input: { idempotencyKey: string; state: SandboxState; workerId?: string; labels?: Record<string, string>; hidden?: boolean }): FakeSandboxRecord
    setState(sandboxId: string, state: SandboxState): void
    /** Hidden instances are invisible to `find` and `get` (read-after-write lag). */
    setVisible(sandboxId: string, visible: boolean): void
    count(operation: FakeOperationName, sandboxId?: string): number
    volumeFiles(volumeName: string): Set<string>
    /** Simulate a file the bootstrap wrote onto a persistent volume. */
    writeVolumeFile(volumeName: string, path: string): void
    calls: string[]
  }
}

const defaultCapabilities: ProviderCapabilities = {
  stopResume: true,
  persistentStorage: true,
  memorySnapshotRestore: false,
  warmPool: false,
  endpointKind: "signed-expiring",
  exec: true,
  regions: ["fake-1"],
}

export function createFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const providerId = options.id ?? "fake"
  const capabilities: ProviderCapabilities = { ...defaultCapabilities, ...options.capabilities }
  const region = options.region ?? capabilities.regions[0] ?? "fake-1"
  const now = options.now ?? Date.now
  const endpointTtlSeconds = options.endpointTtlSeconds ?? 3600
  const image = options.image === undefined ? { id: "fake-image", version: "fake-image" } : options.image
  const sandboxes = new Map<string, FakeSandboxRecord>()
  const volumes = new Map<string, { ref: VolumeRef; files: Set<string> }>()
  const calls: string[] = []
  const attempts = new Map<FakeOperationName, number>()
  const hidden = new Set<string>()
  let sequence = 0

  async function before(name: FakeOperationName, detail: Omit<FakeOperation, "name" | "attempt"> = {}) {
    const attempt = (attempts.get(name) ?? 0) + 1
    attempts.set(name, attempt)
    await options.onOperation?.({ name, attempt, ...detail })
  }

  function fail(code: RuntimeProviderError["code"], message: string, retryable?: boolean): never {
    throw new RuntimeProviderError({ providerId, code, message, retryable })
  }

  function handleOf(record: FakeSandboxRecord): SandboxHandle {
    return {
      ref: { providerId, ref: { sandboxId: record.id } },
      state: record.state,
      region: record.region,
      observedAt: now(),
    }
  }

  function recordFor(ref: SandboxRef) {
    if (ref.providerId !== providerId) {
      fail("unknown", `sandbox reference belongs to provider ${ref.providerId}, not ${providerId}`, false)
    }
    const id = ref.ref.sandboxId
    return id ? sandboxes.get(id) ?? null : null
  }

  function requireRecord(handle: SandboxHandle) {
    const record = recordFor(handle.ref)
    if (!record || record.state === "missing") {
      fail("not_found", `sandbox ${handle.ref.ref.sandboxId ?? "?"} not found`, false)
    }
    return record
  }

  function volumeRecord(volume: VolumeRef) {
    const entry = volumes.get(volume.name)
    if (!entry || entry.ref.id !== volume.id) {
      fail("not_found", `volume ${volume.name} not found`, false)
    }
    return entry
  }

  const storage: SandboxStorage = {
    async ensureVolume(name, _opts: ProviderTimeout) {
      calls.push(`storage.ensureVolume:${name}`)
      await before("storage.ensureVolume")
      const existing = volumes.get(name)
      if (existing) return existing.ref
      const ref: VolumeRef = { providerId, id: `vol-${++sequence}`, name }
      volumes.set(name, { ref, files: new Set() })
      return ref
    },
    async eraseSubpaths(volume, subpaths, _opts) {
      calls.push(`storage.eraseSubpaths:${volume.name}:${subpaths.join(",")}`)
      await before("storage.eraseSubpaths")
      const entry = volumeRecord(volume)
      for (const file of Array.from(entry.files)) {
        if (subpaths.some((subpath) => file === subpath || file.startsWith(`${subpath}/`))) {
          entry.files.delete(file)
        }
      }
    },
    async exists(volume, path, _opts) {
      calls.push(`storage.exists:${volume.name}:${path}`)
      await before("storage.exists")
      const files = volumeRecord(volume).files
      const lastSlash = path.lastIndexOf("/")
      const directory = lastSlash === -1 ? "" : path.slice(0, lastSlash)
      const pattern = lastSlash === -1 ? path : path.slice(lastSlash + 1)
      if (!/[*?]/.test(pattern)) return files.has(path)
      const matcher = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)
      return Array.from(files).some((file) => {
        const fileSlash = file.lastIndexOf("/")
        const fileDirectory = fileSlash === -1 ? "" : file.slice(0, fileSlash)
        return fileDirectory === directory && matcher.test(file.slice(fileSlash + 1))
      })
    },
  }

  const provider: FakeProvider = {
    id: providerId,
    describe: () => capabilities,
    currentImage: () => image,
    async create(spec, _opts) {
      calls.push(`create:${spec.idempotencyKey}`)
      await before("create", { idempotencyKey: spec.idempotencyKey })
      for (const record of sandboxes.values()) {
        if (record.spec.idempotencyKey === spec.idempotencyKey && record.state !== "missing") {
          fail("conflict", `sandbox ${spec.idempotencyKey} already exists`, false)
        }
      }
      for (const attachment of spec.storage) {
        volumeRecord(attachment.volume)
      }
      const record: FakeSandboxRecord = {
        id: `sbx-${++sequence}`,
        spec,
        state: "running",
        region,
        createdAt: now(),
        execs: [],
      }
      sandboxes.set(record.id, record)
      return handleOf(record)
    },
    async find(query: SandboxQuery) {
      calls.push(`find:${query.idempotencyKey ?? JSON.stringify(query.labels ?? {})}`)
      await before("find", { idempotencyKey: query.idempotencyKey })
      for (const record of sandboxes.values()) {
        if (record.state === "missing" || hidden.has(record.id)) continue
        if (query.idempotencyKey !== undefined && record.spec.idempotencyKey !== query.idempotencyKey) continue
        if (query.labels && Object.entries(query.labels).some(([key, value]) => record.spec.labels[key] !== value)) continue
        return handleOf(record)
      }
      return null
    },
    async get(ref) {
      calls.push(`get:${ref.ref.sandboxId ?? "?"}`)
      await before("get", { sandboxId: ref.ref.sandboxId })
      const record = recordFor(ref)
      return record && record.state !== "missing" && !hidden.has(record.id) ? handleOf(record) : null
    },
    async inspect(handle) {
      calls.push(`inspect:${handle.ref.ref.sandboxId ?? "?"}`)
      await before("inspect", { sandboxId: handle.ref.ref.sandboxId })
      const record = recordFor(handle.ref)
      return record ? handleOf(record) : { ...handle, state: "missing", observedAt: now() }
    },
    async start(handle, _opts) {
      calls.push(`start:${handle.ref.ref.sandboxId ?? "?"}`)
      await before("start", { sandboxId: handle.ref.ref.sandboxId })
      const record = requireRecord(handle)
      if (record.state === "stopping" || record.state === "creating") {
        fail("invalid_state", `sandbox ${record.id} state change in progress`)
      }
      record.state = "running"
    },
    async stop(handle, _opts) {
      calls.push(`stop:${handle.ref.ref.sandboxId ?? "?"}`)
      await before("stop", { sandboxId: handle.ref.ref.sandboxId })
      const record = requireRecord(handle)
      record.state = "stopped"
    },
    async destroy(handle, _opts) {
      calls.push(`destroy:${handle.ref.ref.sandboxId ?? "?"}`)
      await before("destroy", { sandboxId: handle.ref.ref.sandboxId })
      const record = requireRecord(handle)
      record.state = "missing"
    },
    async exec(handle, spec) {
      calls.push(`exec:${handle.ref.ref.sandboxId ?? "?"}`)
      await before("exec", { sandboxId: handle.ref.ref.sandboxId })
      const record = requireRecord(handle)
      if (record.state !== "running") {
        fail("invalid_state", `sandbox ${record.id} is ${record.state}`, false)
      }
      const result = options.onExec
        ? await options.onExec({ sandboxId: record.id, spec })
        : { exitCode: 0 }
      const exec = { id: `exec-${++sequence}`, spec, result }
      record.execs.push(exec)
      const execHandle: ExecHandle = {
        id: exec.id,
        exitCode: async () => exec.result.exitCode,
        logs: async () => ({ stdout: exec.result.stdout ?? "", stderr: exec.result.stderr ?? "" }),
      }
      return execHandle
    },
    async endpoint(handle, port, opts) {
      calls.push(`endpoint:${handle.ref.ref.sandboxId ?? "?"}:${port}`)
      await before("endpoint", { sandboxId: handle.ref.ref.sandboxId })
      const record = requireRecord(handle)
      const ttl = opts?.ttlSeconds ?? endpointTtlSeconds
      const endpoint: Endpoint = {
        url: `http://${record.id}.${providerId}.invalid:${port}`,
        expiresAt: capabilities.endpointKind === "stable" ? null : new Date(now() + ttl * 1000),
        kind: capabilities.endpointKind,
      }
      return endpoint
    },
    storage,
    fake: {
      sandboxes: () => Array.from(sandboxes.values()),
      sandbox: (idempotencyKey) =>
        Array.from(sandboxes.values()).find((record) => record.spec.idempotencyKey === idempotencyKey && record.state !== "missing") ?? null,
      seed: (input) => {
        const record: FakeSandboxRecord = {
          id: `sbx-${++sequence}`,
          spec: {
            workerId: input.workerId ?? `worker-${input.idempotencyKey}`,
            idempotencyKey: input.idempotencyKey,
            image,
            labels: input.labels ?? {},
            env: {},
            storage: [],
            exposePorts: [],
          },
          state: input.state,
          region,
          createdAt: now(),
          execs: [],
        }
        sandboxes.set(record.id, record)
        if (input.hidden) hidden.add(record.id)
        return record
      },
      setState: (sandboxId, state) => {
        const record = sandboxes.get(sandboxId)
        if (!record) throw new Error(`fake sandbox ${sandboxId} does not exist`)
        record.state = state
      },
      setVisible: (sandboxId, visible) => {
        if (visible) hidden.delete(sandboxId)
        else hidden.add(sandboxId)
      },
      count: (operation, sandboxId) =>
        calls.filter((call) => call === operation || call.startsWith(`${operation}:`))
          .filter((call) => sandboxId === undefined || call.split(":")[1] === sandboxId)
          .length,
      volumeFiles: (volumeName) => {
        const entry = volumes.get(volumeName)
        if (!entry) throw new Error(`fake volume ${volumeName} does not exist`)
        return entry.files
      },
      writeVolumeFile: (volumeName, path) => {
        const entry = volumes.get(volumeName)
        if (!entry) throw new Error(`fake volume ${volumeName} does not exist`)
        entry.files.add(path)
      },
      calls,
    },
  }

  return provider
}
