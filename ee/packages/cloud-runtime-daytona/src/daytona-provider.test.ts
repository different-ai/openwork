import { DaytonaConflictError, DaytonaNotFoundError, DaytonaRateLimitError } from "@daytonaio/sdk"
import { isRuntimeProviderError } from "@openwork-ee/cloud-runtime/contract"
import { describe, expect, test } from "bun:test"
import {
  createDaytonaProvider,
  mapDaytonaState,
  type DaytonaClient,
  type DaytonaCreateParams,
  type DaytonaProviderConfig,
  type DaytonaSandboxClient,
} from "./daytona-provider"
import { classifyDaytonaError } from "./errors"

function config(overrides: Partial<DaytonaProviderConfig> = {}): DaytonaProviderConfig {
  return {
    apiKey: "test-key",
    apiUrl: "https://daytona.example/api",
    target: "us",
    snapshot: "openwork-0.18.8",
    image: "node:20-bookworm",
    resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
    pollIntervalMs: 1,
    ...overrides,
  }
}

type FakeSandboxOptions = {
  id: string
  name?: string
  state?: string
  target?: string
  startError?: Error
  stopError?: Error
  exitCodes?: Array<number | null>
  previewUrl?: string
}

function fakeSandbox(options: FakeSandboxOptions) {
  let state = options.state ?? "started"
  const calls: string[] = []
  const commands: Array<{ sessionId: string; command: string; runAsync: boolean; timeout: number | undefined }> = []
  const exitCodes = [...(options.exitCodes ?? [0])]
  const sandbox: DaytonaSandboxClient = {
    get id() {
      return options.id
    },
    get state() {
      return state
    },
    get target() {
      return options.target ?? "us"
    },
    async refreshData() {
      calls.push("refresh")
    },
    async start(timeout) {
      calls.push(`start:${timeout}`)
      if (options.startError) throw options.startError
      state = "started"
    },
    async stop(timeout) {
      calls.push(`stop:${timeout}`)
      if (options.stopError) throw options.stopError
      state = "stopped"
    },
    async delete(timeout) {
      calls.push(`delete:${timeout}`)
      state = "destroyed"
    },
    async getSignedPreviewUrl(port, expiresInSeconds) {
      calls.push(`preview:${port}:${expiresInSeconds}`)
      return { url: options.previewUrl ?? `https://${options.id}.preview.example.test` }
    },
    process: {
      async createSession(sessionId) {
        calls.push(`session:${sessionId}`)
      },
      async executeSessionCommand(sessionId, request, timeout) {
        commands.push({ sessionId, command: request.command, runAsync: request.runAsync, timeout })
        return { cmdId: `cmd_${commands.length}` }
      },
      async getSessionCommand() {
        if (state === "destroyed") throw new DaytonaNotFoundError("sandbox deleted before command result was read")
        const next = exitCodes.length > 1 ? exitCodes.shift() : exitCodes[0]
        return { exitCode: next ?? null }
      },
      async getSessionCommandLogs() {
        if (state === "destroyed") throw new DaytonaNotFoundError("sandbox deleted before command logs were read")
        return { stdout: "out", stderr: "err" }
      },
    },
  }
  return { sandbox, calls, commands, setState: (next: string) => { state = next } }
}

function fakeClient(input: {
  sandboxes?: Record<string, DaytonaSandboxClient>
  onCreate?: (params: DaytonaCreateParams) => DaytonaSandboxClient | Promise<DaytonaSandboxClient>
  volumeStates?: string[]
  listed?: Array<{ id: string }>
}) {
  const created: DaytonaCreateParams[] = []
  const lookups: string[] = []
  const volumeStates = [...(input.volumeStates ?? ["ready"])]
  const client: DaytonaClient = {
    async create(params) {
      created.push(params)
      if (!input.onCreate) throw new Error("create not expected")
      return input.onCreate(params)
    },
    async get(sandboxIdOrName) {
      lookups.push(sandboxIdOrName)
      const sandbox = input.sandboxes?.[sandboxIdOrName]
      if (!sandbox) throw new DaytonaNotFoundError(`sandbox ${sandboxIdOrName} not found`)
      return sandbox
    },
    list() {
      const items = input.listed ?? []
      return (async function* () {
        for (const item of items) yield item
      })()
    },
    volume: {
      async get(name) {
        const state = volumeStates.length > 1 ? volumeStates.shift() : volumeStates[0]
        return { id: `vol_${name}`, state: state ?? "ready" }
      },
    },
  }
  return { client, created, lookups }
}

