import { Freestyle, FreestyleApiError, type VmData, type CreateVmOptions } from "freestyle"
import { SandboxError, shellQuote, type SandboxProvider, type SandboxHandle, type SandboxRef, type SandboxQuery, type SandboxState, type RunSpec, type RunResult } from "@openwork/sandbox"

export type FreestyleProviderOptions = {
  apiKey?: string
  snapshot: string
  /** Provider-native creation settings for preview jobs; identity and ownership stay in SandboxSpec. */
  createOptions?: Pick<CreateVmOptions, "displayName" | "ttlSeconds" | "tls" | "placement">
  linuxUser?: string
  /** Required: Freestyle never grants network access implicitly. */
  firewall: NonNullable<Parameters<Freestyle["vms"]["create"]>[0]["firewall"]>
  /** Provider-specific endpoint composition (TLS/domains), not assumed by compute. */
  endpoint?: SandboxProvider["endpoint"]
}
export type FreestyleProviderDeps = { client?: Pick<Freestyle, "vms">; now?: () => number }

export function freestyleError(error: unknown): SandboxError {
  if (error instanceof SandboxError) return error
  const status = error instanceof FreestyleApiError ? error.status : null
  const code = status === 404 ? "not_found" : status === 409 ? "conflict" : status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limited" : status !== null && status >= 500 ? "transient" : "unknown"
  return new SandboxError({ providerId: "freestyle", code, message: error instanceof Error ? error.message : String(error), cause: error })
}

