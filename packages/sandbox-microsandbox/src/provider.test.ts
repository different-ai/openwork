import assert from "node:assert/strict"
import { test } from "node:test"
import { isSandboxError, type SandboxErrorCode, type SandboxProvider, type SandboxSpec } from "@openwork/sandbox"
import { sandboxBlockConformanceCases, sandboxProviderConformanceCases } from "@openwork/sandbox/testing"
import { MicrosandboxDriverError, type GuestConfig, type GuestIdentity, type GuestInfo, type GuestRun, type GuestStatus, type MicrosandboxDriver } from "./driver.js"
import { createMicrosandboxProvider, type MicrosandboxProviderOptions } from "./provider.js"

type Guest = { info: GuestInfo; config: GuestConfig; files: Map<string, Uint8Array> }
type RunHandler = (spec: GuestRun) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** An in-memory guest with microsandbox's observable rules: strict names, ids that change on re-create, no work unless running. */
function fakeDriver(onRun: RunHandler = async () => ({ exitCode: 0, stdout: "", stderr: "" })) {
  const guests = new Map<string, Guest>()
  const runs: GuestRun[] = []
  const takenPorts = new Set<number>()
  let created = 0
  function live(guest: GuestIdentity): Guest {
    const found = guests.get(guest.name)
    if (!found || found.info.id !== guest.id) throw new MicrosandboxDriverError("sandboxNotFound", `sandbox not found: ${guest.name}`)
    return found
  }
  function running(guest: GuestIdentity): Guest {
    const found = live(guest)
    if (found.info.status !== "running") throw new MicrosandboxDriverError("sandboxNotRunning", `sandbox ${guest.name} is not running`)
    return found
  }
  function set(guest: GuestIdentity, status: GuestStatus) {
    const found = live(guest)
    found.info = { ...found.info, status }
  }
  const driver: MicrosandboxDriver = {
    async create(config) {
      if (guests.has(config.name)) throw new MicrosandboxDriverError("sandboxAlreadyExists", `sandbox already exists: ${config.name}`)
      const taken = config.ports.find(port => takenPorts.has(port.hostPort))
      if (taken) throw new MicrosandboxDriverError("portInUse", `failed to publish TCP port 127.0.0.1:${taken.hostPort}`)
      created += 1
      const info: GuestInfo = { name: config.name, id: `local:${created}`, status: "running", labels: config.labels }
      guests.set(config.name, { info, config, files: new Map() })
      return info
    },
    async get(name) { return guests.get(name)?.info ?? null },
    async list(labels) {
      return [...guests.values()].map(guest => guest.info).filter(info => Object.entries(labels).every(([key, value]) => info.labels[key] === value))
    },
    async start(guest) { set(guest, "running") },
    async resume(guest) { set(guest, "running") },
    async pause(guest) { set(guest, "paused") },
    async stop(guest) { set(guest, "stopped") },
    async destroy(guest) {
      live(guest)
      guests.delete(guest.name)
    },
    async run(guest, spec) {
      running(guest)
      runs.push(spec)
      return onRun(spec)
    },
    async readFile(guest, path) {
      const bytes = running(guest).files.get(path)
      if (!bytes) throw new MicrosandboxDriverError("sandboxFsOps", "No such file or directory")
      return bytes
    },
    async writeFile(guest, path, bytes) { running(guest).files.set(path, bytes) },
    async stat(guest, path) {
      const bytes = running(guest).files.get(path)
      return bytes ? { size: bytes.length, kind: "file" } : null
    },
  }
  return { driver, guests, runs, takenPorts, crash: (name: string) => { const guest = guests.get(name); if (guest) guest.info = { ...guest.info, status: "crashed" } } }
}

const offline: MicrosandboxProviderOptions = { image: "alpine", network: { egress: "none" } }
const opts = { timeoutMs: 5_000 }
let nextPort = 41_000

function providerWith(options: MicrosandboxProviderOptions = offline, onRun?: RunHandler) {
  const fake = fakeDriver(onRun)
  const provider = createMicrosandboxProvider(options, { driver: fake.driver, allocatePort: async () => nextPort++ })
  return { provider, ...fake }
}

function spec(key: string, extra: Partial<SandboxSpec> = {}): SandboxSpec {
  return { idempotencyKey: key, image: null, labels: {}, env: {}, storage: [], exposePorts: [], ...extra }
}

async function rejectsWith(operation: () => unknown, code: SandboxErrorCode) {
  let caught: unknown = null
  try { await operation() } catch (error) { caught = error }
  assert.ok(isSandboxError(caught), `expected a SandboxError, got ${String(caught)}`)
  assert.equal(caught.code, code)
  assert.equal(caught.providerId, "microsandbox")
  return caught
}

for (const c of sandboxProviderConformanceCases(() => providerWith().provider)) test(c.name, c.run)
for (const c of sandboxBlockConformanceCases(() => providerWith().provider, ["files", "pause"])) test(c.name, c.run)

