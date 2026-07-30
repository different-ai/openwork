import { DaytonaConflictError } from "@daytonaio/sdk"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import type { DaytonaProvisioningRuntime, DaytonaSandboxRuntime } from "../src/workers/daytona.js"

type DaytonaModule = typeof import("../src/workers/daytona.js")
type ProvisionInput = Parameters<DaytonaModule["provisionWorkerOnDaytonaWithRuntime"]>[0]
type UpsertInput = Parameters<DaytonaProvisioningRuntime["upsertSandbox"]>[0]
type CreateInput = Parameters<DaytonaProvisioningRuntime["createSandbox"]>[0]

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DAYTONA_API_KEY = "daytona-test-key"
  process.env.DAYTONA_WORKER_PROXY_BASE_URL = "https://workers.example.test"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
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
  startErrors?: Error[]
  refreshStates?: string[]
}) {
  let state = input.state
  let startCalls = 0
  let deleteCalls = 0
  let refreshCalls = 0
  const sandbox = {
    id: input.id,
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
      const startError = input.startErrors?.[startCalls - 1] ?? input.startError
      if (startError) {
        throw startError
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
    get refreshCalls() {
      return refreshCalls
    },
  }
}

function makeRuntime(input: {
  sandboxName?: string
  nameResults?: Array<DaytonaSandboxRuntime | null>
  nameResultsByName?: Array<{ name: string; results: Array<DaytonaSandboxRuntime | null> }>
  createdSandbox?: DaytonaSandboxRuntime
  createError?: Error
  checkpointExists?: boolean
  restoreMarkerVerified?: boolean
}) {
  let createCalls = 0
  let healthChecks = 0
  let checkpointChecks = 0
  let restoreMarkerChecks = 0
  const nameLookups: string[] = []
  const createInputs: CreateInput[] = []
  const lookupCounts = new Map<string, number>()
  const upserts: UpsertInput[] = []
  const nameEntries = [...(input.nameResultsByName ?? [])]
  if (input.sandboxName && input.nameResults) {
    nameEntries.push({ name: input.sandboxName, results: input.nameResults })
  }
  const runtime = {
    async getVolume() {
      return { id: "vol_shared", state: "ready" }
    },
    async getSandbox(sandboxIdOrName: string) {
      nameLookups.push(sandboxIdOrName)
      const entry = nameEntries.find((candidate) => candidate.name === sandboxIdOrName)
      if (entry) {
        const lookupCount = lookupCounts.get(sandboxIdOrName) ?? 0
        const result = lookupCount < entry.results.length
          ? entry.results[lookupCount]
          : entry.results[entry.results.length - 1]
        lookupCounts.set(sandboxIdOrName, lookupCount + 1)
        if (result) {
          return result
        }
      }

      throw new Error(`sandbox ${sandboxIdOrName} not found`)
    },
    async createSandbox(params: CreateInput) {
      createCalls += 1
      createInputs.push(params)
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
    async checkpointExists() {
      checkpointChecks += 1
      return input.checkpointExists ?? false
    },
    async verifyRestoreMarker() {
      restoreMarkerChecks += 1
      return input.restoreMarkerVerified ?? false
    },
    async waitForHealth() {
      healthChecks += 1
    },
  } satisfies DaytonaProvisioningRuntime

  return {
    runtime,
    upserts,
    nameLookups,
    createInputs,
    get createCalls() {
      return createCalls
    },
    get healthChecks() {
      return healthChecks
    },
    get checkpointChecks() {
      return checkpointChecks
    },
    get restoreMarkerChecks() {
      return restoreMarkerChecks
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
    expect(result.imageVersion).toBe("openwork-0.18.8")
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
    expect(result.imageVersion).toBe("openwork-0.18.8")
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

describe("Daytona Cloud version-aware recycle", () => {
  test("recycles a stale stopped sandbox with a checkpoint into a version-qualified replacement", async () => {
    const input = provisionInput()
    const old = makeSandbox({ id: "sbx_old", state: "stopped" })
    const replacement = makeSandbox({ id: "sbx_replacement", state: "started" })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_old", results: [old.sandbox] }],
      createdSandbox: replacement.sandbox,
      checkpointExists: true,
      restoreMarkerVerified: true,
    })

    const result = await daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_old", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.7",
    )

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe("openwork-0.18.8")
    expect(runtime.createCalls).toBe(1)
    expect(runtime.createInputs[0]?.name).toBe(daytona.daytonaSandboxNameForSnapshot(input, "openwork-0.18.8"))
    expect(runtime.checkpointChecks).toBe(1)
    expect(runtime.restoreMarkerChecks).toBe(1)
    expect(runtime.upserts).toHaveLength(1)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_replacement")
    expect(old.startCalls).toBe(0)
    expect(old.deleteCalls).toBe(1)
    expect(replacement.deleteCalls).toBe(0)
  })

  test("does not recycle a stale running sandbox", async () => {
    const input = provisionInput()
    const old = makeSandbox({ id: "sbx_running", state: "started" })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_running", results: [old.sandbox] }],
      checkpointExists: true,
      restoreMarkerVerified: true,
    })

    const result = await daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_running", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.7",
    )

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe("openwork-0.18.7")
    expect(runtime.createCalls).toBe(0)
    expect(runtime.checkpointChecks).toBe(0)
    expect(old.deleteCalls).toBe(0)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_running")
  })

  test("does not recycle a stale stopped sandbox before a checkpoint exists", async () => {
    const input = provisionInput()
    const old = makeSandbox({ id: "sbx_no_checkpoint", state: "stopped" })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_no_checkpoint", results: [old.sandbox] }],
      checkpointExists: false,
    })

    const result = await daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_no_checkpoint", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.7",
    )

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe("openwork-0.18.7")
    expect(runtime.createCalls).toBe(0)
    expect(runtime.checkpointChecks).toBe(1)
    expect(old.startCalls).toBe(1)
    expect(old.deleteCalls).toBe(0)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_no_checkpoint")
  })

  test("deletes a failed replacement, keeps the old sandbox, and wakes the old sandbox", async () => {
    const input = provisionInput()
    const old = makeSandbox({ id: "sbx_old_safe", state: "stopped" })
    const replacement = makeSandbox({ id: "sbx_bad_replacement", state: "started" })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_old_safe", results: [old.sandbox] }],
      createdSandbox: replacement.sandbox,
      checkpointExists: true,
      restoreMarkerVerified: false,
    })

    const result = await daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_old_safe", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.7",
    )

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe("openwork-0.18.7")
    expect(runtime.createCalls).toBe(1)
    expect(runtime.restoreMarkerChecks).toBe(1)
    expect(runtime.healthChecks).toBe(2)
    expect(replacement.deleteCalls).toBe(1)
    expect(old.deleteCalls).toBe(0)
    expect(old.startCalls).toBe(1)
    expect(runtime.upserts).toHaveLength(1)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_old_safe")
  })

  test("keeps the same-version stopped sandbox on the normal wake path", async () => {
    const input = provisionInput()
    const old = makeSandbox({ id: "sbx_current", state: "stopped" })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_current", results: [old.sandbox] }],
      checkpointExists: true,
    })

    const result = await daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_current", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.8",
    )

    expect(result.status).toBe("healthy")
    expect(result.imageVersion).toBe("openwork-0.18.8")
    expect(runtime.createCalls).toBe(0)
    expect(runtime.checkpointChecks).toBe(0)
    expect(old.startCalls).toBe(1)
    expect(old.deleteCalls).toBe(0)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_current")
  })
})

