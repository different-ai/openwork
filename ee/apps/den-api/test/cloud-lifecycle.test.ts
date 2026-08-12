import { DaytonaConflictError } from "@daytonaio/sdk"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import type { DaytonaProvisioningRuntime, DaytonaSandboxRuntime } from "../src/workers/daytona.js"

type CloudLifecycleModule = typeof import("../src/workers/cloud-lifecycle.js")
type DaytonaModule = typeof import("../src/workers/daytona.js")
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
let daytona: DaytonaModule

beforeAll(async () => {
  seedRequiredEnv()
  lifecycle = await import("../src/workers/cloud-lifecycle.js")
  daytona = await import("../src/workers/daytona.js")
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
  const store: Store = {
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

  return { store, updates }
}

function makeDaytonaWakeRuntime(input: {
  startError?: Error
  refreshStates?: string[]
} = {}) {
  let state = "stopped"
  let startCalls = 0
  let refreshCalls = 0
  let healthChecks = 0
  const sandbox = {
    id: "sbx_wake_test",
    get state() {
      return state
    },
    get target() {
      return "us-test"
    },
    async refreshData() {
      const refreshState = input.refreshStates?.[refreshCalls]
      refreshCalls += 1
      if (refreshState !== undefined) {
        state = refreshState
      }
    },
    async start() {
      startCalls += 1
      if (input.startError) {
        throw input.startError
      }
      state = "started"
    },
    async delete() {},
    async getSignedPreviewUrl() {
      return { url: "https://wake.preview.example.test" }
    },
    process: {
      async createSession() {},
      async executeSessionCommand() {
        return { cmdId: "cmd_1" }
      },
      async getSessionCommand() {
        return { exitCode: null }
      },
      async getSessionCommandLogs() {
        return { stdout: "", stderr: "" }
      },
    },
  } satisfies DaytonaSandboxRuntime
  const runtime = {
    async getVolume() {
      return { id: "vol_shared", state: "ready" }
    },
    async getSandbox() {
      return sandbox
    },
    async createSandbox() {
      throw new Error("unexpected sandbox create")
    },
    async upsertSandbox() {},
    async checkpointExists() {
      return false
    },
    async verifyRestoreMarker() {
      return false
    },
    async waitForHealth() {
      healthChecks += 1
    },
  } satisfies DaytonaProvisioningRuntime

  return {
    runtime,
    record: { sandbox_id: sandbox.id, workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
    get startCalls() {
      return startCalls
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

  test("marks stopped only when the Daytona stop succeeds", async () => {
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

  test("runs one Daytona wake for concurrent calls to the same worker", async () => {
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

  test("keeps a worker provisioning while a Daytona start conflict converges healthy", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    const wakeRuntime = makeDaytonaWakeRuntime({
      startError: new DaytonaConflictError("Sandbox state change in progress"),
      refreshStates: ["stopped", "started"],
    })

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: (wakeInput) => daytona.wakeWorkerOnDaytonaWithRuntime(
        wakeInput,
        wakeRuntime.runtime,
        wakeRuntime.record,
        "openwork-0.18.8",
      ),
    })

    expect(worker.status).toBe("healthy")
    expect(wakeRuntime.startCalls).toBe(1)
    expect(wakeRuntime.healthChecks).toBe(1)
    expect(updates.map((update) => update.status)).toEqual(["provisioning", "healthy"])
  })

  test("writes the image version returned by a successful Daytona wake", async () => {
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

  test("marks the worker failed after bounded Daytona start retries", async () => {
    const worker = makeWorker({ status: "stopped" })
    const { store, updates } = makeStore({
      workers: [worker],
      tokens: [
        makeToken(worker.id, "host"),
        makeToken(worker.id, "client"),
        makeToken(worker.id, "activity"),
      ],
    })
    const wakeRuntime = makeDaytonaWakeRuntime({
      startError: new Error("Request failed with status code 502"),
    })

    await lifecycle.wakeCloudWorker(worker.id, {
      store,
      wakeWorker: (wakeInput) => daytona.wakeWorkerOnDaytonaWithRuntime(
        wakeInput,
        wakeRuntime.runtime,
        wakeRuntime.record,
        "openwork-0.18.8",
      ),
    })

    expect(worker.status).toBe("failed")
    expect(wakeRuntime.startCalls).toBe(3)
    expect(wakeRuntime.healthChecks).toBe(0)
    expect(updates.map((update) => update.status)).toEqual(["provisioning", "failed"])
  })

  test("falls back to full provisioning when the Daytona sandbox is missing during wake", async () => {
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
        throw new daytona.DaytonaSandboxMissingError("sandbox deleted")
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
