import { createServer } from "node:net"
import { isAbsolute, parse, posix, resolve } from "node:path"
import {
  SandboxError,
  shellQuote,
  type RunResult,
  type RunSpec,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxQuery,
  type SandboxRef,
  type SandboxSpec,
  type SandboxState,
} from "@openwork/sandbox"
import type {
  GuestConfig,
  GuestIdentity,
  GuestInfo,
  GuestStatus,
  MicrosandboxDriver,
  MicrosandboxMount,
  MicrosandboxNetwork,
} from "./driver.js"
import { MICROSANDBOX_PROVIDER_ID, isPortInUse, microsandboxError } from "./errors.js"
import { createNativeDriver } from "./native-driver.js"

export type MicrosandboxProviderOptions = {
  /** OCI image new sandboxes boot. Pin a digest where the configuration is trusted to choose one. */
  image: string
  /** Required: the adapter never grants network access implicitly. */
  network: MicrosandboxNetwork
  /** The only host directories the guest can see. Give real paths: a path through a symlink is refused. */
  mounts?: readonly MicrosandboxMount[]
}

export type MicrosandboxProviderDeps = {
  driver?: MicrosandboxDriver
  now?: () => number
  /** A free port on this computer's loopback interface for one published guest port. */
  allocatePort?: () => Promise<number>
}

/** Host port a guest port is published on, recorded at create because microsandbox fixes it then. */
const PORT_LABEL = "openwork.sandbox.port."
const MAX_NAME_BYTES = 128
/** Lets the guest's own timeout, which ends the process, win over the adapter's deadline. */
const RUN_GRACE_MS = 5_000
/** Lets the driver call a slow creation off and clean up before the adapter's deadline reports an unknown outcome. */
const CREATE_GRACE_MS = 20_000
/** A free port can be taken between choosing it and the sandbox binding it. */
const PORT_ATTEMPTS = 3
/** A dotted name whose last label starts with a letter, so an IP address is not mistaken for a host name. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const STATES: Readonly<Record<GuestStatus, SandboxState>> = {
  created: "stopped",
  starting: "starting",
  running: "running",
  draining: "stopping",
  // `start` resumes memory; the pause block is what tells a pause from a cold stop.
  paused: "stopped",
  stopped: "stopped",
  crashed: "error",
}

function invalid(message: string): never {
  throw new SandboxError({ providerId: MICROSANDBOX_PROVIDER_ID, code: "invalid_state", retryable: false, message })
}

function unsupported(feature: string): never {
  return invalid(`microsandbox adapter does not provide ${feature}`)
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port)
        else reject(new Error("No loopback port is available"))
      })
    })
  })
}

/** Written one way only, so two spellings of a path cannot slip past a check made on the text. */
function isPlainGuestPath(path: string) {
  return path.startsWith("/") && path !== "/" && posix.normalize(path) === path && !path.endsWith("/")
}

function isPlainHostPath(path: string) {
  return isAbsolute(path) && resolve(path) === path && parse(path).root !== path
}

/** Reject configuration that could widen access by accident; nothing is repaired or defaulted. */
function validateOptions(options: MicrosandboxProviderOptions) {
  if (!options.image.trim()) invalid("microsandbox requires an image")
  const guestPaths = new Set<string>()
  for (const mount of options.mounts ?? []) {
    if (!isPlainHostPath(mount.hostPath)) invalid(`Mount host path must be absolute, normalized and not the root: ${mount.hostPath}`)
    if (!isPlainGuestPath(mount.guestPath)) invalid(`Mount guest path must be absolute, normalized and below /: ${mount.guestPath}`)
    if (guestPaths.has(mount.guestPath)) invalid(`Two mounts share the guest path ${mount.guestPath}`)
    guestPaths.add(mount.guestPath)
  }
  if (options.network.egress === "allow-list") {
    if (!options.network.domains.length) invalid("An allow-list needs at least one host; use egress none for no network")
    for (const domain of options.network.domains) {
      if (!HOSTNAME.test(domain)) invalid(`Allow-list entries are exact lowercase host names: ${domain}`)
    }
  }
}

/**
 * A local microVM per sandbox. Mounts and egress are fixed by the options the
 * host constructs the provider with, never by a sandbox spec, so the job
 * asking for a sandbox cannot widen its own access.
 */
