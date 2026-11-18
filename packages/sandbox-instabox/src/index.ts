import { createHash, randomUUID } from "node:crypto"
import {
  CommandExitError, InstaboxAuthError, InstaboxError, InstaboxQuotaError, InstaboxTimeoutError, Sandbox,
  type CommandHandle, type SandboxInfo,
} from "@insforge/instabox-sdk"
import {
  SandboxError, shellQuote,
  type Endpoint, type ExecHandle, type ExecSpec, type ImageRef, type ProviderCapabilities, type ProviderTimeout,
  type RunResult, type RunSpec, type SandboxHandle, type SandboxProvider, type SandboxQuery, type SandboxRef,
  type SandboxSpec, type SandboxState,
} from "@openwork/sandbox"

export type InstaboxProviderOptions = {
  apiKey?: string
  apiUrl?: string
  /** Template or snapshot new sandboxes boot when a spec names no image (default: the server's, agent-browser). */
  template?: string
}

const ID = "instabox"
const KEY_LABEL = "openwork.idempotency"
/** instabox pauses an idle sandbox after at most 30 minutes; an earlier pause keeps memory and resumes on start. */
const MAX_IDLE_PAUSE_MINUTES = 30

export function instaboxError(error: unknown): SandboxError {
  if (error instanceof SandboxError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (!(error instanceof InstaboxError)) return new SandboxError({ providerId: ID, code: "unknown", message, cause: error })
  const code = error.code === "not_found" || error.status === 404 ? "not_found"
    : error.code === "operation_conflict" || error.status === 409 ? "conflict"
    : error instanceof InstaboxAuthError ? "auth"
    : error instanceof InstaboxQuotaError ? (error.code === "rate_limited" || error.code === "concurrency_limit" ? "rate_limited" : "capacity")
    : error instanceof InstaboxTimeoutError ? "timeout"
    : error.status >= 500 || error.retryable ? "transient"
    : "unknown"
  return new SandboxError({ providerId: ID, code, message, cause: error })
}

/** A stable sandbox name per idempotency key: the server refuses a second sandbox with the same name. */
const nameFor = (key: string) => "ow-" + createHash("sha256").update(key).digest("hex").slice(0, 24)

function state(value: SandboxInfo["state"]): SandboxState {
  switch (value) {
    case "resuming": return "starting"
    case "suspending": return "stopping"
    case "suspended": return "stopped" // start resumes memory; the pause block distinguishes it from a cold stop
    case "deleting": case "deleted": return "missing"
    default: return value
  }
}

/** instabox sandboxes as OpenWork compute, with run, files, pause and snapshot blocks. */
export function createInstaboxProvider(options: InstaboxProviderOptions = {}): SandboxProvider {
  const conn = { apiKey: options.apiKey, apiUrl: options.apiUrl }
  const unsupported = (feature: string): never => {
    throw new SandboxError({ providerId: ID, code: "invalid_state", retryable: false, message: `instabox adapter does not provide ${feature}` })
  }
  const identity = (ref: SandboxRef) => (ref.providerId === ID && ref.ref.sandboxId ? ref.ref.sandboxId : unsupported("this sandbox reference"))
  const handle = (info: SandboxInfo): SandboxHandle => ({
    ref: { providerId: ID, ref: { sandboxId: info.sandboxId } }, name: info.name, state: state(info.state), region: null, observedAt: Date.now(),
  })

  async function bounded<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) unsupported("non-positive timeouts")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        fn().catch(error => { throw instaboxError(error) }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SandboxError({ providerId: ID, code: "timeout", message: `instabox operation exceeded ${timeoutMs}ms` })), timeoutMs)
        }),
      ])
    } finally { clearTimeout(timer) }
  }

  /** Attaches without waking it; null when the sandbox is gone. */
  async function attach(id: string): Promise<Sandbox | null> {
    try {
      const sbx = await Sandbox.connect(id, { ...conn, resume: false })
      const info = await sbx.getInfo()
      return info.state === "deleted" || info.state === "deleting" ? null : sbx
    } catch (error) {
      const mapped = instaboxError(error)
      if (mapped.code === "not_found") return null
      throw mapped
    }
  }
  async function required(h: SandboxHandle): Promise<Sandbox> {
    const sbx = await attach(identity(h.ref))
    if (!sbx) throw new SandboxError({ providerId: ID, code: "not_found", retryable: false, message: "instabox sandbox not found" })
    return sbx
  }

  async function run(h: SandboxHandle, spec: RunSpec): Promise<RunResult> {
    if (spec.shell === "powershell") unsupported("PowerShell")
    return bounded(async () => {
      const sbx = await required(h)
      try {
        const r = await sbx.commands.run(spec.command, { cwd: spec.cwd, envs: { ...(spec.env ?? {}) }, timeoutMs: Math.min(spec.timeoutMs, 600_000) })
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      } catch (error) {
        if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr }
        throw error
      }
    }, spec.timeoutMs + 5_000)
  }

  function background(job: CommandHandle): ExecHandle {
    let output = ""
    let exit: number | null = null
    const poll = async () => {
      if (exit !== null) return
      output = ""
      try {
        const r = await job.wait({ timeoutMs: 1_000, onStdout: chunk => { output += chunk } })
        exit = r.exitCode
        output = r.stdout
      } catch (error) {
        if (error instanceof CommandExitError) { exit = error.exitCode; output = error.stdout; return }
        if (error instanceof InstaboxTimeoutError) return
        throw instaboxError(error)
      }
    }
    return {
      id: job.jobId,
      exitCode: async () => { await poll(); return exit },
      logs: async () => { await poll(); return { stdout: output, stderr: "" } }, // a job writes one combined log
    }
  }

  const provider: SandboxProvider = {
    id: ID,
    describe(): ProviderCapabilities {
      return {
        stopResume: true, persistentStorage: false, memorySnapshotRestore: true, warmPool: false,
        endpointKind: "stable", exec: true, regions: [], platform: { os: "linux", isolation: "vm" },
        createEnvironment: false, endpoints: true, detachedExec: true,
      }
    },
    currentImage: () => (options.template ? { id: options.template, version: options.template } : null),
    async create(spec: SandboxSpec, opts: ProviderTimeout) {
      if (Object.keys(spec.env).length) unsupported("create-time environment; pass env to run")
      if (spec.storage.length) unsupported("storage attachments")
      const { autoPauseMinutes, autoStopMinutes, autoArchiveMinutes, autoDeleteMinutes } = spec.lifecycle ?? {}
      if (autoArchiveMinutes !== undefined) unsupported("auto-archive")
      if (autoDeleteMinutes !== undefined && autoDeleteMinutes >= 0) unsupported("deleting a sandbox after a period unused")
      const idle = autoPauseMinutes ?? autoStopMinutes
      const name = nameFor(spec.idempotencyKey)
      const template = spec.image?.id ?? options.template
      const createOpts = {
        ...conn, name, metadata: { ...spec.labels, [KEY_LABEL]: name }, vault: false, operationTimeoutMs: opts.timeoutMs,
        ...(spec.resources ? { vcpus: spec.resources.cpu, memMiB: spec.resources.memoryGb * 1024, diskGiB: spec.resources.diskGb } : {}),
        ...(idle !== undefined && idle < MAX_IDLE_PAUSE_MINUTES ? { autoSuspendMs: idle * 60_000 } : {}),
      }
      return bounded(async () => {
        const sbx = template ? await Sandbox.create(template, createOpts) : await Sandbox.create(createOpts)
        return handle(await sbx.getInfo())
      }, opts.timeoutMs)
    },
    async find(query: SandboxQuery) {
      return (await provider.list(query))[0] ?? null
    },
    async list(query: SandboxQuery) {
      const metadata = { ...(query.labels ?? {}), ...(query.idempotencyKey ? { [KEY_LABEL]: nameFor(query.idempotencyKey) } : {}) }
      try {
        const all = await Sandbox.list({ ...conn, metadata })
        return all.filter(info => info.state !== "deleted" && info.state !== "deleting").map(handle)
      } catch (error) { throw instaboxError(error) }
    },
    async get(ref: SandboxRef) {
      const sbx = await attach(identity(ref))
      return sbx ? handle(await sbx.getInfo()) : null
    },
    async inspect(h: SandboxHandle) {
      const sbx = await attach(identity(h.ref))
      return sbx ? handle(await sbx.getInfo()) : { ...h, state: "missing", observedAt: Date.now() }
    },
    async start(h: SandboxHandle, opts: ProviderTimeout) {
      await bounded(async () => {
        const sbx = await required(h)
        if ((await sbx.getInfo()).state !== "running") await sbx.resume()
      }, opts.timeoutMs)
    },
    async stop(h: SandboxHandle, opts: ProviderTimeout) {
      await bounded(async () => (await required(h)).stop(), opts.timeoutMs)
    },
    async destroy(h: SandboxHandle, opts: ProviderTimeout) {
      await bounded(() => Sandbox.kill(identity(h.ref), conn), opts.timeoutMs)
    },
    async exec(h: SandboxHandle, spec: ExecSpec): Promise<ExecHandle> {
      const command = spec.command ?? spec.script!
      if (!spec.detach) {
        const r = await run(h, { command, timeoutMs: spec.timeoutMs })
        return { id: randomUUID(), exitCode: async () => r.exitCode, logs: async () => ({ stdout: r.stdout, stderr: r.stderr }) }
      }
      const job = await bounded(async () => (await required(h)).commands.run(command, { background: true }), spec.timeoutMs)
      return background(job)
    },
    async endpoint(h: SandboxHandle, port: number): Promise<Endpoint> {
      return bounded(async () => {
        const published = await (await required(h)).ports.publish(port, { access: "public" })
        return { url: published.url, expiresAt: null, kind: "stable" as const }
      }, 60_000)
    },
    storage: {
      ensureVolume: async () => unsupported("detachable volumes"),
      eraseSubpaths: async () => unsupported("detachable volumes"),
    },
    blocks: {
      run,
      files: {
        async read(h, path, opts) {
          return bounded(async () => (await required(h)).files.read(path, { format: "bytes", maxBytes: 1 << 30 }), opts.timeoutMs)
        },
        async write(h, path, bytes, opts) {
          await bounded(async () => { await (await required(h)).files.write(path, bytes) }, opts.timeoutMs)
          if (opts.mode !== undefined) {
            const r = await run(h, { command: `chmod ${opts.mode.toString(8)} ${shellQuote(path)}`, timeoutMs: opts.timeoutMs })
            if (r.exitCode !== 0) throw new SandboxError({ providerId: ID, code: "unknown", message: `chmod failed: ${r.stderr}` })
          }
        },
        async stat(h, path, opts) {
          const q = shellQuote(path)
          const r = await run(h, { command: `if [ -e ${q} ]; then stat -c '%s|%F' ${q}; else echo absent; fi`, timeoutMs: opts.timeoutMs })
          const line = r.stdout.trim()
          if (line === "absent") return null
          const [size, kind] = line.split("|")
          return { size: Number(size), kind: kind === "directory" ? "directory" : "file" }
        },
      },
      async pause(h, opts) {
        await bounded(async () => (await required(h)).pause(), opts.timeoutMs)
      },
      snapshots: {
        /** Waits until the snapshot is saved, so a create from it boots at once. */
        async create(h, name, opts): Promise<ImageRef> {
          return bounded(async () => {
            let snap = await (await required(h)).createSnapshot({ name })
            while (snap.status === "pending") {
              await new Promise(r => setTimeout(r, 1_000))
              snap = await Sandbox.getSnapshot(snap.id, conn)
            }
            return { id: snap.id, version: snap.createdAt }
          }, opts.timeoutMs)
        },
        async destroy(image, opts) {
          await bounded(() => Sandbox.deleteSnapshot(image.id, conn), opts.timeoutMs)
        },
      },
    },
  }
  return provider
}
