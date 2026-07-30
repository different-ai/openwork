import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"

type SharedModule = typeof import("../src/routes/workers/shared.js")
type ContinueOptions = NonNullable<Parameters<SharedModule["continueCloudProvisioning"]>[1]>
type ProvisioningStore = NonNullable<ContinueOptions["store"]>
type ProvisionWorker = NonNullable<ContinueOptions["provisionWorker"]>
type StatusUpdate = Parameters<ProvisioningStore["updateWorkerStatus"]>[0]
type WorkerStatus = StatusUpdate["status"]
type ProvisionedWorker = Parameters<ProvisioningStore["insertWorkerInstance"]>[0]["provisioned"]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "stub"
}

beforeAll(() => {
  seedRequiredEnv()
})

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

async function loadSharedModuleCopy(label: string): Promise<SharedModule> {
  return import(`../src/routes/workers/shared.js?${label}-${crypto.randomUUID()}`)
}

function healthyProvisioned(): ProvisionedWorker {
  return {
    provider: "daytona",
    url: "https://cloud.example.test",
    status: "healthy",
    region: "us",
  }
}

function makeProvisioningStore(initialStatus: WorkerStatus) {
  let status = initialStatus
  const updates: StatusUpdate[] = []
  const instances: ProvisionedWorker[] = []
  const store: ProvisioningStore = {
    async updateWorkerStatus(update) {
      updates.push(update)
      if (update.onlyWhenStatus && status !== update.onlyWhenStatus) {
        return
      }

      if (update.onlyWhenStatusIn && !update.onlyWhenStatusIn.includes(status)) {
        return
      }

      status = update.status
    },
    async insertWorkerInstance(input) {
      instances.push(input.provisioned)
    },
  }

  return {
    store,
    updates,
    instances,
    get status() {
      return status
    },
  }
}

function provisioningInput() {
  return {
    workerId: createDenTypeId("worker"),
    name: "Cloud — Race",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  }
}

describe("cloud provisioning state machine", () => {
  test("success wins when a fast stale failure records failed before the winner finishes", async () => {
    const [winnerModule, loserModule] = await Promise.all([
      loadSharedModuleCopy("race-winner"),
      loadSharedModuleCopy("race-loser"),
    ])
    const state = makeProvisioningStore("provisioning")
    const input = provisioningInput()
    const releaseWinner = deferred()
    const winnerProvision: ProvisionWorker = async () => {
      await releaseWinner.promise
      return healthyProvisioned()
    }
    const loserProvision: ProvisionWorker = async () => {
      throw new Error("14:55 loser failed")
    }

    const winner = winnerModule.continueCloudProvisioning(input, { store: state.store, provisionWorker: winnerProvision })
    const loser = loserModule.continueCloudProvisioning(input, { store: state.store, provisionWorker: loserProvision })

    await loser
    expect(state.status).toBe("failed")
    releaseWinner.resolve()
    await winner

    expect(state.status).toBe("healthy")
    expect(state.updates.map((update) => ({ status: update.status, onlyWhenStatus: update.onlyWhenStatus, onlyWhenStatusIn: update.onlyWhenStatusIn }))).toEqual([
      { status: "failed", onlyWhenStatus: "provisioning", onlyWhenStatusIn: undefined },
      { status: "healthy", onlyWhenStatus: undefined, onlyWhenStatusIn: ["provisioning", "failed"] },
    ])
  })

  test("a stale failure cannot clobber a recorded success", async () => {
    const [winnerModule, loserModule] = await Promise.all([
      loadSharedModuleCopy("inverse-winner"),
      loadSharedModuleCopy("inverse-loser"),
    ])
    const state = makeProvisioningStore("provisioning")
    const input = provisioningInput()
    const releaseLoser = deferred()
    const winnerProvision: ProvisionWorker = async () => healthyProvisioned()
    const loserProvision: ProvisionWorker = async () => {
      await releaseLoser.promise
      throw new Error("stale loser failed")
    }

    const winner = winnerModule.continueCloudProvisioning(input, { store: state.store, provisionWorker: winnerProvision })
    const loser = loserModule.continueCloudProvisioning(input, { store: state.store, provisionWorker: loserProvision })

    await winner
    await flushMicrotasks()
    expect(state.status).toBe("healthy")
    releaseLoser.resolve()
    await loser

    expect(state.status).toBe("healthy")
    expect(state.updates.map((update) => ({ status: update.status, onlyWhenStatus: update.onlyWhenStatus, onlyWhenStatusIn: update.onlyWhenStatusIn }))).toEqual([
      { status: "healthy", onlyWhenStatus: undefined, onlyWhenStatusIn: ["provisioning", "failed"] },
      { status: "failed", onlyWhenStatus: "provisioning", onlyWhenStatusIn: undefined },
    ])
  })
})