/** Freestyle Linux VM compute with optional process/files/pause/snapshot blocks. */
export function createFreestyleProvider(options: FreestyleProviderOptions, deps: FreestyleProviderDeps = {}): SandboxProvider {
  const api = deps.client ?? (options.apiKey ? new Freestyle({ apiKey: options.apiKey }) : (() => { throw new Error("Freestyle requires apiKey or an injected client") })())
  const now = deps.now ?? Date.now
  const id = "freestyle"
  const unsupported = (feature: string): never => { throw new SandboxError({ providerId: id, code: "invalid_state", retryable: false, message: `Freestyle adapter does not provide ${feature}` }) }
  const identity = (ref: SandboxRef) => {
    if (ref.providerId !== id || !ref.ref.vmId) unsupported("this sandbox reference")
    return ref.ref.vmId
  }
  function state(value: VmData["state"]): SandboxState {
    if (value === "paused") return "stopped" // start resumes memory; pause block distinguishes it from a cold stop
    if (value === "pausing") return "stopping"
    return value
  }
  function handle(data: VmData): SandboxHandle {
    return { ref: { providerId: id, ref: { vmId: data.id } }, name: data.slug ?? undefined, state: state(data.state), region: null, observedAt: now() }
  }
  async function mapped<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn() } catch (error) { throw freestyleError(error) }
  }
  async function bounded<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) unsupported("non-positive timeouts")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([mapped(fn), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SandboxError({ providerId: id, code: "timeout", retryable: false, message: "Operation exceeded its deadline; outcome may be unknown" })), timeoutMs)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  async function run(h: SandboxHandle, spec: RunSpec): Promise<RunResult> {
    if (spec.shell && spec.shell !== "sh") unsupported("PowerShell")
    const command = `${spec.cwd ? `cd ${shellQuote(spec.cwd)} && ` : ""}exec sh -c ${shellQuote(spec.command)}`
    const result = await bounded(() => api.vms.ref(identity(h.ref)).exec({ command, env: { ...spec.env }, ...(options.linuxUser ? { linuxUser: options.linuxUser } : {}), timeoutMs: spec.timeoutMs }), spec.timeoutMs)
    if (typeof result.statusCode !== "number") throw new SandboxError({ providerId: id, code: "timeout", retryable: false, message: "Command did not return an exit code; do not retry automatically" })
    return { exitCode: result.statusCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  }
  function matches(data: VmData, query: SandboxQuery) {
    return (!query.idempotencyKey || data.slug === query.idempotencyKey) && Object.entries(query.labels ?? {}).every(([k, v]) => data.metadata[k] === v)
  }
  const provider: SandboxProvider = {
    id,
    describe: () => ({ stopResume: true, persistentStorage: false, memorySnapshotRestore: true, warmPool: false, endpointKind: "stable", exec: true, regions: [], createEnvironment: false, detachedExec: false, endpoints: Boolean(options.endpoint), platform: { os: "linux", isolation: "vm" } }),
    currentImage: () => ({ id: options.snapshot, version: options.snapshot }),
    async create(spec, opts) {
      if (spec.storage.length || spec.resources || spec.lifecycle?.autoArchiveMinutes !== undefined) unsupported("storage attachments, resource overrides or auto-archive")
      if (Object.keys(spec.env).length) unsupported("create-time env; use run.env")
      const response = await bounded(() => api.vms.create({
        ...options.createOptions,
        snapshotId: spec.image?.id ?? options.snapshot,
        slug: spec.idempotencyKey,
        metadata: { ...spec.labels },
        firewall: options.firewall,
        ...(spec.lifecycle?.autoStopMinutes === undefined ? {} : { idleTimeoutSeconds: spec.lifecycle.autoStopMinutes === 0 ? -1 : spec.lifecycle.autoStopMinutes * 60 }),
        ...(spec.lifecycle?.autoDeleteMinutes === undefined ? {} : { autoDeleteSeconds: spec.lifecycle.autoDeleteMinutes < 0 ? -1 : spec.lifecycle.autoDeleteMinutes * 60 }),
        ...(spec.ephemeral ? { autoDeleteSeconds: 0 } : {}),
      }), opts.timeoutMs)
      const h = handle(response.data)
      return h
    },
    async list(query) {
      const result: SandboxHandle[] = []
      let offset = 0
      while (true) {
        const page = await mapped(() => api.vms.list({ ...(query.idempotencyKey ? { slug: query.idempotencyKey } : {}), offset, limit: 100 }))
        for (const data of page.vms) if (matches(data, query)) result.push(handle(data))
        offset += page.vms.length
        if (!page.vms.length || offset >= page.totalCount) return result
      }
    },
    async find(query) {
      const key = query.idempotencyKey
      if (key) {
        try {
          const data = await mapped(() => api.vms.get(key))
          return matches(data, query) ? handle(data) : null
        } catch (error) { if (freestyleError(error).code === "not_found") return null; throw error }
      }
      return (await provider.list(query))[0] ?? null
    },
    async get(ref) {
      try { return handle(await mapped(() => api.vms.get(identity(ref)))) }
      catch (error) { if (freestyleError(error).code === "not_found") return null; throw error }
    },
    async inspect(h) { return await provider.get(h.ref) ?? { ...h, state: "missing", observedAt: now() } },
    async start(h, opts) { await bounded(() => api.vms.ref(identity(h.ref)).start(), opts.timeoutMs) },
    async stop(h, opts) { await bounded(() => api.vms.ref(identity(h.ref)).pause(), opts.timeoutMs) },
    async destroy(h, opts) { await bounded(() => api.vms.delete(identity(h.ref)), opts.timeoutMs) },
    async exec(h, spec) {
      if (spec.detach) unsupported("detached exec; use the job's background-process helper")
      const result = await run(h, { command: spec.command ?? spec.script ?? "", timeoutMs: spec.timeoutMs })
      return { id: `freestyle-exec-${now()}`, exitCode: async () => result.exitCode, logs: async () => ({ stdout: result.stdout, stderr: result.stderr }) }
    },
    endpoint: options.endpoint ?? (async () => unsupported("endpoints without an endpoint binding")),
    storage: { ensureVolume: async () => unsupported("volumes"), eraseSubpaths: async () => unsupported("volumes") },
    blocks: {
      run,
      files: {
        async read(h, path, opts) { return bounded(() => api.vms.ref(identity(h.ref)).fs.readFile(path, { signal: AbortSignal.timeout(opts.timeoutMs) }), opts.timeoutMs) },
        async write(h, path, bytes, opts) { await bounded(() => api.vms.ref(identity(h.ref)).fs.writeFile(path, bytes, { signal: AbortSignal.timeout(opts.timeoutMs), ...(opts.mode === undefined ? {} : { mode: opts.mode }) }), opts.timeoutMs) },
        async stat(h, path, opts) {
          const vm = api.vms.ref(identity(h.ref))
          try {
            const info = await bounded(() => vm.fs.stat(path), opts.timeoutMs)
            if (!info.isFile && !info.isDirectory) unsupported("symlink metadata")
            return { size: info.size, kind: info.isFile ? "file" : "directory" }
          } catch (error) {
            if (freestyleError(error).code === "not_found" && await provider.get(h.ref)) return null
            throw error
          }
        },
      },
      pause: async (h, opts) => { await bounded(() => api.vms.ref(identity(h.ref)).pause(), opts.timeoutMs) },
      snapshots: { async create(h, name, opts) {
        const snap = await bounded(() => api.vms.ref(identity(h.ref)).snapshot({ slug: name }), opts.timeoutMs)
        return { id: snap.snapshotId, version: name }
      }, async destroy(image, opts) { await bounded(() => api.vms.snapshots.delete(image.id), opts.timeoutMs) } },
    },
  }
  return provider
}
