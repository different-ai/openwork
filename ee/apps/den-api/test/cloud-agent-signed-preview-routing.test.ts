import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, expect, test } from "bun:test"
import type { CloudWorkerAccess } from "../src/workers/worker-access.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"
  process.env.PROVISIONER_MODE = "stub"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
}

type ExecutorModule = typeof import("../src/automations/cloud-agent-executor.js")
let resolveCloudAgentWorkspace: ExecutorModule["resolveCloudAgentWorkspace"]
let cloudAgentRuntimeUnavailableResult: ExecutorModule["cloudAgentRuntimeUnavailableResult"]
let resolveCloudAgentReadyWorker: ExecutorModule["resolveCloudAgentReadyWorker"]

beforeAll(async () => {
  seedRequiredEnv()
  const executor = await import("../src/automations/cloud-agent-executor.js")
  resolveCloudAgentWorkspace = executor.resolveCloudAgentWorkspace
  cloudAgentRuntimeUnavailableResult = executor.cloudAgentRuntimeUnavailableResult
  resolveCloudAgentReadyWorker = executor.resolveCloudAgentReadyWorker
})

test("an in-progress Cloud Automation wake preserves the single-attempt terminal baseline", () => {
  const result = cloudAgentRuntimeUnavailableResult({
    reason: "waking",
    message: "OpenWork Cloud is still starting for this Automation run.",
    cancelled: false,
    timedOut: false,
  })

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    code: "execution_runtime_unavailable",
    retryable: false,
    needsAttention: true,
  })
})

test("an unreachable Cloud Automation runtime does not introduce a durable retry", () => {
  const result = cloudAgentRuntimeUnavailableResult({
    reason: "unreachable",
    message: "The Cloud runtime is unreachable.",
    cancelled: false,
    timedOut: false,
  })

  expect(result).toMatchObject({ code: "execution_runtime_unavailable", retryable: false, needsAttention: true })
})

test("a slow stopped-worker wake receives a fresh full readiness budget afterward", async () => {
  const workerId = createDenTypeId("worker")
  let now = 0
  let wakeCalls = 0
  let sleepCalls = 0
  const ready = await resolveCloudAgentReadyWorker({
    organizationId: createDenTypeId("organization"),
    ownerMemberId: createDenTypeId("member"),
  }, new AbortController().signal, {
    ownerUserId: async () => createDenTypeId("user"),
    resolveAccess: async () => {
      if (wakeCalls === 0) return { status: "waking", workerId, reason: "stopped" }
      if (now < 319_000) return { status: "waking", workerId, reason: "reprovisioning" }
      return {
        status: "ready",
        workerId,
        url: "https://post-wake.preview.example.test",
        expiresAt: new Date("2026-08-27T12:00:00.000Z"),
        clientToken: "client-token",
        hostToken: "host-token",
      }
    },
    wakeWorker: async () => {
      wakeCalls += 1
      now += 200_000
    },
    resolveWorkspace: async (access) => ({ baseUrl: access.url, workspaceId: "workspace-after-wake" }),
    now: () => now,
    sleep: async (ms) => {
      sleepCalls += 1
      now += ms
    },
  })

  expect(ready.ok).toBe(true)
  if (!ready.ok) throw new Error("runtime did not become ready after wake")
  expect(ready.workspaceId).toBe("workspace-after-wake")
  expect(wakeCalls).toBe(1)
  expect(sleepCalls).toBe(119)
  expect(now).toBe(319_000)
})

test("Cloud Automations discover their workspace through the signed preview", async () => {
  const access: CloudWorkerAccess = {
    workerId: createDenTypeId("worker"),
    url: "https://automation.preview.example.test",
    expiresAt: new Date("2026-08-27T12:00:00.000Z"),
    clientToken: "client-token",
    hostToken: "host-token",
  }
  const requested: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input))
    expect(init?.redirect).toBe("error")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer client-token")
    expect(new Headers(init?.headers).get("x-openwork-host-token")).toBe("host-token")
    return Response.json({ activeId: "workspace-automation" })
  }

  const workspace = await resolveCloudAgentWorkspace(access, new AbortController().signal, fetchImpl)

  expect(workspace).toEqual({
    baseUrl: "https://automation.preview.example.test",
    workspaceId: "workspace-automation",
  })
  expect(requested).toEqual(["https://automation.preview.example.test/workspaces"])
})