export function createMicrosandboxProvider(options: MicrosandboxProviderOptions, deps: MicrosandboxProviderDeps = {}): SandboxProvider {
  validateOptions(options)
  const id = MICROSANDBOX_PROVIDER_ID
  const driver = deps.driver ?? createNativeDriver()
  const now = deps.now ?? Date.now
  const allocatePort = deps.allocatePort ?? allocateLoopbackPort

  function handle(info: GuestInfo): SandboxHandle {
    return { ref: { providerId: id, ref: { sandboxId: info.id, name: info.name } }, name: info.name, state: STATES[info.status], region: null, observedAt: now() }
  }
  function identity(ref: SandboxRef): GuestIdentity | null {
    const { sandboxId, name } = ref.ref
    return ref.providerId === id && sandboxId && name ? { id: sandboxId, name } : null
  }
  function guest(h: SandboxHandle): GuestIdentity {
    return identity(h.ref) ?? invalid("This reference does not name a microsandbox sandbox")
  }
  async function mapped<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn() } catch (error) { throw microsandboxError(error) }
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
  /** The sandbox this handle was issued for, never a later one that reused its name. */
  async function current(h: SandboxHandle): Promise<GuestInfo> {
    const wanted = guest(h)
    const info = await mapped(() => driver.get(wanted.name))
    if (!info || info.id !== wanted.id) throw new SandboxError({ providerId: id, code: "not_found", message: `Sandbox ${wanted.name} no longer exists` })
    return info
  }
  function matches(info: GuestInfo, labels: SandboxQuery["labels"]) {
    return Object.entries(labels ?? {}).every(([key, value]) => info.labels[key] === value)
  }
  /** Everything about a sandbox except the host ports its previews are published on. */
  function guestBase(spec: SandboxSpec): { config: Omit<GuestConfig, "ports" | "labels">; guestPorts: number[] } {
    const name = spec.idempotencyKey
    if (!name.trim() || Buffer.byteLength(name) > MAX_NAME_BYTES) unsupported(`names that are empty or longer than ${MAX_NAME_BYTES} bytes`)
    if (spec.storage.length) unsupported("storage attachments; host directories are mounted by the provider's configuration")
    if (spec.public) unsupported("public endpoints; previews stay on this computer")
    const lifecycle = spec.lifecycle ?? {}
    if (lifecycle.autoPauseMinutes !== undefined || lifecycle.autoArchiveMinutes !== undefined) unsupported("auto-pause or auto-archive")
    if (lifecycle.autoDeleteMinutes !== undefined && lifecycle.autoDeleteMinutes >= 0) unsupported("auto-delete")
    const idleMinutes = lifecycle.autoStopMinutes
    if (idleMinutes !== undefined && (!Number.isFinite(idleMinutes) || idleMinutes < 0)) unsupported("negative or non-finite auto-stop")
    if (Object.keys(spec.labels).some(key => key.startsWith(PORT_LABEL))) unsupported(`labels that start with ${PORT_LABEL}`)
    if (Object.keys(spec.env).some(key => !ENV_NAME.test(key))) unsupported("environment variable names outside [A-Za-z_][A-Za-z0-9_]*")
    const guestPorts = [...new Set(spec.exposePorts)]
    if (guestPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)) unsupported("ports outside 1-65535")
    const resources = spec.resources
    const sized = (value: number) => Number.isFinite(value) && value > 0
    if (resources && (!Number.isInteger(resources.cpu) || resources.cpu < 1 || !sized(resources.memoryGb) || !sized(resources.diskGb))) unsupported("fractional CPUs or memory and disk that are not positive numbers")
    return {
      guestPorts,
      config: {
        name,
        image: spec.image?.id ?? options.image,
        ...(resources ? { cpus: resources.cpu, memoryMib: Math.round(resources.memoryGb * 1024), diskMib: Math.round(resources.diskGb * 1024) } : {}),
        env: spec.env,
        mounts: options.mounts ?? [],
        network: options.network,
        // Zero means the sandbox is never stopped for being idle, which is what no timer does.
        ...(idleMinutes ? { idleTimeoutSeconds: Math.round(idleMinutes * 60) } : {}),
        ephemeral: spec.ephemeral === true,
      },
    }
  }
  async function withPorts(spec: SandboxSpec, base: ReturnType<typeof guestBase>): Promise<GuestConfig> {
    const ports: { hostPort: number; guestPort: number }[] = []
    for (const guestPort of base.guestPorts) ports.push({ hostPort: await allocatePort(), guestPort })
    return { ...base.config, ports, labels: { ...spec.labels, ...Object.fromEntries(ports.map(port => [`${PORT_LABEL}${port.guestPort}`, String(port.hostPort)])) } }
  }
  async function run(h: SandboxHandle, spec: RunSpec): Promise<RunResult> {
    if (spec.shell && spec.shell !== "sh") unsupported("PowerShell")
    if (spec.activity === "maintenance") unsupported("maintenance commands; every command keeps the sandbox from idling")
    if (Object.keys(spec.env ?? {}).some(key => !ENV_NAME.test(key))) unsupported("environment variable names outside [A-Za-z_][A-Za-z0-9_]*")
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) unsupported("non-positive timeouts")
    const target = guest(h)
    return bounded(() => driver.run(target, { command: spec.command, ...(spec.cwd ? { cwd: spec.cwd } : {}), env: spec.env ?? {}, timeoutMs: spec.timeoutMs }), spec.timeoutMs + RUN_GRACE_MS)
  }

  const provider: SandboxProvider = {
    id,
    describe: () => ({
      stopResume: true,
      persistentStorage: false,
      memorySnapshotRestore: false,
      warmPool: false,
      endpointKind: "stable",
      exec: true,
      regions: [],
      platform: { os: "linux", isolation: "microvm" },
      createEnvironment: true,
      endpoints: true,
      detachedExec: false,
    }),
    currentImage: () => ({ id: options.image, version: options.image }),
    async create(spec, opts) {
      if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) unsupported("non-positive timeouts")
      const base = guestBase(spec)
      for (let attempt = 1; ; attempt += 1) {
        const config = await withPorts(spec, base)
        let portTaken = false
        try {
          return handle(await bounded(async () => {
            try {
              return await driver.create(config, opts.timeoutMs)
            } catch (error) {
              portTaken = isPortInUse(error)
              throw error
            }
          }, opts.timeoutMs + CREATE_GRACE_MS))
        } catch (error) {
          if (!portTaken || attempt >= PORT_ATTEMPTS) throw error
        }
      }
    },
    async find(query) {
      const key = query.idempotencyKey
      if (!key) return (await provider.list(query))[0] ?? null
      const info = await mapped(() => driver.get(key))
      return info && matches(info, query.labels) ? handle(info) : null
    },
    async list(query) {
      if (query.idempotencyKey) {
        const found = await provider.find(query)
        return found ? [found] : []
      }
      return (await mapped(() => driver.list(query.labels ?? {}))).filter(info => matches(info, query.labels)).map(handle)
    },
    async get(ref) {
      const wanted = identity(ref)
      if (!wanted) return null
      const info = await mapped(() => driver.get(wanted.name))
      return info && info.id === wanted.id ? handle(info) : null
    },
    async inspect(h) { return await provider.get(h.ref) ?? { ...h, state: "missing", observedAt: now() } },
    async start(h, opts) {
      const info = await current(h)
      if (info.status === "running") return
      await bounded(() => info.status === "paused" ? driver.resume(info) : driver.start(info), opts.timeoutMs)
    },
    async stop(h, opts) {
      const target = guest(h)
      await bounded(() => driver.stop(target, opts.timeoutMs), opts.timeoutMs)
    },
    async destroy(h, opts) {
      const target = guest(h)
      await bounded(() => driver.destroy(target, opts.timeoutMs), opts.timeoutMs)
    },
    async exec(h, spec) {
      if (spec.detach) unsupported("detached exec; start background work from the command itself")
      const result = await run(h, { command: spec.command ?? spec.script ?? "", timeoutMs: spec.timeoutMs })
      return { id: `microsandbox-exec-${now()}`, exitCode: async () => result.exitCode, logs: async () => ({ stdout: result.stdout, stderr: result.stderr }) }
    },
    async endpoint(h, port) {
      const recorded = (await current(h)).labels[`${PORT_LABEL}${port}`]
      if (!recorded) invalid(`This sandbox was created without a preview for port ${port}; it needs a new sandbox.`)
      const hostPort = Number(recorded)
      if (!/^\d+$/.test(recorded) || hostPort < 1 || hostPort > 65_535) invalid(`The preview for port ${port} is recorded as ${recorded}, which is not a port`)
      return { url: `http://127.0.0.1:${hostPort}`, expiresAt: null, kind: "stable" }
    },
    storage: { ensureVolume: async () => unsupported("volumes"), eraseSubpaths: async () => unsupported("volumes") },
    blocks: {
      run,
      files: {
        async read(h, path, opts) {
          const target = guest(h)
          return bounded(() => driver.readFile(target, path), opts.timeoutMs)
        },
        async write(h, path, bytes, opts) {
          const target = guest(h)
          const mode = opts.mode
          if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) unsupported("file modes outside 0-0777")
          await bounded(() => driver.writeFile(target, path, bytes), opts.timeoutMs)
          if (mode === undefined) return
          const chmod = await run(h, { command: `chmod ${mode.toString(8)} ${shellQuote(path)}`, timeoutMs: opts.timeoutMs })
          if (chmod.exitCode !== 0) throw new SandboxError({ providerId: id, code: "unknown", message: `Could not set the mode of ${path}: ${chmod.stderr.trim()}` })
        },
        async stat(h, path, opts) {
          const target = guest(h)
          const info = await bounded(() => driver.stat(target, path), opts.timeoutMs)
          if (info === null) return null
          if (info.kind !== "file" && info.kind !== "directory") return unsupported("symlink or special-file metadata")
          return { size: info.size, kind: info.kind }
        },
      },
      pause: async (h, opts) => {
        const target = guest(h)
        await bounded(() => driver.pause(target), opts.timeoutMs)
      },
    },
  }
  return provider
}
