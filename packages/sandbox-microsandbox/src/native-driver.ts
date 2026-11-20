import { randomUUID } from "node:crypto"
import type { MountBuilder, NetworkBuilder, Sandbox, SandboxHandle } from "microsandbox"
import { MicrosandboxDriverError, type GuestConfig, type GuestIdentity, type GuestInfo, type MicrosandboxDriver } from "./driver.js"

type Microsandbox = typeof import("microsandbox")
type Mount = InstanceType<typeof MountBuilder>
type Network = InstanceType<typeof NetworkBuilder>

const LOOPBACK = "127.0.0.1"
const LIST_PAGE = 100
const REMOVE_TIMEOUT_MS = 15_000
const PORT_IN_USE = /failed to publish (TCP|UDP) port/i
const CREATE_OWNER = "openwork.sandbox.create-owner"

function labelsOf(config: Record<string, unknown>): Record<string, string> {
  const labels = config.labels
  if (labels === null || typeof labels !== "object") return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) if (typeof value === "string") result[key] = value
  return result
}

/** The SDK can also drive microsandbox's hosted service; this adapter is only ever the computer it runs on. */
function requireLocal(backendKind: "local" | "cloud", name: string) {
  if (backendKind !== "local") throw new MicrosandboxDriverError("notLocal", `Sandbox ${name} is not on this computer`)
}

function info(handle: SandboxHandle): GuestInfo {
  requireLocal(handle.backendKind, handle.name)
  return { name: handle.name, id: handle.id, status: handle.status, labels: labelsOf(handle.config()) }
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code
}

/**
 * Drives the `microsandbox` SDK. The SDK and its native runtime load on first
 * use, so a host that never selects this provider never loads them.
 */
