import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"

type ReconcilerModule = typeof import("../src/workers/reconciler.js")
type ReconcileOptions = NonNullable<Parameters<ReconcilerModule["reconcileStaleProvisioningWorkers"]>[0]>
type ReconcileStore = NonNullable<ReconcileOptions["store"]>
type ReconcileWorker = Awaited<ReturnType<ReconcileStore["listStaleWorkers"]>>[number]
type ReconcileToken = Awaited<ReturnType<ReconcileStore["getActiveTokens"]>>[number]
type ContinueProvisioning = NonNullable<ReconcileOptions["continueProvisioning"]>

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "stub"
}

let reconciler: ReconcilerModule

beforeAll(async () => {
  seedRequiredEnv()
  reconciler = await import("../src/workers/reconciler.js")
})

function makeWorker(updatedAt: Date): ReconcileWorker {
  return {
    id: createDenTypeId("worker"),
    org_id: createDenTypeId("org"),
    created_by_user_id: createDenTypeId("user"),
    name: "Cloud",
    description: null,
    destination: "cloud",
    status: "provisioning",
    image_version: null,
    workspace_path: null,
    sandbox_backend: "daytona",
    last_heartbeat_at: null,
    last_active_at: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

function makeTokens(workerId: ReconcileWorker["id"]): ReconcileToken[] {
  const scopes: ReconcileToken["scope"][] = ["host", "client", "activity"]
  return scopes.map((scope) => ({
    id: createDenTypeId("workerToken"),
    worker_id: workerId,
    scope,
    token: `${scope}-token`,
    created_at: new Date("2026-08-26T10:00:00.000Z"),
    revoked_at: null,
  }))
}

function makeReconcileStore(worker: ReconcileWorker, options: { alwaysListStaleSnapshot?: boolean } = {}) {
  let currentWorker = { ...worker }
  let claims = 0
  const tokens = makeTokens(worker.id)
  const store: ReconcileStore = {
    async listStaleWorkers(input) {
      const candidate = options.alwaysListStaleSnapshot ? worker : currentWorker
      return candidate.status === "provisioning" && candidate.updated_at < input.staleBefore
        ? [{ ...candidate }].slice(0, input.limit)
        : []
    },
    async claimWorker(input) {
      if (
        currentWorker.status !== "provisioning"
        || currentWorker.updated_at.getTime() !== input.worker.updated_at.getTime()
        || currentWorker.updated_at >= input.staleBefore
      ) {
        return false
      }

      currentWorker = { ...currentWorker, updated_at: input.claimedAt }
      claims += 1
      return true
    },
    async getActiveTokens(workerId) {
      return tokens.filter((token) => token.worker_id === workerId)
    },
    async markFailed(workerId) {
      if (currentWorker.id === workerId && currentWorker.status === "provisioning") {
        currentWorker = { ...currentWorker, status: "failed" }
      }
    },
  }

  return {
    store,
    get worker() {
      return currentWorker
    },
    get claims() {
      return claims
    },
  }
}

function deferred() {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve: () => resolve?.() }
}

describe("stale cloud provisioning reconciliation", () => {
  test("atomically claims only one of two replicas that selected the same stale worker", async () => {
    const now = new Date("2026-08-26T10:30:00.000Z")
    const state = makeReconcileStore(makeWorker(new Date("2026-08-26T10:00:00.000Z")), {
      alwaysListStaleSnapshot: true,
    })
    let continueCalls = 0
    const continueProvisioning: ContinueProvisioning = async () => {
      continueCalls += 1
    }

    await Promise.all([
      reconciler.reconcileStaleProvisioningWorkers({ store: state.store, continueProvisioning, now, staleMs: 20 * 60_000 }),
      reconciler.reconcileStaleProvisioningWorkers({ store: state.store, continueProvisioning, now, staleMs: 20 * 60_000 }),
    ])

    expect(state.claims).toBe(1)
    expect(continueCalls).toBe(1)
    expect(state.worker.status).toBe("provisioning")
    expect(state.worker.updated_at).toEqual(now)
  })

  test("keeps a second pass two seconds later from reconciling an in-flight claim", async () => {
    const firstPassAt = new Date("2026-08-26T10:30:00.000Z")
    const state = makeReconcileStore(makeWorker(new Date("2026-08-26T10:00:00.000Z")))
    const started = deferred()
    const release = deferred()
    let continueCalls = 0
    const continueProvisioning: ContinueProvisioning = async () => {
      continueCalls += 1
      started.resolve()
      await release.promise
    }

    const firstPass = reconciler.reconcileStaleProvisioningWorkers({
      store: state.store,
      continueProvisioning,
      now: firstPassAt,
      staleMs: 20 * 60_000,
    })
    await started.promise

    const secondPass = await reconciler.reconcileStaleProvisioningWorkers({
      store: state.store,
      continueProvisioning,
      now: new Date(firstPassAt.getTime() + 2_000),
      staleMs: 20 * 60_000,
    })

    expect(secondPass.checked).toBe(0)
    expect(state.claims).toBe(1)
    expect(continueCalls).toBe(1)
    expect(state.worker.status).toBe("provisioning")

    release.resolve()
    await firstPass
  })
})