describe("Daytona state and error mapping", () => {
  test("normalizes host states into the contract vocabulary", () => {
    expect(mapDaytonaState("started")).toBe("running")
    expect(mapDaytonaState("stopped")).toBe("stopped")
    expect(mapDaytonaState("starting")).toBe("starting")
    expect(mapDaytonaState("pulling_snapshot")).toBe("creating")
    expect(mapDaytonaState("destroyed")).toBe("missing")
    expect(mapDaytonaState("build_failed")).toBe("error")
    expect(mapDaytonaState(null)).toBe("error")
  })

  test("classifies SDK errors and message-only errors into the taxonomy", () => {
    expect(classifyDaytonaError(new DaytonaNotFoundError("sandbox missing"))).toBe("not_found")
    expect(classifyDaytonaError(new Error("Request failed with status code 404"))).toBe("not_found")
    expect(classifyDaytonaError(new DaytonaConflictError("Sandbox with name already exists"))).toBe("conflict")
    expect(classifyDaytonaError(new DaytonaConflictError("Sandbox state change in progress"))).toBe("invalid_state")
    expect(classifyDaytonaError(new DaytonaRateLimitError("slow down"))).toBe("rate_limited")
    expect(classifyDaytonaError(new Error("429 Too Many Requests"))).toBe("rate_limited")
    expect(classifyDaytonaError(new Error("insufficient cpu capacity in region"))).toBe("capacity")
    expect(classifyDaytonaError(new Error("Request failed with status code 502"))).toBe("transient")
    expect(classifyDaytonaError(new Error("read ECONNRESET"))).toBe("transient")
    expect(classifyDaytonaError(new Error("something else"))).toBe("unknown")
  })
})