describe("Daytona Cloud wake start convergence", () => {
  test("converges when a Daytona state-change conflict is already starting the sandbox", async () => {
    const input = provisionInput()
    const sandbox = makeSandbox({
      id: "sbx_conflict_start",
      state: "stopped",
      startError: new DaytonaConflictError("Sandbox state change in progress"),
      refreshStates: ["stopped", "started"],
    })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_conflict_start", results: [sandbox.sandbox] }],
    })

    const result = await daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_conflict_start", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.8",
    )

    expect(result.status).toBe("healthy")
    expect(sandbox.startCalls).toBe(1)
    expect(sandbox.refreshCalls).toBe(2)
    expect(runtime.healthChecks).toBe(1)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_conflict_start")
  })

  test("retries a transient Daytona 502 during start before waking the sandbox", async () => {
    const input = provisionInput()
    const sandbox = makeSandbox({
      id: "sbx_transient_start",
      state: "stopped",
      startErrors: [new Error("Request failed with status code 502")],
    })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_transient_start", results: [sandbox.sandbox] }],
    })

    const result = await daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_transient_start", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.8",
    )

    expect(result.status).toBe("healthy")
    expect(sandbox.startCalls).toBe(2)
    expect(runtime.healthChecks).toBe(1)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_transient_start")
  })

  test("bounds persistent transient Daytona start failures", async () => {
    const input = provisionInput()
    const sandbox = makeSandbox({
      id: "sbx_persistent_start_failure",
      state: "stopped",
      startError: new Error("Request failed with status code 502"),
    })
    const runtime = makeRuntime({
      nameResultsByName: [{ name: "sbx_persistent_start_failure", results: [sandbox.sandbox] }],
    })

    await expect(daytona.wakeWorkerOnDaytonaWithRuntime(
      input,
      runtime.runtime,
      { sandbox_id: "sbx_persistent_start_failure", workspace_volume_id: "vol_shared", data_volume_id: "vol_shared" },
      "openwork-0.18.8",
    )).rejects.toThrow("Request failed with status code 502")

    expect(sandbox.startCalls).toBe(3)
    expect(runtime.healthChecks).toBe(0)
    expect(runtime.upserts).toHaveLength(0)
  })
})

