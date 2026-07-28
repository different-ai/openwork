import { DaytonaConflictError } from "@daytonaio/sdk"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import type { DaytonaProvisioningRuntime, DaytonaSandboxRuntime } from "../src/workers/daytona.js"

type DaytonaModule = typeof import("../src/workers/daytona.js")
type ProvisionInput = Parameters<DaytonaModule["provisionWorkerOnDaytonaWithRuntime"]>[0]
type UpsertInput = Parameters<DaytonaProvisioningRuntime["upsertSandbox"]>[0]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DAYTONA_API_KEY = "daytona-test-key"
  process.env.DAYTONA_WORKER_PROXY_BASE_URL = "https://workers.example.test"
}

let daytona: DaytonaModule

beforeAll(async () => {
  seedRequiredEnv()
  daytona = await import("../src/workers/daytona.js")
})

function provisionInput(): ProvisionInput {
  return {
    workerId: createDenTypeId("worker"),
    name: "Cloud",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  }
}

function makeSandbox(input: {
  id: string
  state: string
  startError?: Error
}) {
  let state = input.state
  let startCalls = 0
  let deleteCalls = 0
  const sandbox = {
    id: input.id,
    get state() {
      return state
    },
    get target() {
      return "us-test"
    },
    async refreshData() {},
    async start() {
      startCalls += 1
      if (input.startError) {
        throw input.startError
      }
      state = "started"
    },
    async delete() {
      deleteCalls += 1
    },
    async getSignedPreviewUrl() {
      return { url: `https://${input.id}.preview.example.test` }
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

  return {
    sandbox,
    get startCalls() {
      return startCalls
    },
    get deleteCalls() {
      return deleteCalls
    },
  }
}

function makeRuntime(input: {
  sandboxName: string
  nameResults: Array<DaytonaSandboxRuntime | null>
  createdSandbox?: DaytonaSandboxRuntime
  createError?: Error
}) {
  let createCalls = 0
  let nameLookups = 0
  let healthChecks = 0
  const upserts: UpsertInput[] = []
  const runtime = {
    async getVolume() {
      return { id: "vol_shared", state: "ready" }
    },
    async getSandbox(sandboxIdOrName: string) {
      if (sandboxIdOrName === input.sandboxName) {
        const result = nameLookups < input.nameResults.length
          ? input.nameResults[nameLookups]
          : input.nameResults[input.nameResults.length - 1]
        nameLookups += 1
        if (result) {
          return result
        }
      }

      throw new Error(`sandbox ${sandboxIdOrName} not found`)
    },
    async createSandbox() {
      createCalls += 1
      if (input.createError) {
        throw input.createError
      }
      if (!input.createdSandbox) {
        throw new Error("created sandbox missing")
      }
      return input.createdSandbox
    },
    async upsertSandbox(row: UpsertInput) {
      upserts.push(row)
    },
    async waitForHealth() {
      healthChecks += 1
    },
  } satisfies DaytonaProvisioningRuntime

  return {
    runtime,
    upserts,
    get createCalls() {
      return createCalls
    },
    get healthChecks() {
      return healthChecks
    },
  }
}

describe("Daytona Cloud provisioning adoption", () => {
  test("adopts the existing sandbox when create races and Daytona returns a conflict", async () => {
    const input = provisionInput()
    const sandboxName = daytona.daytonaSandboxName(input)
    const existing = makeSandbox({ id: "sbx_existing", state: "stopped" })
    const runtime = makeRuntime({
      sandboxName,
      nameResults: [null, existing.sandbox],
      createError: new DaytonaConflictError("Sandbox with name already exists"),
    })

    const result = await daytona.provisionWorkerOnDaytonaWithRuntime(input, runtime.runtime)

    expect(result.status).toBe("healthy")
    expect(result.url).toBe(`https://workers.example.test/${encodeURIComponent(input.workerId)}`)
    expect(runtime.createCalls).toBe(1)
    expect(existing.startCalls).toBe(1)
    expect(existing.deleteCalls).toBe(0)
    expect(runtime.healthChecks).toBe(1)
    expect(runtime.upserts).toHaveLength(1)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_existing")
  })

  test("creates a new sandbox when the deterministic name is unused", async () => {
    const input = provisionInput()
    const sandboxName = daytona.daytonaSandboxName(input)
    const created = makeSandbox({ id: "sbx_created", state: "started" })
    const runtime = makeRuntime({
      sandboxName,
      nameResults: [null],
      createdSandbox: created.sandbox,
    })

    const result = await daytona.provisionWorkerOnDaytonaWithRuntime(input, runtime.runtime)

    expect(result.status).toBe("healthy")
    expect(runtime.createCalls).toBe(1)
    expect(created.startCalls).toBe(0)
    expect(created.deleteCalls).toBe(0)
    expect(runtime.upserts).toHaveLength(1)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_created")
  })

  test("does not delete an adopted sandbox when starting it fails", async () => {
    const input = provisionInput()
    const sandboxName = daytona.daytonaSandboxName(input)
    const existing = makeSandbox({ id: "sbx_stopped", state: "stopped", startError: new Error("start failed") })
    const runtime = makeRuntime({
      sandboxName,
      nameResults: [existing.sandbox],
    })

    await expect(daytona.provisionWorkerOnDaytonaWithRuntime(input, runtime.runtime)).rejects.toThrow("start failed")

    expect(runtime.createCalls).toBe(0)
    expect(existing.startCalls).toBe(1)
    expect(existing.deleteCalls).toBe(0)
    expect(runtime.upserts).toHaveLength(0)
  })
})