describe("Daytona provider", () => {
  test("describes itself and exposes the pinned snapshot as the current image", () => {
    const provider = createDaytonaProvider(config(), { client: fakeClient({}).client })
    expect(provider.id).toBe("daytona")
    expect(provider.describe()).toMatchObject({ stopResume: true, endpointKind: "signed-expiring", exec: true, regions: ["us"] })
    expect(provider.currentImage()).toEqual({ id: "openwork-0.18.8", version: "openwork-0.18.8" })
    expect(createDaytonaProvider(config({ snapshot: null }), { client: fakeClient({}).client }).currentImage()).toBeNull()
  })

  test("creates from the pinned snapshot with the spec's identity, mounts, and lifecycle", async () => {
    const created = fakeSandbox({ id: "sbx_new", state: "started" })
    const fake = fakeClient({ onCreate: () => created.sandbox })
    const provider = createDaytonaProvider(config(), { client: fake.client })

    const handle = await provider.create({
      workerId: "worker_1",
      idempotencyKey: "den-worker-cloud-abc",
      image: provider.currentImage(),
      resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
      labels: { "openwork.den.worker-id": "worker_1" },
      env: { DEN_WORKER_ID: "worker_1" },
      storage: [{ volume: { providerId: "daytona", id: "vol_1", name: "den" }, mountPath: "/workspace", subpath: "workers/worker_1/workspace" }],
      exposePorts: [8787],
      lifecycle: { autoStopMinutes: 0, autoArchiveMinutes: 10080, autoDeleteMinutes: -1 },
      public: false,
    }, { timeoutMs: 300_000 })

    expect(handle).toMatchObject({ ref: { providerId: "daytona", ref: { sandboxId: "sbx_new" } }, state: "running", region: "us" })
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]).toMatchObject({
      name: "den-worker-cloud-abc",
      snapshot: "openwork-0.18.8",
      labels: { "openwork.den.worker-id": "worker_1" },
      envVars: { DEN_WORKER_ID: "worker_1" },
      volumes: [{ volumeId: "vol_1", mountPath: "/workspace", subpath: "workers/worker_1/workspace" }],
      autoStopInterval: 0,
      autoArchiveInterval: 10080,
      autoDeleteInterval: -1,
      public: false,
    })
    expect("resources" in (fake.created[0] ?? {})).toBe(false)
  })

  test("falls back to the base image with resources when no snapshot is pinned", async () => {
    const created = fakeSandbox({ id: "sbx_image" })
    const fake = fakeClient({ onCreate: () => created.sandbox })
    const provider = createDaytonaProvider(config({ snapshot: null }), { client: fake.client })

    await provider.create({
      workerId: "worker_1",
      idempotencyKey: "den-worker",
      image: null,
      labels: {},
      env: {},
      storage: [],
      exposePorts: [8787],
    }, { timeoutMs: 1_000 })

    expect(fake.created[0]).toMatchObject({ image: "node:20-bookworm", resources: { cpu: 2, memory: 4, disk: 8 } })
  })

  test("translates create conflicts and missing lookups without leaking SDK errors", async () => {
    const fake = fakeClient({
      onCreate: () => {
        throw new DaytonaConflictError("Sandbox with name already exists")
      },
    })
    const provider = createDaytonaProvider(config(), { client: fake.client })
    const spec = { workerId: "w", idempotencyKey: "taken", image: null, labels: {}, env: {}, storage: [], exposePorts: [] }

    const failure = await provider.create(spec, { timeoutMs: 1_000 }).catch((error: unknown) => error)
    expect(isRuntimeProviderError(failure) && failure.code).toBe("conflict")
    expect(await provider.find({ idempotencyKey: "nope" })).toBeNull()
    expect(await provider.get({ providerId: "daytona", ref: { sandboxId: "nope" } })).toBeNull()
  })

  test("find by name refreshes state and get returns a fresh handle", async () => {
    const existing = fakeSandbox({ id: "sbx_1", state: "stopped" })
    const fake = fakeClient({ sandboxes: { "den-name": existing.sandbox, sbx_1: existing.sandbox } })
    const provider = createDaytonaProvider(config(), { client: fake.client })

    const found = await provider.find({ idempotencyKey: "den-name" })
    expect(found?.state).toBe("stopped")
    expect(existing.calls).toContain("refresh")

    existing.setState("started")
    const inspected = await provider.inspect(found!)
    expect(inspected.state).toBe("running")
    expect(fake.lookups).toEqual(["den-name"])
  })

  test("find by labels takes the first listed instance", async () => {
    const orphan = fakeSandbox({ id: "sbx_orphan", state: "stopped" })
    const fake = fakeClient({ listed: [{ id: "sbx_orphan" }], sandboxes: { sbx_orphan: orphan.sandbox } })
    const provider = createDaytonaProvider(config(), { client: fake.client })

    const found = await provider.find({ labels: { "openwork.den.worker-id": "w" } })
    expect(found?.ref.ref.sandboxId).toBe("sbx_orphan")
    expect(await createDaytonaProvider(config(), { client: fakeClient({}).client }).find({ labels: { x: "y" } })).toBeNull()
  })

  test("start maps a state-change conflict to a retryable invalid_state", async () => {
    const stuck = fakeSandbox({ id: "sbx_stuck", state: "stopped", startError: new DaytonaConflictError("Sandbox state change in progress") })
    const provider = createDaytonaProvider(config(), { client: fakeClient({ sandboxes: { sbx_stuck: stuck.sandbox } }).client })
    const handle = (await provider.get({ providerId: "daytona", ref: { sandboxId: "sbx_stuck" } }))!

    const failure = await provider.start(handle, { timeoutMs: 300_000 }).catch((error: unknown) => error)

    expect(isRuntimeProviderError(failure) && failure.code).toBe("invalid_state")
    expect(isRuntimeProviderError(failure) && failure.retryable).toBe(true)
    expect(stuck.calls).toContain("start:300")
  })

  test("inspect reports a destroyed instance as missing instead of throwing", async () => {
    const provider = createDaytonaProvider(config(), { client: fakeClient({}).client })
    const inspected = await provider.inspect({ ref: { providerId: "daytona", ref: { sandboxId: "gone" } }, state: "running", region: null, observedAt: 0 })
    expect(inspected.state).toBe("missing")
  })

  test("exec runs through a session, waits for completion when not detached, and exposes logs", async () => {
    const sandbox = fakeSandbox({ id: "sbx_exec", exitCodes: [null, null, 0] })
    const provider = createDaytonaProvider(config(), { client: fakeClient({ sandboxes: { sbx_exec: sandbox.sandbox } }).client, sleep: async () => undefined })
    const handle = (await provider.get({ providerId: "daytona", ref: { sandboxId: "sbx_exec" } }))!

    const detached = await provider.exec(handle, { command: "sh -lc start", detach: true, timeoutMs: 0, sessionId: "openwork-abc" })
    expect(sandbox.commands[0]).toEqual({ sessionId: "openwork-abc", command: "sh -lc start", runAsync: true, timeout: 0 })
    expect(detached.id).toBe("openwork-abc/cmd_1")

    const sync = await provider.exec(handle, { command: "test -e marker", detach: false, timeoutMs: 5_000 })
    expect(sandbox.commands[1]).toMatchObject({ command: "test -e marker", runAsync: false, timeout: 5 })
    expect(await sync.exitCode()).toBe(0)
    expect(await sync.logs()).toEqual({ stdout: "out", stderr: "err" })
  })

  test("endpoint caps the signed preview lifetime at 24 hours and reports expiry", async () => {
    const sandbox = fakeSandbox({ id: "sbx_ep" })
    const now = 1_000_000
    const provider = createDaytonaProvider(config(), { client: fakeClient({ sandboxes: { sbx_ep: sandbox.sandbox } }).client, now: () => now })
    const handle = (await provider.get({ providerId: "daytona", ref: { sandboxId: "sbx_ep" } }))!

    const endpoint = await provider.endpoint(handle, 8787, { ttlSeconds: 999_999 })

    expect(endpoint).toEqual({ url: "https://sbx_ep.preview.example.test", expiresAt: new Date(now + 86_400_000), kind: "signed-expiring" })
    expect(sandbox.calls).toContain("preview:8787:86400")
  })

  test("ensureVolume waits for the shared volume to become ready", async () => {
    const fake = fakeClient({ volumeStates: ["pending", "pending", "ready"] })
    const provider = createDaytonaProvider(config(), { client: fake.client, sleep: async () => undefined })

    const volume = await provider.storage.ensureVolume("Den Daytona Workers", { timeoutMs: 10_000 })

    expect(volume).toEqual({ providerId: "daytona", id: "vol_den-daytona-workers", name: "den-daytona-workers" })
  })

  test("exists probes the checkpoint directory through a short-lived helper mounted at the subpath", async () => {
    const helper = fakeSandbox({ id: "sbx_probe", exitCodes: [0] })
    const fake = fakeClient({ onCreate: () => helper.sandbox })
    const provider = createDaytonaProvider(config(), { client: fake.client, sleep: async () => undefined, randomSuffix: () => "abcd1234" })

    const exists = await provider.storage.exists!(
      { providerId: "daytona", id: "vol_1", name: "den" },
      "workers/worker_1/data/checkpoints/ckpt-*.tar",
      { timeoutMs: 30_000 },
    )

    expect(exists).toBe(true)
    expect(fake.created[0]).toMatchObject({
      name: "den-daytona-probe-abcd1234",
      snapshot: "openwork-0.18.8",
      ephemeral: true,
      envVars: { DEN_RUNTIME_PROVIDER: "daytona-checkpoint-probe" },
      volumes: [{ volumeId: "vol_1", mountPath: "/mnt/openwork-probe", subpath: "workers/worker_1/data/checkpoints" }],
    })
    expect(helper.commands[0]?.command).toContain("/mnt/openwork-probe")
    expect(helper.commands[0]?.command).toContain("-maxdepth 1 -name")
    expect(helper.commands[0]?.command).toContain("ckpt-*.tar")
    expect(helper.commands[0]?.runAsync).toBe(false)
    expect(helper.calls).toContain("delete:30")
  })

  test("eraseSubpaths clears only the mounted worker subpaths and always deletes the helper", async () => {
    const helper = fakeSandbox({ id: "sbx_cleanup", exitCodes: [0] })
    const fake = fakeClient({ onCreate: () => helper.sandbox })
    const provider = createDaytonaProvider(config(), { client: fake.client, sleep: async () => undefined, randomSuffix: () => "abcd1234" })

    await provider.storage.eraseSubpaths(
      { providerId: "daytona", id: "vol_1", name: "den" },
      ["workers/worker_1/workspace", "workers/worker_1/data"],
      { timeoutMs: 120_000 },
    )

    expect(fake.created[0]).toMatchObject({
      name: "den-daytona-cleanup-abcd1234",
      image: "node:20-bookworm",
      resources: { cpu: 1, memory: 1, disk: 4 },
      envVars: { DEN_RUNTIME_PROVIDER: "daytona-cleanup" },
      volumes: [
        { volumeId: "vol_1", mountPath: "/mnt/openwork-erase/0", subpath: "workers/worker_1/workspace" },
        { volumeId: "vol_1", mountPath: "/mnt/openwork-erase/1", subpath: "workers/worker_1/data" },
      ],
    })
    expect(helper.commands[0]?.command).toContain("/mnt/openwork-erase/0")
    expect(helper.commands[0]?.command).toContain("/mnt/openwork-erase/1")
    expect(helper.commands[0]?.command).toContain("fs.rmSync")
    expect(helper.calls).toContain("delete:120")
  })
})
