import { RuntimeProviderError } from "@openwork-ee/cloud-runtime/contract"
import { CloudRuntimeError, createCloudRuntimeOrchestrator, type CloudRuntimeOrchestratorConfig } from "@openwork-ee/cloud-runtime/orchestrator"
import { createFakeProvider, createInMemoryRuntimeInstanceStore, type FakeOperation } from "@openwork-ee/cloud-runtime/testing"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"

type CloudLifecycleModule = typeof import("../src/workers/cloud-lifecycle.js")
type WakeCloudWorkerOptions = NonNullable<Parameters<CloudLifecycleModule["wakeCloudWorker"]>[1]>
type Store = NonNullable<WakeCloudWorkerOptions["store"]>
type TestWorker = NonNullable<Awaited<ReturnType<Store["getWorker"]>>>
type TestWorkerToken = Awaited<ReturnType<Store["getActiveTokens"]>>[number]
type StatusUpdate = Parameters<Store["updateWorkerStatus"]>[0]
type ListIdleInput = Parameters<Store["listIdleWorkers"]>[0]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "stub"
}

let lifecycle: CloudLifecycleModule

beforeAll(async () => {
  seedRequiredEnv()
  lifecycle = await import("../src/workers/cloud-lifecycle.js")
})

function makeWorker(input: {
  status: TestWorker["status"]
  lastActiveAt?: Date | null
  updatedAt?: Date
}): TestWorker {
  const now = new Date("2026-07-25T12:00:00.000Z")
  return {
    id: createDenTypeId("worker"),
    name: "Cloud",
    status: input.status,
    last_active_at: input.lastActiveAt ?? null,
    updated_at: input.updatedAt ?? now,
  }
}

function makeToken(workerId: TestWorker["id"], scope: TestWorkerToken["scope"]): TestWorkerToken {
  return {
    id: createDenTypeId("workerToken"),
    worker_id: workerId,
    scope,
    token: `${scope}-token`,
    created_at: new Date("2026-07-25T12:00:00.000Z"),
    revoked_at: null,
  }
}

function makeStore(input: { workers: TestWorker[]; tokens?: TestWorkerToken[] }) {
  const updates: StatusUpdate[] = []
  const tokens = input.tokens ?? []
  let touches = 0
  const store: Store = {
    async touchProvisioningWorker(workerId) {
      const worker = input.workers.find((entry) => entry.id === workerId)
      if (!worker || worker.status !== "provisioning") return
      worker.updated_at = new Date()
      touches += 1
    },
    async getWorker(workerId) {
      return input.workers.find((worker) => worker.id === workerId) ?? null
    },
    async getActiveTokens(workerId) {
      return tokens.filter((token) => token.worker_id === workerId && !token.revoked_at)
    },
    async reserveWake(workerId) {
      const worker = input.workers.find((entry) => entry.id === workerId)
      if (!worker || worker.status !== "stopped") return false
      worker.status = "provisioning"
      updates.push({ workerId, status: "provisioning", onlyWhenStatus: "stopped" })
      return true
    },
    async listIdleWorkers(listInput: ListIdleInput) {
      return input.workers
        .filter((worker) => worker.status === "healthy" && lifecycle.isCloudWorkerIdleForStop(worker, listInput.idleBefore))
        .slice(0, listInput.limit)
    },
    async reserveIdleStop({ workerId, idleBefore }) {
      const worker = input.workers.find((entry) => entry.id === workerId)
      if (!worker || worker.status !== "healthy" || !lifecycle.isCloudWorkerIdleForStop(worker, idleBefore)) return false
      worker.status = "provisioning"
      updates.push({ workerId, status: "provisioning", onlyWhenStatus: "healthy" })
      return true
    },
    async updateWorkerStatus(update) {
      const worker = input.workers.find((entry) => entry.id === update.workerId)
      if (!worker) {
        return
      }
      if (update.onlyWhenStatus && worker.status !== update.onlyWhenStatus) {
        return
      }

      worker.status = update.status
      updates.push(update)
    },
  }

  return {
    store,
    updates,
    get touches() {
      return touches
    },
  }
}

const imageVersion = "openwork-0.18.8"