test("claims a Linux microVM without detached exec, volumes or memory restore", () => {
  const capabilities = providerWith().provider.describe()
  assert.deepEqual(capabilities.platform, { os: "linux", isolation: "microvm" })
  assert.equal(capabilities.detachedExec, false)
  assert.equal(capabilities.persistentStorage, false)
  assert.equal(capabilities.memorySnapshotRestore, false)
})

test("every sandbox gets the provider's mounts and network, and nothing a spec asks for can widen them", async () => {
  const options: MicrosandboxProviderOptions = {
    image: "alpine",
    network: { egress: "allow-list", domains: ["registry.npmjs.org"] },
    mounts: [{ hostPath: "/Users/someone/project", guestPath: "/workspace", access: "ro" }],
  }
  const { provider, guests } = providerWith(options)
  await provider.create(spec("configured", { env: { CI: "1" }, resources: { cpu: 2, memoryGb: 1.5, diskGb: 4 }, lifecycle: { autoStopMinutes: 10, autoDeleteMinutes: -1 } }), opts)
  const config = guests.get("configured")?.config
  assert.ok(config)
  assert.deepEqual(config.network, options.network)
  assert.deepEqual(config.mounts, options.mounts)
  assert.deepEqual(config.env, { CI: "1" })
  assert.deepEqual([config.cpus, config.memoryMib, config.diskMib, config.idleTimeoutSeconds], [2, 1536, 4096, 600])
  const volume = { volume: { providerId: "microsandbox", id: "v", name: "v" }, mountPath: "/data" }
  await rejectsWith(() => provider.create(spec("with-volume", { storage: [volume] }), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("public", { public: true }), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("auto-pause", { lifecycle: { autoPauseMinutes: 5 } }), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("auto-delete", { lifecycle: { autoDeleteMinutes: 60 } }), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("x".repeat(129)), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("no-memory", { resources: { cpu: 1, memoryGb: Number.NaN, diskGb: 4 } }), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("half-cpu", { resources: { cpu: 0.5, memoryGb: 1, diskGb: 4 } }), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("negative-idle", { lifecycle: { autoStopMinutes: -1 } }), opts), "invalid_state")
  await rejectsWith(() => provider.create(spec("no-deadline"), { timeoutMs: 0 }), "invalid_state")
  assert.equal(guests.size, 1)
})