export function createNativeDriver(load: () => Promise<Microsandbox> = () => import("microsandbox")): MicrosandboxDriver {
  let loaded: Promise<Microsandbox> | undefined
  // The SDK's backend is process-wide and can be switched to the hosted service by the environment.
  const sdk = () => (loaded ??= load().then(m => {
    m.setDefaultBackend("local")
    return m
  }))
  /** One connection attempt per sandbox id, shared by concurrent calls. A failed call drops only its own entry. */
  const connections = new Map<string, Promise<Sandbox>>()

  async function lookup(guest: GuestIdentity): Promise<SandboxHandle> {
    const handle = await (await sdk()).Sandbox.get(guest.name)
    requireLocal(handle.backendKind, handle.name)
    if (handle.id !== guest.id) throw new MicrosandboxDriverError("sandboxReplaced", `Sandbox ${guest.name} was removed and created again`)
    return handle
  }
  function remember(id: string, connection: Promise<Sandbox>) {
    connections.set(id, connection)
    connection.catch(() => forget(id, connection))
    return connection
  }
  function forget(id: string, connection: Promise<Sandbox>) {
    if (connections.get(id) === connection) connections.delete(id)
  }
  async function connected<T>(guest: GuestIdentity, fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    const connection = connections.get(guest.id) ?? remember(guest.id, lookup(guest).then(handle => handle.connect()))
    try {
      return await fn(await connection)
    } catch (error) {
      forget(guest.id, connection)
      throw error
    }
  }
  function network(m: Microsandbox, config: GuestConfig) {
    return (builder: Network): Network => {
      const deny = m.NetworkPolicy.builder().defaultEgress("deny").defaultIngress("allow")
      const domains = config.network.egress === "allow-list" ? [...config.network.domains] : []
      let result = builder
        .policy(domains.length ? deny.egress(rule => rule.tcp().ports([80, 443]).allowDomains(domains)) : deny)
        // An allowed name must not become a way to reach this computer's own network.
        .dns(dns => dns.rebindProtection(true))
      for (const port of config.ports) result = result.portBind(LOOPBACK, port.hostPort, port.guestPort)
      return result
    }
  }
  /** A sandbox that failed to start keeps its name; without this the next create would find a broken one. */
  async function removeFailed(m: Microsandbox, name: string, owner: string) {
    try {
      const handle = await m.Sandbox.get(name)
      requireLocal(handle.backendKind, handle.name)
      // Another creator may have claimed this name while our request was failing.
      if (labelsOf(handle.config())[CREATE_OWNER] !== owner) return
      await handle.destroy({ force: true, timeoutMs: REMOVE_TIMEOUT_MS })
    } catch (error) {
      if (!hasCode(error, "sandboxNotFound")) throw error
    }
  }

  const driver: MicrosandboxDriver = {
    async create(config, timeoutMs, onProgress) {
      const m = await sdk()
      if (await driver.get(config.name)) throw new MicrosandboxDriverError("sandboxAlreadyExists", `Sandbox ${config.name} already exists`)
      const owner = randomUUID()
      let builder = m.Sandbox.builder(config.name)
        .image(config.image)
        .detached(true)
        .ephemeral(config.ephemeral)
        .envs({ ...config.env })
        .labels({ ...config.labels, [CREATE_OWNER]: owner })
      if (config.cpus !== undefined) builder = builder.cpus(config.cpus)
      if (config.memoryMib !== undefined) builder = builder.memory(config.memoryMib)
      if (config.diskMib !== undefined) builder = builder.rootDisk(config.diskMib)
      if (config.idleTimeoutSeconds !== undefined) builder = builder.idleTimeout(config.idleTimeoutSeconds)
      for (const mount of config.mounts) {
        builder = builder.volume(mount.guestPath, (volume: Mount) => mount.access === "ro" ? volume.bind(mount.hostPath).readonly() : volume.bind(mount.hostPath))
      }
      // No interface at all is the strongest form of "no network"; published ports need one.
      if (config.network.egress === "none" && !config.ports.length) builder = builder.disableNetwork()
      else builder = builder.network(network(m, config))
      // Host names in an allow-list are only enforceable on HTTPS when the host can read the request authority.
      if (config.network.egress === "allow-list") builder = builder.interceptTls()
      let calledOff = false
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const creation = await builder.createWithProgress()
        if (onProgress) void (async () => {
          for await (const event of creation) {
            if (finished || calledOff) break
            onProgress(event)
          }
        })().catch(() => undefined) // Telemetry must never gate creation.
        timer = setTimeout(() => {
          calledOff = true
          creation.cancel()
        }, timeoutMs)
        const sandbox = await creation.awaitSandbox()
        requireLocal(sandbox.backendKind, sandbox.name)
        remember(sandbox.id, Promise.resolve(sandbox))
        return info(await m.Sandbox.get(config.name))
      } catch (error) {
        finished = true
        if (hasCode(error, "sandboxAlreadyExists")) throw error
        await removeFailed(m, config.name, owner)
        if (calledOff) throw new MicrosandboxDriverError("createCancelled", `Creating sandbox ${config.name} took longer than ${timeoutMs} ms and was called off`)
        if (error instanceof Error && PORT_IN_USE.test(error.message)) throw new MicrosandboxDriverError("portInUse", error.message)
        throw error
      } finally {
        finished = true
        if (timer) clearTimeout(timer)
      }
    },
    async get(name) {
      try {
        return info(await (await sdk()).Sandbox.get(name))
      } catch (error) {
        if (hasCode(error, "sandboxNotFound")) return null
        throw error
      }
    },
    async list(labels) {
      const m = await sdk()
      const result: GuestInfo[] = []
      let cursor: string | undefined
      do {
        const from = cursor
        const page = await m.Sandbox.listWith(list => {
          const filtered = list.limit(LIST_PAGE).labels({ ...labels })
          return from ? filtered.cursor(from) : filtered
        })
        for (const handle of page.sandboxes) result.push(info(handle))
        cursor = page.nextCursor
      } while (cursor)
      return result
    },
    async start(guest) {
      await remember(guest.id, lookup(guest).then(handle => handle.connectOrStart({ detached: true })))
    },
    async resume(guest) {
      await (await lookup(guest)).resume()
    },
    async pause(guest) {
      await (await lookup(guest)).pause()
    },
    async stop(guest, timeoutMs) {
      connections.delete(guest.id)
      await (await lookup(guest)).stopWithTimeout(timeoutMs)
    },
    async destroy(guest, timeoutMs) {
      connections.delete(guest.id)
      await (await lookup(guest)).destroy({ force: true, timeoutMs })
    },
    run(guest, spec) {
      return connected(guest, async sandbox => {
        const output = await sandbox.execWith("sh", exec => {
          const configured = exec.args(["-c", spec.command]).envs({ ...spec.env }).timeout(spec.timeoutMs)
          return spec.cwd ? configured.cwd(spec.cwd) : configured
        })
        return { exitCode: output.code, stdout: output.stdout(), stderr: output.stderr() }
      })
    },
    readFile(guest, path) {
      return connected(guest, sandbox => sandbox.fs().read(path))
    },
    writeFile(guest, path, bytes) {
      return connected(guest, sandbox => sandbox.fs().write(path, bytes))
    },
    stat(guest, path) {
      return connected(guest, async sandbox => {
        const fs = sandbox.fs()
        if (!(await fs.exists(path))) return null
        const metadata = await fs.stat(path)
        return { size: metadata.size, kind: metadata.kind }
      })
    },
  }
  return driver
}
