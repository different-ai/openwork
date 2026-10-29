import { SandboxError, shellQuote, type ImageRef, type RunResult, type RunSpec, type SandboxErrorCode, type SandboxHandle, type SandboxPlatform, type SandboxProvider, type SandboxQuery, type SandboxRef, type SandboxSpec, type SandboxState } from "@openwork/sandbox"

export const DIFFERENTLY_PROVIDER_ID = "differently"

/**
 * One Differently installation, reached with a project-scoped API key. Differently holds the
 * OpenSandbox, Daytona and Freestyle credentials and places each sandbox by its own policies;
 * the options here can only narrow that placement, never widen it.
 */
export type DifferentlyProviderOptions = {
  /** API base URL, e.g. https://differently.example.com */
  url: string
  apiKey: string
  /** Template new sandboxes boot when the spec has no image; Differently maps it to each pool's own image. */
  template?: string | null
  placement?: { strategy?: "private-first" | "cost" | "spread"; allowedPools?: string[]; external?: "never" | "overflow" }
  classification?: string
  /** What this installation's pools provide; Differently reports isolation per pool, not per request. */
  platform?: SandboxPlatform
  /**
   * Whether the pools this key reaches publish port URLs. Freestyle and Daytona pools do; OpenSandbox
   * pools behind its server's proxy do not. Defaults to true.
   */
  endpoints?: boolean
  /** The size of a sandbox whose spec names none; unset, the project's default profile decides. */
  resources?: { cpu: number; memoryGb: number; diskGb: number }
  /** What the pools this key reaches can do (`differentlyLifecycle`); unset, pause and stop are assumed. */
  lifecycle?: { pause: boolean; stop: boolean }
  /** Read `lifecycle` from Differently alongside each create, at most every five minutes, instead of fixing it. */
  discoverLifecycle?: boolean
  /** Differently has no TTL-free sandboxes: `autoDeleteMinutes: -1` keeps a computer this long after each resume. */
  persistentTtlMinutes?: number
  pollIntervalMs?: number
}
export type DifferentlyProviderDeps = { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }

/** Labels the adapter owns on every sandbox. */
export const KEY_LABEL = "openwork.sandbox.key"
const IDLE_LABEL = "openwork.sandbox.idle-minutes"
const LIVE = "queued,provisioning,running,paused,stopped,terminating"
const DEFAULT_PERSISTENT_TTL_MINUTES = 365 * 1440

type Sandbox = { id: string; status: string; statusReason?: string; region?: string; labels?: Record<string, string> }
type ErrorBody = { error?: { code?: string; message?: string } }

const codes: Record<string, SandboxErrorCode> = {
  not_found: "not_found",
  conflict: "conflict",
  invalid_state: "invalid_state",
  unsupported_operation: "invalid_state",
  unsupported_capability: "invalid_state",
  invalid_request: "invalid_state",
  quota_exceeded: "capacity",
  no_eligible_pool: "capacity",
  rate_limited: "rate_limited",
  unauthenticated: "auth",
  permission_denied: "auth",
  suspended: "auth",
  provider_unavailable: "transient",
  internal: "transient",
}

/** Drops trailing slashes in linear time, with no backtracking pattern over caller input. */
function trimTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === "/") end--
  return value.slice(0, end)
}

type PoolView = { enabled?: boolean; health?: string; capabilities?: string[] }