function orchestratorConfig(): CloudRuntimeOrchestratorConfig {
  return {
    instanceNamePrefix: "den-cloud-worker",
    sharedVolumeName: "den-cloud-workers",
    workspaceMountPath: "/workspace",
    dataMountPath: "/persist/openwork",
    runtimeWorkspacePath: "/tmp/openwork-workspace",
    runtimeDataPath: "/tmp/openwork-data",
    sidecarDir: "/tmp/openwork-sidecars",
    checkpointIntervalSeconds: 300,
    checkpointKeep: 3,
    port: 8787,
    publicEndpoint: false,
    lifecycle: {},
    resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
    endpointTtlSeconds: 86_400,
    endpointRefreshLeadMs: 300_000,
    createTimeoutMs: 300_000,
    stopTimeoutMs: 120_000,
    destroyTimeoutMs: 120_000,
    healthcheckTimeoutMs: 300_000,
    pollIntervalMs: 1_000,
    activityHeartbeatUrl: (workerId) => `https://den.example/v1/workers/${workerId}/activity-heartbeat`,
    bootstrap: { imageDescription: "test runtime image", rebuildHint: "rebuild the test image" },
  }
}

/** A real orchestrator over the in-memory fake host, seeded with one stopped instance for the worker. */
function makeWakeRuntime(input: {
  workerId: TestWorker["id"]
  startError?: Error
  onOperation?: (operation: FakeOperation, controls: { setRunning: () => void }) => void
} = { workerId: createDenTypeId("worker") }) {
  let sandboxId = ""
  let healthChecks = 0
  const provider = createFakeProvider({
    image: { id: imageVersion, version: imageVersion },
    onOperation: (operation) => {
      if (operation.name === "start" && operation.attempt === 1 && input.startError) throw input.startError
      input.onOperation?.(operation, { setRunning: () => provider.fake.setState(sandboxId, "running") })
    },
  })
  sandboxId = provider.fake.seed({ idempotencyKey: "sbx-wake-test", state: "stopped" }).id
  const store = createInMemoryRuntimeInstanceStore()
  store.records.set(input.workerId, {
    workerId: input.workerId,
    sandbox: { providerId: "fake", ref: { sandboxId } },
    storage: { workspaceVolumeId: "vol_shared", dataVolumeId: "vol_shared" },
    endpointUrl: "https://wake.preview.example.test",
    endpointExpiresAt: new Date("2026-07-25T12:00:00.000Z"),
    region: "us-test",
  })
  store.imageVersions.set(input.workerId, imageVersion)
  const orchestrator = createCloudRuntimeOrchestrator({
    provider,
    store,
    config: orchestratorConfig(),
    logger: { warn: () => undefined },
    fetch: async () => {
      healthChecks += 1
      return new Response(null, { status: 200 })
    },
    sleep: async () => undefined,
  })

  return {
    orchestrator,
    get startCalls() {
      return provider.fake.count("start", sandboxId)
    },
    get healthChecks() {
      return healthChecks
    },
  }
}