test("refuses configuration that would widen access by accident", async () => {
  const build = (options: MicrosandboxProviderOptions) => () => createMicrosandboxProvider(options, { driver: fakeDriver().driver })
  await rejectsWith(build({ image: " ", network: { egress: "none" } }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "relative/path", guestPath: "/workspace", access: "ro" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/host", guestPath: "/", access: "rw" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/", guestPath: "/workspace", access: "ro" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/host/../etc", guestPath: "/workspace", access: "ro" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/host", guestPath: "/workspace/../etc", access: "rw" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/host", guestPath: "//", access: "rw" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/host", guestPath: "/./", access: "rw" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/a", guestPath: "/workspace", access: "ro" }, { hostPath: "/b", guestPath: "/workspace/", access: "rw" }] }), "invalid_state")
  await rejectsWith(build({ ...offline, mounts: [{ hostPath: "/a", guestPath: "/workspace", access: "ro" }, { hostPath: "/b", guestPath: "/workspace", access: "rw" }] }), "invalid_state")
  await rejectsWith(build({ image: "alpine", network: { egress: "allow-list", domains: [] } }), "invalid_state")
  await rejectsWith(build({ image: "alpine", network: { egress: "allow-list", domains: ["*.example.com"] } }), "invalid_state")
  await rejectsWith(build({ image: "alpine", network: { egress: "allow-list", domains: ["Example.com"] } }), "invalid_state")
  await rejectsWith(build({ image: "alpine", network: { egress: "allow-list", domains: ["10.0.0.1"] } }), "invalid_state")
})

test("a preview port taken before the sandbox could bind it is chosen again, a few times at most", async () => {
  const fake = fakeDriver()
  const offered = [42_001, 42_002, 42_003, 42_004, 42_005, 42_006]
  const provider = createMicrosandboxProvider(offline, { driver: fake.driver, allocatePort: async () => offered.shift() ?? 0 })
  fake.takenPorts.add(42_001)
  const handle = await provider.create(spec("second-try", { exposePorts: [3000] }), opts)
  assert.equal((await provider.endpoint(handle, 3000)).url, "http://127.0.0.1:42002")
  for (const port of [42_003, 42_004, 42_005]) fake.takenPorts.add(port)
  await rejectsWith(() => provider.create(spec("never", { exposePorts: [3000] }), opts), "transient")
  assert.deepEqual(offered, [42_006])
  assert.equal(fake.guests.has("never"), false)
})

test("previews are published on loopback at create and are the only endpoints", async () => {
  const { provider, guests } = providerWith()
  const handle = await provider.create(spec("preview", { exposePorts: [3000, 3000, 8080] }), opts)
  const ports = guests.get("preview")?.config.ports ?? []
  assert.deepEqual(ports.map(port => port.guestPort), [3000, 8080])
  const endpoint = await provider.endpoint(handle, 8080)
  assert.deepEqual(endpoint, { url: `http://127.0.0.1:${ports[1]?.hostPort}`, expiresAt: null, kind: "stable" })
  await rejectsWith(() => provider.endpoint(handle, 9000), "invalid_state")
  await rejectsWith(() => provider.create(spec("bad-port", { exposePorts: [70_000] }), opts), "invalid_state")
})

test("a handle never reaches a sandbox that reused its name", async () => {
  const { provider } = providerWith()
  const first = await provider.create(spec("reused"), opts)
  await provider.destroy(first, opts)
  const second = await provider.create(spec("reused"), opts)
  assert.notDeepEqual(second.ref, first.ref)
  assert.equal(await provider.get(first.ref), null)
  assert.equal((await provider.inspect(first)).state, "missing")
  await rejectsWith(() => provider.start(first, opts), "not_found")
  await rejectsWith(() => provider.blocks?.run?.(first, { command: "true", ...opts }), "not_found")
  await rejectsWith(() => provider.destroy(first, opts), "not_found")
  assert.equal((await provider.inspect(second)).state, "running")
})

test("run hands the command, directory and environment to the guest and reports its exit code", async () => {
  const { provider, runs } = providerWith(offline, async () => ({ exitCode: 3, stdout: "out", stderr: "err" }))
  const handle = await provider.create(spec("run"), opts)
  const result = await provider.blocks?.run?.(handle, { command: "npm test", cwd: "/workspace", env: { CI: "1" }, timeoutMs: 2_000 })
  assert.deepEqual(result, { exitCode: 3, stdout: "out", stderr: "err" })
  assert.deepEqual(runs, [{ command: "npm test", cwd: "/workspace", env: { CI: "1" }, timeoutMs: 2_000 }])
  await rejectsWith(() => provider.blocks?.run?.(handle, { command: "dir", shell: "powershell", ...opts }), "invalid_state")
  await rejectsWith(() => provider.blocks?.run?.(handle, { command: "true", activity: "maintenance", ...opts }), "invalid_state")
  assert.equal(runs.length, 1)
  await rejectsWith(() => provider.exec(handle, { command: "sleep 1", detach: true, ...opts }), "invalid_state")
})

test("a command that ran out of time is a timeout nobody retries for the caller", async () => {
  const { provider } = providerWith(offline, async () => { throw new MicrosandboxDriverError("execTimeout", "exec timed out after 500ms") })
  const handle = await provider.create(spec("slow"), opts)
  const error = await rejectsWith(() => provider.blocks?.run?.(handle, { command: "sleep 60", timeoutMs: 500 }), "timeout")
  assert.equal(error.retryable, false)
})

test("work on a stopped sandbox fails instead of running anywhere else", async () => {
  const { provider, runs } = providerWith()
  const handle = await provider.create(spec("stopped"), opts)
  await provider.stop(handle, opts)
  await rejectsWith(() => provider.blocks?.run?.(handle, { command: "true", ...opts }), "invalid_state")
  await rejectsWith(() => provider.blocks?.files?.read(handle, "/tmp/file", opts), "invalid_state")
  assert.equal(runs.length, 0)
})

test("a crashed sandbox reports an error and starts again only when asked", async () => {
  const { provider, crash } = providerWith()
  const handle = await provider.create(spec("crashed"), opts)
  crash("crashed")
  assert.equal((await provider.inspect(handle)).state, "error")
  await provider.start(handle, opts)
  assert.equal((await provider.inspect(handle)).state, "running")
})

test("a computer that cannot run microVMs is a permanent failure, not something to retry", async () => {
  const unavailable = (): Promise<never> => Promise.reject(new MicrosandboxDriverError("runtimeNotInstalled", "microsandbox runtime is not installed"))
  const provider: SandboxProvider = createMicrosandboxProvider(offline, { driver: { ...fakeDriver().driver, create: unavailable } })
  const error = await rejectsWith(() => provider.create(spec("unavailable"), opts), "invalid_state")
  assert.equal(error.retryable, false)
})

test("file modes are applied in the guest and a failed chmod is reported", async () => {
  const { provider, runs } = providerWith(offline, async () => ({ exitCode: 1, stdout: "", stderr: "chmod: not permitted" }))
  const handle = await provider.create(spec("mode"), opts)
  const files = provider.blocks?.files
  assert.ok(files)
  await rejectsWith(() => files.write(handle, "/tmp/it's.sh", new Uint8Array([35]), { ...opts, mode: 0o755 }), "unknown")
  assert.equal(runs[0]?.command, `chmod 755 '/tmp/it'"'"'s.sh'`)
  await rejectsWith(() => files.write(handle, "/tmp/x", new Uint8Array([35]), { ...opts, mode: 0o7777 }), "invalid_state")
})