describe("Daytona Cloud sandbox name lookup", () => {
  test("checks the current version-qualified sandbox name before the legacy base name", async () => {
    const input = provisionInput()
    const currentName = daytona.daytonaSandboxNameForSnapshot(input, "openwork-0.18.8")
    const legacyName = daytona.daytonaSandboxName(input)
    const current = makeSandbox({ id: "sbx_current_name", state: "stopped" })
    const legacy = makeSandbox({ id: "sbx_legacy_name", state: "stopped" })
    const runtime = makeRuntime({
      nameResultsByName: [
        { name: currentName, results: [current.sandbox] },
        { name: legacyName, results: [legacy.sandbox] },
      ],
    })

    await daytona.provisionWorkerOnDaytonaWithRuntime(input, runtime.runtime)

    expect(runtime.nameLookups[0]).toBe(currentName)
    expect(runtime.nameLookups).not.toContain(legacyName)
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_current_name")
    expect(legacy.startCalls).toBe(0)
  })

  test("falls back to the legacy base name when no current version-qualified sandbox exists", async () => {
    const input = provisionInput()
    const currentName = daytona.daytonaSandboxNameForSnapshot(input, "openwork-0.18.8")
    const legacyName = daytona.daytonaSandboxName(input)
    const legacy = makeSandbox({ id: "sbx_legacy_fallback", state: "stopped" })
    const runtime = makeRuntime({
      nameResultsByName: [
        { name: currentName, results: [null] },
        { name: legacyName, results: [legacy.sandbox] },
      ],
    })

    await daytona.provisionWorkerOnDaytonaWithRuntime(input, runtime.runtime)

    expect(runtime.nameLookups.slice(0, 2)).toEqual([currentName, legacyName])
    expect(runtime.upserts[0]?.sandboxId).toBe("sbx_legacy_fallback")
  })
})