function deferred() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return {
    promise,
    resolve() {
      resolve?.()
    },
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("cloud lifecycle idle stop", () => {
  test("uses last_active_at when present and falls back to updated_at when last_active_at is null", () => {
    const idleBefore = new Date("2026-07-25T12:00:00.000Z")
    const idleActivity = makeWorker({
      status: "healthy",
      lastActiveAt: new Date("2026-07-25T11:00:00.000Z"),
      updatedAt: new Date("2026-07-25T11:55:00.000Z"),
    })
    const activeActivity = makeWorker({
      status: "healthy",
      lastActiveAt: new Date("2026-07-25T12:05:00.000Z"),
      updatedAt: new Date("2026-07-25T11:00:00.000Z"),
    })
    const idleByUpdatedAt = makeWorker({
      status: "healthy",
      lastActiveAt: null,
      updatedAt: new Date("2026-07-25T11:00:00.000Z"),
    })
    const activeByUpdatedAt = makeWorker({
      status: "healthy",
      lastActiveAt: null,
      updatedAt: new Date("2026-07-25T12:05:00.000Z"),
    })

    expect(lifecycle.isCloudWorkerIdleForStop(idleActivity, idleBefore)).toBe(true)
    expect(lifecycle.isCloudWorkerIdleForStop(activeActivity, idleBefore)).toBe(false)
    expect(lifecycle.isCloudWorkerIdleForStop(idleByUpdatedAt, idleBefore)).toBe(true)
    expect(lifecycle.isCloudWorkerIdleForStop(activeByUpdatedAt, idleBefore)).toBe(false)
  })

  test("does not start the loop when the interval is disabled", () => {
    let runs = 0
    const stop = lifecycle.startCloudIdleStopLoop(0, {
      stopIdleWorkers: async () => {
        runs += 1
      },
    })

    expect(stop()).toBeUndefined()
    expect(runs).toBe(0)
  })

  test("marks stopped only when the host stop succeeds", async () => {
    const idleBefore = new Date("2026-07-25T12:00:00.000Z")
    const stoppedWorker = makeWorker({
      status: "healthy",
      lastActiveAt: new Date("2026-07-25T11:00:00.000Z"),
    })
    const retryWorker = makeWorker({
      status: "healthy",
      lastActiveAt: new Date("2026-07-25T11:10:00.000Z"),
    })
    const { store } = makeStore({ workers: [stoppedWorker, retryWorker] })
    const result = await lifecycle.stopIdleCloudWorkers({
      store,
      provisionerMode: "daytona",
      idleBefore,
      batchSize: 10,
      stopWorker: async (workerId) => {
        if (workerId === retryWorker.id) {
          throw new Error("stop failed")
        }
        return { status: "stopped" }
      },
    })

    expect(result).toEqual({ checked: 2, stopped: 1 })
    expect(stoppedWorker.status).toBe("stopped")
    expect(retryWorker.status).toBe("healthy")
  })
})

describe("cloud lifecycle wake", () => {
  test("marks the worker failed when wake exceeds the provisioning deadline", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: () => new Promise<never>(() => {}),
      deadlineMs: 20,
    })

    expect(updates).toContainEqual(expect.objectContaining({
      workerId: worker.id,
      status: "failed",
      failure: expect.objectContaining({ code: "provisioning_timeout", stage: "recovery" }),
      onlyWhenStatus: "provisioning",
    }))
  })

  test("records a fast successful wake without a failed write", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => ({
        provider: "daytona",
        url: "https://cloud.example",
        status: "healthy",
        imageVersion: "openwork-0.18.8",
      }),
      deadlineMs: 5000,
    })

    expect(updates).toContainEqual({
      workerId: worker.id,
      status: "healthy",
      imageVersion: "openwork-0.18.8",
      failure: null,
      onlyWhenStatus: "provisioning",
    })
    expect(updates.some((update) => update.status === "failed")).toBe(false)
  })

  test("materializes providers against the fresh signed preview returned by wake", async () => {
    const worker = {
      ...makeWorker({ status: "stopped" }),
      org_id: createDenTypeId("organization"),
    }
    const { store } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    const materializedUrls: string[] = []

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => ({
        provider: "daytona",
        url: "https://wake.preview.example.test",
        status: "healthy",
      }),
      materializeProviders: async (input) => {
        materializedUrls.push(input.instanceUrl)
        return { ok: true, status: "noop", fingerprint: "owp:v1:test", providers: 0 }
      },
    })

    expect(materializedUrls).toEqual(["https://wake.preview.example.test"])
  })

  test("runs one provider action for an explicitly claimed recovery", async () => {
    const worker = makeWorker({ status: "provisioning" })
    const { store } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    const hold = deferred()
    let providerActions = 0
    const recover = () => lifecycle.recoverClaimedCloudWorker(worker.id, {
      store,
      wakeWorker: async () => {
        providerActions += 1
        await hold.promise
        return { provider: "daytona", url: "https://recovery.preview.example.test", status: "healthy" }
      },
    })

    const first = recover()
    const second = recover()
    await flushMicrotasks()
    expect(providerActions).toBe(1)
    hold.resolve()
    await Promise.all([first, second])

    expect(worker.status).toBe("healthy")
    expect(providerActions).toBe(1)
  })

  test("marks the worker failed when a wake token is missing", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
      ],
    })
    let wakeExecutions = 0

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => {
        wakeExecutions += 1
        return { provider: "daytona", url: "https://cloud.example", status: "healthy" }
      },
    })

    expect(wakeExecutions).toBe(0)
    expect(worker.status).toBe("failed")
    expect(updates.map((update) => update.status)).toEqual(["provisioning", "failed"])
  })

  test("runs one host wake for concurrent calls to the same worker", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    const hold = deferred()
    let wakeExecutions = 0

    const first = lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => {
        wakeExecutions += 1
        await hold.promise
        return { provider: "daytona", url: "https://cloud.example", status: "healthy" }
      },
    })
    const second = lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => {
        wakeExecutions += 1
        return { provider: "daytona", url: "https://cloud.example", status: "healthy" }
      },
    })

    await flushMicrotasks()
    expect(wakeExecutions).toBe(1)

    hold.resolve()
    await Promise.all([first, second])
    expect(worker.status).toBe("healthy")
  })

  test("keeps a worker provisioning while a host start conflict converges healthy", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    const wakeRuntime = makeWakeRuntime({
      workerId: worker.id,
      startError: new RuntimeProviderError({ providerId: "fake", code: "invalid_state", message: "Sandbox state change in progress" }),
      // The host reports "stopped" once more, then converges to running while
      // the orchestrator waits for the conflicting start to settle.
      onOperation: (operation, controls) => {
        if (operation.name === "inspect" && operation.attempt === 3) controls.setRunning()
      },
    })

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: (wakeInput) => wakeRuntime.orchestrator.wake(wakeInput),
    })

    expect(worker.status).toBe("healthy")
    expect(wakeRuntime.startCalls).toBe(1)
    expect(wakeRuntime.healthChecks).toBe(1)
    expect(updates.map((update) => update.status)).toEqual(["provisioning", "healthy"])
  })

  test("writes the image version returned by a successful wake", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => ({
        provider: "daytona",
        url: "https://cloud.example",
        status: "healthy",
        imageVersion: "openwork-0.18.8",
      }),
    })

    expect(worker.status).toBe("healthy")
    expect(updates[1]?.status).toBe("healthy")
    expect(updates[1]?.imageVersion).toBe("openwork-0.18.8")
  })

  test("marks the worker failed when an existing sandbox cannot be started", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    let wakeExecutions = 0
    let provisionExecutions = 0

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => {
        wakeExecutions += 1
        throw new Error("start failed")
      },
      provisionWorker: async () => {
        provisionExecutions += 1
        return { provider: "daytona", url: "https://cloud.example", status: "healthy" }
      },
    })

    expect(wakeExecutions).toBe(1)
    expect(provisionExecutions).toBe(0)
    expect(worker.status).toBe("failed")
  })

  test("marks the worker failed after bounded host start retries", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    const wakeRuntime = makeWakeRuntime({
      workerId: worker.id,
      onOperation: (operation) => {
        if (operation.name === "start") {
          throw new RuntimeProviderError({ providerId: "fake", code: "transient", message: "Request failed with status code 502" })
        }
      },
    })

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: (wakeInput) => wakeRuntime.orchestrator.wake(wakeInput),
    })

    expect(worker.status).toBe("failed")
    expect(wakeRuntime.startCalls).toBe(3)
    expect(wakeRuntime.healthChecks).toBe(0)
    expect(updates.map((update) => update.status)).toEqual(["provisioning", "failed"])
  })

  test("falls back to full provisioning when the instance is missing during wake", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    let wakeExecutions = 0
    let provisionExecutions = 0

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: async () => {
        wakeExecutions += 1
        throw new CloudRuntimeError("instance_missing", "instance deleted")
      },
      provisionWorker: async () => {
        provisionExecutions += 1
        return { provider: "daytona", url: "https://cloud.example", status: "healthy" }
      },
    })

    expect(wakeExecutions).toBe(1)
    expect(provisionExecutions).toBe(1)
    expect(worker.status).toBe("healthy")
  })
})
