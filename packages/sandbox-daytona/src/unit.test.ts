import assert from "node:assert/strict"
import { test } from "node:test"
import { withBlocks } from "@openwork/sandbox"
import { createDaytonaProvider, type DaytonaClient, type DaytonaSandboxClient, type DaytonaProviderConfig, type DaytonaCreateParams } from "./index.js"
import { memorySnapshots } from "./memory-snapshots.js"
function fixture(hang = false, config: Partial<DaytonaProviderConfig> = {}, imageClass = "linux-vm", pauseState = "paused") {
  const paths: string[] = []
  const creates: DaytonaCreateParams[] = []
  const leases: number[] = []
  let state = "started"
  let launches = 0
  let activity = 0
  const box: DaytonaSandboxClient = {
    id: "test", get state() { return state }, target: null, snapshot: "test",
    pause: async () => { state = pauseState }, setTtl: async minutes => { leases.push(minutes) }, refreshActivity: async () => { activity++ },
    refreshData: async () => {}, start: async () => {}, stop: async () => {}, delete: async () => {},
    getSignedPreviewUrl: async () => ({ url: "https://example.com" }),
    fs: {
      createFolder: async p => { paths.push(p) },
      uploadFile: async () => {}, setFilePermissions: async () => {}, deleteFile: async () => {},
      downloadFile: async p => new TextEncoder().encode(p.endsWith("/stderr") ? "error\n\n" : "out without newline"),
      getFileDetails: async () => ({ size: 2, isDir: false }),
    },
    process: {
      createSession: async () => {},
      executeSessionCommand: async () => { launches++; if (hang) return new Promise<never>(() => {}); return { cmdId: "command" } },
      getSessionCommand: async () => ({ exitCode: 7 }),
      getSessionCommandLogs: async () => ({ stdout: "normalized\n", stderr: "normalized\n" }),
    },
  }
  const client: DaytonaClient = { create: async params => { creates.push(params); return box }, get: async () => box, list: async function* () {}, volume: { get: async () => ({ id: "volume", state: "ready" }) }, snapshot: { get: async () => ({ sandboxClass: imageClass }) } }
  const provider = createDaytonaProvider({ apiKey: "not-used", apiUrl: "https://example.com", snapshot: "test", image: "test", resources: { cpu: 1, memoryGb: 1, diskGb: 4 }, helperCreateTimeoutMs: 1000, pollIntervalMs: 1, platform: { os: "linux", isolation: "container" }, ...config }, { client })
  return { provider, paths, creates, leases, launched: () => launches, activity: () => activity }
}
const spec = { workerId: "", idempotencyKey: "test", image: null, env: {}, labels: {}, storage: [], exposePorts: [] }
test("run returns exact streams and exit status, not normalized session logs", async () => {
  const f = fixture()
  const h = await f.provider.create(spec, { timeoutMs: 1000 })
  const result = await withBlocks(f.provider, ["run"]).run(h, { command: "printf example", timeoutMs: 1000 })
  assert.deepEqual(result, { exitCode: 7, stdout: "out without newline", stderr: "error\n\n" })
  assert.equal(f.launched(), 1)
})
test("unsupported shell is rejected before a process launches", async () => {
  const f = fixture()
  const h = await f.provider.create(spec, { timeoutMs: 1000 })
  await assert.rejects(withBlocks(f.provider, ["run"]).run(h, { command: "x", shell: "powershell", timeoutMs: 1000 }), /supports sh only/)
  assert.equal(f.launched(), 0)
})
test("pause is absent until the configured flavor explicitly supports it", () => {
  assert.throws(() => withBlocks(fixture().provider, ["pause"], "job"), /requires pause/)
})

test("unknown launch timeout is not retried and never advertised as a killed command", async () => {
  const f = fixture(true)
  const h = await f.provider.create(spec, { timeoutMs: 1000 })
  await assert.rejects(withBlocks(f.provider, ["run"]).run(h, { command: "side effect", timeoutMs: 20 }), e => {
    assert.ok(e instanceof Error)
    assert.match(e.message, /outcome.*unknown|deadline/)
    return true
  })
  assert.equal(f.launched(), 1)
})