/** The pools this key may be placed on, from `GET /v1/capabilities`. */
async function readPools(options: Pick<DifferentlyProviderOptions, "url" | "apiKey">, deps: { fetch?: typeof fetch; timeoutMs?: number }): Promise<PoolView[]> {
  const response = await (deps.fetch ?? fetch)(`${trimTrailingSlashes(options.url)}/v1/capabilities`, { headers: { Authorization: `Bearer ${options.apiKey}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? 3000) })
  if (!response.ok) throw new Error(`capabilities answered HTTP ${response.status}`)
  return ((await response.json()) as { items?: PoolView[] }).items ?? []
}

/**
 * Whether this key can create sandboxes right now: Differently answers and at least one enabled pool it may use is
 * healthy. Infrastructure only; quotas and placement policy are answered when a sandbox is created.
 */
export async function differentlyHealth(options: Pick<DifferentlyProviderOptions, "url" | "apiKey">, deps: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ up: boolean; reason: string }> {
  try {
    const pools = await readPools(options, deps)
    return pools.some(pool => pool.enabled && pool.health === "healthy") ? { up: true, reason: "a pool is healthy" } : { up: false, reason: "no enabled pool is healthy" }
  } catch (error) {
    return { up: false, reason: error instanceof Error ? error.name === "TimeoutError" ? "capabilities timed out" : error.message : "unreachable" }
  }
}

/**
 * Whether every enabled pool can pause (keeping memory) or stop (keeping the disk) a sandbox, so the adapter claims
 * only what any placement provides. Null when Differently doesn't answer or has no enabled pool.
 */
export async function differentlyLifecycle(options: Pick<DifferentlyProviderOptions, "url" | "apiKey">, deps: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ pause: boolean; stop: boolean } | null> {
  const pools = (await readPools(options, deps).catch(() => [])).filter(pool => pool.enabled)
  if (!pools.length) return null
  const everywhere = (feature: string) => pools.every(pool => pool.capabilities?.includes(feature))
  return { pause: everywhere("lifecycle.pause-resume"), stop: everywhere("lifecycle.stop-start") }
}

/** Maps Differently's stable error codes (never its messages) onto OpenWork's taxonomy. */
export function differentlyError(status: number, body: ErrorBody | null): SandboxError {
  const code = codes[body?.error?.code ?? ""] ?? (status === 404 ? "not_found" : status === 409 ? "conflict" : status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limited" : status >= 500 ? "transient" : "unknown")
  const retryable = code === "invalid_state" && body?.error?.code !== "invalid_state" ? false : undefined
  return new SandboxError({ providerId: DIFFERENTLY_PROVIDER_ID, code, message: body?.error?.message ?? `Differently answered HTTP ${status}`, ...(retryable === undefined ? {} : { retryable }) })
}

/** Differently sandboxes as OpenWork compute, with run, files, pause and snapshot blocks. */
export function createDifferentlyProvider(options: DifferentlyProviderOptions, deps: DifferentlyProviderDeps = {}): SandboxProvider {
  if (!options.url || !options.apiKey) throw new Error("Differently requires url and apiKey")
  const id = DIFFERENTLY_PROVIDER_ID
  const base = trimTrailingSlashes(options.url)
  const send = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const poll = options.pollIntervalMs ?? 500
  let lifecycle = options.lifecycle ?? null
  let lifecycleAt = -Infinity
  const discoverLifecycle = async () => {
    if (!options.discoverLifecycle || now() - lifecycleAt < 300_000) return
    lifecycleAt = now()
    lifecycle = await differentlyLifecycle(options, { fetch: send }) ?? lifecycle
  }
  const unsupported = (feature: string): never => { throw new SandboxError({ providerId: id, code: "invalid_state", retryable: false, message: `Differently adapter does not provide ${feature}` }) }
  const identity = (ref: SandboxRef) => {
    if (ref.providerId !== id || !ref.ref.sandboxId) unsupported("this sandbox reference")
    return ref.ref.sandboxId
  }

  async function call(method: string, path: string, init: { body?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; timeoutMs?: number; raw?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}`, ...init.headers }
    let body: BodyInit | undefined
    if (init.bytes) { headers["Content-Type"] = "application/octet-stream"; body = init.bytes.slice() } // an ArrayBuffer-backed copy fetch accepts
    else if (init.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.body) }
    let response: Response
    try {
      response = await send(base + path, { method, headers, body, ...(init.timeoutMs ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}) })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      throw new SandboxError({ providerId: id, code: timedOut ? "timeout" : "transient", ...(timedOut ? { retryable: false } : {}), message: timedOut ? "Operation exceeded its deadline; outcome may be unknown" : `Differently is unreachable: ${error instanceof Error ? error.message : String(error)}`, cause: error })
    }
    if (!response.ok) throw differentlyError(response.status, await response.json().catch(() => null) as ErrorBody | null)
    return response
  }
  const json = async <T>(method: string, path: string, init?: Parameters<typeof call>[2]) => await (await call(method, path, init)).json() as T

  function state(status: string): SandboxState {
    switch (status) {
      case "queued": case "provisioning": return "creating"
      case "running": return "running"
      case "paused": case "stopped": return "stopped" // start resumes a paused sandbox; the pause block distinguishes them
      case "terminating": return "stopping"
      case "terminated": return "missing"
      default: return "error"
    }
  }
  const handle = (s: Sandbox): SandboxHandle => ({ ref: { providerId: id, ref: { sandboxId: s.id } }, name: s.labels?.[KEY_LABEL], state: state(s.status), region: s.region || null, observedAt: now() })
  const path = (sandboxId: string, suffix = "") => `/v1/sandboxes/${encodeURIComponent(sandboxId)}${suffix}`

  async function read(sandboxId: string): Promise<Sandbox | null> {
    try { return await json<Sandbox>("GET", path(sandboxId)) } catch (error) { if (error instanceof SandboxError && error.code === "not_found") return null; throw error }
  }
  /** Polls until the sandbox reaches one of `want`; a terminal state ends the wait early. */
  async function settle(sandboxId: string, want: readonly string[], timeoutMs: number): Promise<Sandbox | null> {
    const deadline = now() + timeoutMs
    while (true) {
      const s = await read(sandboxId)
      if (!s || want.includes(s.status)) return s
      if (s.status === "terminated" || s.status === "failed") return s
      if (now() >= deadline) throw new SandboxError({ providerId: id, code: "timeout", retryable: false, message: `Sandbox is still ${s.status} after ${timeoutMs} ms` })
      await sleep(poll)
    }
  }
  async function live(sandboxId: string): Promise<Sandbox> {
    const s = await read(sandboxId)
    if (!s || s.status === "terminated") throw new SandboxError({ providerId: id, code: "not_found", message: `Sandbox ${sandboxId} no longer exists` })
    return s
  }
  async function running(s: Sandbox, timeoutMs: number): Promise<Sandbox> {
    const out = s.status === "running" ? s : await settle(s.id, ["running"], timeoutMs)
    // A sandbox that failed to start is the pool's failure, not a policy refusal: hosts may place the next one elsewhere.
    if (!out || out.status !== "running") throw new SandboxError({ providerId: id, code: out?.status === "failed" ? "transient" : "invalid_state", ...(out?.status === "failed" ? { retryable: false } : {}), message: `Sandbox ${s.id} is ${out?.status ?? "gone"}${out?.statusReason ? `: ${out.statusReason}` : ""}` })
    return out
  }
  function ttlMinutes(spec: SandboxSpec): number | undefined {
    const minutes = spec.lifecycle?.autoDeleteMinutes
    if (spec.ephemeral) return 60
    if (minutes === undefined || minutes === 0) return undefined
    return minutes < 0 ? options.persistentTtlMinutes ?? DEFAULT_PERSISTENT_TTL_MINUTES : minutes
  }

  async function run(h: SandboxHandle, spec: RunSpec): Promise<RunResult> {
    if (spec.shell && spec.shell !== "sh") unsupported("PowerShell")
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) unsupported("non-positive timeouts")
    const result = await json<{ exitCode: number; stdout: string; stderr: string }>("POST", path(identity(h.ref), "/exec"), {
      body: { command: spec.command, ...(spec.env ? { env: { ...spec.env } } : {}), ...(spec.cwd ? { cwd: spec.cwd } : {}), timeoutSeconds: Math.max(1, Math.ceil(spec.timeoutMs / 1000)) },
      // Differently enforces timeoutSeconds in the sandbox; this bounds the request around it.
      timeoutMs: spec.timeoutMs + 15_000,
    })
    return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  }

  const provider: SandboxProvider = {
    id,
    describe: () => ({ stopResume: lifecycle ? lifecycle.pause || lifecycle.stop : true, persistentStorage: false, memorySnapshotRestore: false, warmPool: false, endpointKind: "stable", exec: true, regions: [], createEnvironment: true, detachedExec: false, endpoints: options.endpoints ?? true, platform: options.platform ?? { os: "linux", isolation: "unknown" } }),
    currentImage: () => options.template ? { id: options.template, version: options.template } : null,
    async create(spec, opts) {
      if (spec.storage.length) unsupported("storage attachments")
      if (spec.lifecycle?.autoPauseMinutes !== undefined || spec.lifecycle?.autoArchiveMinutes !== undefined) unsupported("provider-side auto-pause or auto-archive")
      // autoStopMinutes is a cost backstop Differently does not provide: jobs that need idle stops pause themselves.
      const image = spec.image ?? (options.template ? { id: options.template, version: options.template } : null)
      const minutes = ttlMinutes(spec)
      const resources = spec.resources ?? options.resources
      // Alongside the create, never in its way: what the pools can do decides how hosts idle the sandbox later.
      const discovering = discoverLifecycle()
      const deadline = now() + opts.timeoutMs
      const response = await call("POST", "/v1/sandboxes", {
        headers: { "Idempotency-Key": spec.idempotencyKey },
        body: {
          ...(image ? image.id.startsWith("snp_") ? { fromSnapshot: image.id } : { template: image.id } : {}),
          ...(resources ? { resources: { cpu: resources.cpu, memoryMiB: Math.round(resources.memoryGb * 1024), diskGiB: resources.diskGb } } : {}),
          ...(options.placement ? { placement: options.placement } : {}),
          ...(options.classification ? { classification: options.classification } : {}),
          ...(minutes ? { ttlSeconds: minutes * 60 } : {}),
          env: { ...spec.env },
          labels: { ...spec.labels, [KEY_LABEL]: spec.idempotencyKey, ...(minutes && !spec.ephemeral ? { [IDLE_LABEL]: String(minutes) } : {}) },
        },
        timeoutMs: opts.timeoutMs,
      })
      // 200 replays the live sandbox this key already names; the contract reports that as a conflict.
      if (response.status === 200) throw new SandboxError({ providerId: id, code: "conflict", message: `Idempotency key ${spec.idempotencyKey} already names a live sandbox` })
      const created = await response.json() as Sandbox
      const box = handle(await running(created, Math.max(1, deadline - now())))
      await discovering
      return box
    },
    async list(query) {
      const result: SandboxHandle[] = []
      const labels = { ...query.labels, ...(query.idempotencyKey ? { [KEY_LABEL]: query.idempotencyKey } : {}) }
      let cursor = ""
      while (true) {
        const params = new URLSearchParams({ status: LIVE, limit: "500", ...(cursor ? { cursor } : {}) })
        for (const [k, v] of Object.entries(labels)) params.append("label", `${k}=${v}`)
        const page = await json<{ items: Sandbox[]; nextCursor?: string }>("GET", `/v1/sandboxes?${params}`)
        for (const s of page.items) if (Object.entries(labels).every(([k, v]) => s.labels?.[k] === v)) result.push(handle(s))
        if (!page.nextCursor) return result
        cursor = page.nextCursor
      }
    },
    async find(query) { return (await provider.list(query))[0] ?? null },
    async get(ref) {
      const s = await read(identity(ref))
      return s && s.status !== "terminated" ? handle(s) : null
    },
    async inspect(h) { return await provider.get(h.ref) ?? { ...h, state: "missing", observedAt: now() } },
    async start(h, opts) {
      const deadline = now() + opts.timeoutMs
      const s = await live(identity(h.ref))
      if (s.status === "paused") await call("POST", path(s.id, "/resume"), { timeoutMs: opts.timeoutMs })
      else if (s.status === "stopped") await call("POST", path(s.id, "/start"), { timeoutMs: opts.timeoutMs })
      await running(s.status === "running" ? s : await live(s.id), Math.max(1, deadline - now()))
      // A computer's idle clock restarts when it resumes: the backend deletes it N minutes after its last use.
      const minutes = Number(s.labels?.[IDLE_LABEL])
      if (minutes > 0) await call("PATCH", path(s.id), { body: { ttlSeconds: minutes * 60 }, timeoutMs: Math.max(1, deadline - now()) })
    },
    async stop(h, opts) {
      const s = await live(identity(h.ref))
      if (s.status === "stopped" || s.status === "paused") return
      const sandboxId = s.id
      if (lifecycle && !lifecycle.stop && !lifecycle.pause) unsupported("stopping or pausing on these pools")
      if (lifecycle && !lifecycle.stop) return void await call("POST", path(sandboxId, "/pause"), { timeoutMs: opts.timeoutMs })
      try { await call("POST", path(sandboxId, "/stop"), { timeoutMs: opts.timeoutMs }) }
      catch (error) {
        // OpenSandbox has no stop; pausing keeps memory as well as the disk.
        if (!(error instanceof SandboxError) || error.code !== "invalid_state") throw error
        await call("POST", path(sandboxId, "/pause"), { timeoutMs: opts.timeoutMs })
      }
    },
    async destroy(h, opts) {
      const sandboxId = identity(h.ref)
      await call("DELETE", path(sandboxId), { timeoutMs: opts.timeoutMs })
      await settle(sandboxId, ["terminated"], opts.timeoutMs)
    },
    async exec(h, spec) {
      if (spec.detach) unsupported("detached exec; use the job's background-process helper")
      const result = await run(h, { command: spec.command ?? spec.script ?? "", timeoutMs: spec.timeoutMs })
      return { id: `differently-exec-${now()}`, exitCode: async () => result.exitCode, logs: async () => ({ stdout: result.stdout, stderr: result.stderr }) }
    },
    async endpoint(h, port) {
      if (options.endpoints === false) unsupported("endpoints on these pools")
      const out = await json<{ url: string }>("POST", path(identity(h.ref), "/ports"), { body: { port } })
      return { url: out.url, expiresAt: null, kind: "stable" }
    },
    storage: { ensureVolume: async () => unsupported("volumes"), eraseSubpaths: async () => unsupported("volumes") },
    blocks: {
      run,
      files: {
        async read(h, file, opts) {
          const response = await call("GET", `${path(identity(h.ref), "/files/content")}?path=${encodeURIComponent(file)}`, { timeoutMs: opts.timeoutMs })
          return new Uint8Array(await response.arrayBuffer())
        },
        async write(h, file, bytes, opts) {
          await call("PUT", `${path(identity(h.ref), "/files/content")}?path=${encodeURIComponent(file)}`, { bytes, timeoutMs: opts.timeoutMs })
          if (opts.mode === undefined) return
          const chmod = await run(h, { command: `chmod ${opts.mode.toString(8)} ${shellQuote(file)}`, timeoutMs: opts.timeoutMs })
          if (chmod.exitCode !== 0) throw new SandboxError({ providerId: id, code: "unknown", message: `chmod failed: ${chmod.stderr.trim()}` })
        },
        // Differently has no stat yet: list the parent directory and read the entry.
        async stat(h, file, opts) {
          const trimmed = trimTrailingSlashes(file) || "/"
          if (trimmed === "/") return { size: 0, kind: "directory" }
          const parent = trimmed.slice(0, trimmed.lastIndexOf("/")) || "/"
          const name = trimmed.slice(trimmed.lastIndexOf("/") + 1)
          try {
            const page = await json<{ items: Array<{ name: string; size: number; isDir: boolean }> }>("GET", `${path(identity(h.ref), "/files")}?path=${encodeURIComponent(parent)}`, { timeoutMs: opts.timeoutMs })
            const entry = page.items.find(item => item.name === name)
            return entry ? { size: entry.isDir ? 0 : entry.size, kind: entry.isDir ? "directory" : "file" } : null
          } catch (error) {
            if (error instanceof SandboxError && error.code === "not_found" && await provider.get(h.ref)) return null
            throw error
          }
        },
      },
      // Left out where the configured pools can't pause: hosts check for this block before pausing.
      ...(options.lifecycle?.pause === false ? {} : {
        pause: async (h: SandboxHandle, opts: { timeoutMs: number }) => {
          const sandboxId = identity(h.ref)
          // Discovered after hosts read the block (wrappers copy it): pools that can only stop do that, keeping the disk.
          if (lifecycle && !lifecycle.pause) {
            if (!lifecycle.stop) unsupported("pausing or stopping on these pools")
            await call("POST", path(sandboxId, "/stop"), { timeoutMs: opts.timeoutMs })
            await settle(sandboxId, ["stopped"], opts.timeoutMs)
            return
          }
          await call("POST", path(sandboxId, "/pause"), { timeoutMs: opts.timeoutMs })
          await settle(sandboxId, ["paused"], opts.timeoutMs)
        },
      }),
      snapshots: {
        async create(h, name, opts): Promise<ImageRef> {
          const snap = await json<{ id: string }>("POST", path(identity(h.ref), "/snapshots"), { body: { kind: "disk" }, timeoutMs: opts.timeoutMs })
          return { id: snap.id, version: name }
        },
        async destroy(image, opts) { await call("DELETE", `/v1/snapshots/${encodeURIComponent(image.id)}`, { timeoutMs: opts.timeoutMs }) },
      },
    },
  }
  return provider
}
