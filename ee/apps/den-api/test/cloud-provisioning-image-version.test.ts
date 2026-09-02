import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"

type WorkerSharedModule = typeof import("../src/routes/workers/shared.js")
type ContinueOptions = NonNullable<Parameters<WorkerSharedModule["continueCloudProvisioning"]>[1]>
type Store = NonNullable<ContinueOptions["store"]>
type StatusUpdate = Parameters<Store["updateWorkerStatus"]>[0]
type InstanceInsert = Parameters<Store["insertWorkerInstance"]>[0]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let shared: WorkerSharedModule

beforeAll(async () => {
  seedRequiredEnv()
  shared = await import("../src/routes/workers/shared.js")
})

describe("cloud provisioning image version", () => {
  test("writes the provisioned image version on successful cloud provisioning", async () => {
    const updates: StatusUpdate[] = []
    const inserts: InstanceInsert[] = []
    const store: Store = {
      async updateWorkerStatus(input) {
        updates.push(input)
      },
      async insertWorkerInstance(input) {
        inserts.push(input)
      },
      async touchProvisioningWorker() {},
    }
    const workerId = createDenTypeId("worker")
    const materializedUrls: string[] = []

    await shared.continueCloudProvisioning({
      workerId,
      orgId: createDenTypeId("organization"),
      name: "Cloud",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    }, {
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
      store,
      provisionWorker: async () => ({
        provider: "daytona",
        url: "https://initial.preview.example.test",
        status: "healthy",
        imageVersion: "openwork-0.18.8",
      }),
      materializeProviders: async (input) => {
        materializedUrls.push(input.instanceUrl)
        return { ok: true, status: "noop", fingerprint: "owp:v1:test", providers: 0 }
      },
    })

    expect(updates).toHaveLength(1)
    expect(updates[0]?.workerId).toBe(workerId)
    expect(updates[0]?.status).toBe("healthy")
    expect(updates[0]?.imageVersion).toBe("openwork-0.18.8")
    expect(inserts).toHaveLength(1)
    expect(materializedUrls).toEqual(["https://initial.preview.example.test"])
  })

  test("does not provision a cloud worker after Web access is revoked", async () => {
    const updates: StatusUpdate[] = []
    let provisions = 0
    const workerId = createDenTypeId("worker")
    const store: Store = {
      async updateWorkerStatus(input) {
        updates.push(input)
      },
      async insertWorkerInstance() {
        throw new Error("an unlicensed worker must not create an instance")
      },
      async touchProvisioningWorker() {
        throw new Error("an unlicensed worker must not start provisioning")
      },
    }

    await shared.continueCloudProvisioning({
      workerId,
      orgId: createDenTypeId("organization"),
      name: "Cloud",
      hostToken: "host-token",
      clientToken: "client-token",
      activityToken: "activity-token",
    }, {
      getOpenWorkWebAccess: async () => ({ hasAccess: false }),
      store,
      provisionWorker: async () => {
        provisions += 1
        return { provider: "daytona", url: "https://should-not-run.example.test", status: "healthy" }
      },
    })

    expect(provisions).toBe(0)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.workerId).toBe(workerId)
    expect(updates[0]?.status).toBe("failed")
    expect(updates[0]?.onlyWhenStatus).toBe("provisioning")
    expect(updates[0]?.failure?.code).toBe("web_access_required")
    expect(updates[0]?.failure?.stage).toBe("provisioning")
  })
})