const vm = { supportsPause: true, platform: { os: "linux", isolation: "microvm" } } satisfies Partial<DaytonaProviderConfig>
const vmSpec = { ...spec, image: { id: "test" }, lifecycle: { autoPauseMinutes: 5, autoStopMinutes: 0 } }
test("microVM computers verify the snapshot and enable provider-side idle pause", async () => {
  const f = fixture(false, vm)
  await f.provider.create(vmSpec, { timeoutMs: 1000 })
  assert.equal(f.creates[0]?.autoPauseInterval, 5)
  assert.equal(f.creates[0]?.autoStopInterval, 0)
  assert.equal(f.provider.describe().memorySnapshotRestore, true)
  const wrong = fixture(false, vm, "container")
  await assert.rejects(wrong.provider.create(vmSpec, { timeoutMs: 1000 }), /not a Daytona Linux microVM/)
  assert.equal(wrong.creates.length, 0)
  await assert.rejects(fixture().provider.create(vmSpec, { timeoutMs: 1000 }), /Auto-pause requires/)
  await assert.rejects(f.provider.create({ ...vmSpec, lifecycle: { autoPauseMinutes: 5, autoStopMinutes: 60 } }, { timeoutMs: 1000 }), /mutually exclusive/)
})
test("pausing only succeeds once memory-preserving suspension is confirmed", async () => {
  const f = fixture(false, vm)
  const h = await f.provider.create(vmSpec, { timeoutMs: 1000 })
  await withBlocks(f.provider, ["pause"]).pause(h, { timeoutMs: 1000 })
  assert.equal((await f.provider.inspect(h)).state, "stopped")
  const cold = fixture(false, vm, "linux-vm", "stopped")
  const other = await cold.provider.create(vmSpec, { timeoutMs: 1000 })
  await assert.rejects(withBlocks(cold.provider, ["pause"]).pause(other, { timeoutMs: 1000 }), /did not preserve memory/)
})
test("idle-retention lease renews on work but inventory does not prolong disk costs", async () => {
  const f = fixture(false, { ...vm, idleRetentionMinutes: 1440 })
  const h = await f.provider.create(vmSpec, { timeoutMs: 1000 })
  assert.equal(f.creates[0]?.ttlMinutes, 1440)
  await f.provider.inspect(h)
  await f.provider.find({ idempotencyKey: "test" })
  assert.deepEqual(f.leases, [])
  await withBlocks(f.provider, ["run"]).run(h, { command: "idle probe", activity: "maintenance", timeoutMs: 1000 })
  assert.deepEqual(f.leases, [])
  assert.equal(f.activity(), 0)
  await withBlocks(f.provider, ["run"]).run(h, { command: "work", timeoutMs: 1000 })
  assert.deepEqual(f.leases, [1440])
  await f.provider.inspect(h)
  await withBlocks(f.provider, ["files"]).files.read(h, "/workspace/out/file", { timeoutMs: 1000 })
  assert.deepEqual(f.leases, [1440])
  await withBlocks(f.provider, ["activity"]).activity(h, { timeoutMs: 1000 })
  await withBlocks(f.provider, ["activity"]).activity(h, { timeoutMs: 1000 })
  assert.equal(f.activity(), 1)
  const paused = fixture(false, vm)
  const sleeping = await paused.provider.create(vmSpec, { timeoutMs: 1000 })
  await withBlocks(paused.provider, ["pause"]).pause(sleeping, { timeoutMs: 1000 })
  await withBlocks(paused.provider, ["activity"]).activity(sleeping, { timeoutMs: 1000 })
  assert.equal(paused.activity(), 0)
})
test("hot snapshots capture memory through the world REST contract without replaying a write", async () => {
  let created = false
  let writes = 0
  const deleted: string[] = []
  const snapshots = memorySnapshots({ apiUrl: "https://example.com", apiKey: "test" }, () => "sandbox", async (url, init) => {
    if (init?.method === "DELETE") { deleted.push(String(url)); return new Response(null, { status: 204 }); }
    if (init?.method === "POST") { writes++; assert.deepEqual(JSON.parse(String(init.body)), { name: "owned-checkpoint", includeMemory: true }); created = true; return Response.json({}); }
    return created ? Response.json({ id: "snapshot-id", state: "active" }) : new Response(null, { status: 404 })
  })
  const h = await fixture().provider.create(spec, { timeoutMs: 1000 })
  assert.deepEqual(await snapshots.create(h, "owned-checkpoint", { timeoutMs: 1000 }), { id: "snapshot-id", version: "owned-checkpoint" })
  await assert.rejects(snapshots.create(h, "owned-checkpoint", { timeoutMs: 1000 }), /already exists/)
  assert.equal(writes, 1)
  await snapshots.destroy({ id: "owned-checkpoint", version: "owned-checkpoint" }, { timeoutMs: 1000 })
  assert.deepEqual(deleted, ["https://example.com/snapshots/snapshot-id"])
})

test("an unacknowledged hot-snapshot request is never replayed", async () => {
  let writes = 0
  const snapshots = memorySnapshots({ apiUrl: "https://example.com", apiKey: "test" }, () => "sandbox", async (_url, init) => {
    if (init?.method === "POST") { writes++; throw new Error("connection lost") }
    return new Response(null, { status: 404 })
  })
  const h = await fixture().provider.create(spec, { timeoutMs: 1000 })
  await assert.rejects(snapshots.create(h, "owned-checkpoint", { timeoutMs: 1000 }), /outcome is unknown/)
  assert.equal(writes, 1)
})
