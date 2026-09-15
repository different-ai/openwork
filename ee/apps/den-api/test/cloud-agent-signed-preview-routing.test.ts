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
let connectHealth: ExecutorModule["connectHealth"]
let executeCloudAgent: ExecutorModule["executeCloudAgent"]

beforeAll(async () => {
  seedRequiredEnv()
  const executor = await import("../src/automations/cloud-agent-executor.js")
  resolveCloudAgentWorkspace = executor.resolveCloudAgentWorkspace
  cloudAgentRuntimeUnavailableResult = executor.cloudAgentRuntimeUnavailableResult
  resolveCloudAgentReadyWorker = executor.resolveCloudAgentReadyWorker
  connectHealth = executor.connectHealth
  executeCloudAgent = executor.executeCloudAgent
})

for (const failure of [
  { name: "ProviderModelNotFoundError", message: "Model not found: lpr_fixture/model", status: 400, code: "model_access_lost", needsAttention: true },
  { name: "APIError", message: "Provider temporarily unavailable", status: 503, code: "execution_failed", needsAttention: false },
]) {
  test(`Cloud persists its native receipt before an initial prompt fails with ${failure.name}`, async () => {
    const workerId = createDenTypeId("worker")
    const access: CloudWorkerAccess = {
      workerId, url: "https://worker.example.test", expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      clientToken: "client-token", hostToken: "host-token",
    }
    const order: string[] = []
    const receipts: Record<string, unknown>[] = []
    const model = { providerId: "lpr_fixture", modelId: "model", variant: "high" }
    const result = await executeCloudAgent({
      organizationId: createDenTypeId("organization"), ownerMemberId: createDenTypeId("member"),
      automationRunId: "run-fixture", automationName: "Admission", workspaceId: "workspace-pinned",
      action: { kind: "agent", instructions: "Prepare the result", model },
      maximumRuntimeMs: 10_000, previousReceipt: null, signal: new AbortController().signal,
      onAdmitted: async (receipt) => {
        expect(order).toEqual(["create"])
        receipts.push(receipt)
        order.push("persist")
      },
    }, {
      authority: async () => null,
      runtime: async () => ({ ok: true, workerId, access, baseUrl: access.url, workspaceId: "workspace-active" }),
      connect: async (input) => {
        expect(input.workspaceId).toBe("workspace-pinned")
        return { ok: true }
      },
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname
        expect(path.startsWith("/workspace/workspace-pinned/opencode/")).toBe(true)
        if (path.endsWith("/config/providers")) return Response.json({ providers: [{ id: model.providerId, models: { model: {} } }] })
        if (path.endsWith("/session") && init?.method === "POST") {
          expect(typeof init.body === "string" ? JSON.parse(init.body) : null).toEqual({ title: "Automation: Admission" })
          order.push("create")
          return Response.json({ id: "session-fixture" })
        }
        if (path.endsWith("/prompt_async")) {
          expect(order).toEqual(["create", "persist"])
          order.push("prompt")
          return Response.json({ name: failure.name, data: { message: failure.message } }, { status: failure.status })
        }
        if (path.endsWith("/abort")) {
          order.push("abort")
          return Response.json(true)
        }
        if (path.endsWith("/message") || path.endsWith("/todo")) return Response.json([])
        if (path.endsWith("/status")) return Response.json({})
        if (path.endsWith("/session/session-fixture")) return Response.json({ id: "session-fixture" })
        throw new Error(`Unexpected request ${path}`)
      },
    })
    expect(result).toMatchObject({ ok: false, code: failure.code, needsAttention: failure.needsAttention, retryable: false })
    expect(order).toEqual(["create", "persist", "prompt", "abort"])
    expect(receipts).toEqual([{
      workerId, workspaceId: "workspace-pinned", nativeThreadId: "session-fixture", messageId: expect.stringMatching(/^msg_/),
    }])
  })
}

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

type HealthPayload = Record<string, unknown>

function connectScenario(healthReplies: HealthPayload[]) {
  const requests: Array<{ method: string; path: string }> = []
  const materialized: string[] = []
  let sleptMs = 0
  let now = 0
  const access: CloudWorkerAccess = {
    workerId: createDenTypeId("worker"),
    url: "https://automation.preview.example.test",
    expiresAt: new Date("2026-09-05T12:00:00.000Z"),
    clientToken: "client-token",
    hostToken: "host-token",
  }
  let lastHealth: HealthPayload = {}
  const fetchImpl = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET"
    const path = new URL(url).pathname
    requests.push({ method, path })
    // An engine refresh that changes nothing reports the same health again.
    if (path.endsWith("/engine-refresh")) return Response.json({ health: lastHealth })
    lastHealth = (healthReplies.length > 1 ? healthReplies.shift() : healthReplies[0]) ?? {}
    return Response.json(lastHealth)
  }
  const run = (signal = new AbortController().signal) => connectHealth({
    organizationId: createDenTypeId("organization"),
    workerId: access.workerId,
    baseUrl: access.url,
    workspaceId: "workspace-automation",
    access,
    action: { kind: "agent", instructions: "Summarize today", model: { providerId: "openwork", modelId: "fast" } },
    signal,
  }, {
    fetchImpl,
    materializeProviders: async (input) => {
      materialized.push(`${requests.length}:${input.instanceUrl}`)
      return { ok: true, status: "cached", fingerprint: "fp", providers: 1 }
    },
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason
      sleptMs += ms
      now += ms
    },
  })
  return { run, requests, materialized, slept: () => sleptMs }
}

const warmingUp: HealthPayload = {
  usable: false,
  usableByCurrentModel: false,
  firstFailure: { code: "opencode_unconfigured", message: "OpenCode base URL is missing for this workspace." },
}
const usable: HealthPayload = { usable: true, usableByCurrentModel: true }

test("a Cloud Automation waits for the managed engine to finish starting instead of failing its first run", async () => {
  const scenario = connectScenario([warmingUp, warmingUp, usable])

  const result = await scenario.run()

  expect(result).toEqual({ ok: true })
  expect(scenario.requests.filter((request) => request.path.endsWith("/health"))).toHaveLength(3)
  expect(scenario.requests.some((request) => request.path.endsWith("/engine-refresh"))).toBe(false)
  expect(scenario.slept()).toBe(4_000)
  // Providers are delivered only once the engine answers, after the third probe.
  expect(scenario.materialized).toEqual(["3:https://automation.preview.example.test"])
})

test("a Cloud Automation delivers the organization's current providers before every run", async () => {
  const scenario = connectScenario([usable])

  const result = await scenario.run()

  expect(result).toEqual({ ok: true })
  expect(scenario.materialized).toHaveLength(1)
  expect(scenario.slept()).toBe(0)
})

test("a Connect failure that is not engine warm-up still fails the run immediately", async () => {
  const scenario = connectScenario([{
    usable: false,
    usableByCurrentModel: false,
    firstFailure: { code: "connect_unauthorized", message: "OpenWork Connect rejected the worker token." },
  }])

  const result = await scenario.run()

  expect(result).toEqual({
    ok: false,
    code: "connect_access_unavailable",
    message: "OpenWork Connect rejected the worker token.",
  })
  expect(scenario.slept()).toBe(0)
  expect(scenario.requests.map((request) => request.path.split("/").at(-1)?.split("?")[0])).toEqual(["health", "engine-refresh"])
})

test("a confirmed missing model is a model repair, not a Connect reconnection", async () => {
  const scenario = connectScenario([{
    usable: false,
    usableByCurrentModel: false,
    firstFailure: { code: "provider_tool_projection_missing", stage: "provider_projection", retryable: false },
  }])
  expect(await scenario.run()).toMatchObject({ ok: false, code: "model_access_lost" })
})

test("a failed or unknown model projection is not evidence of revoked access", async () => {
  for (const health of [
    { usable: false, usableByCurrentModel: false, firstFailure: { code: "opencode_request_failed", stage: "provider_projection", retryable: true } },
    { usable: true, usableByCurrentModel: null },
    { usable: true },
  ]) {
    expect(await connectScenario([health]).run()).toMatchObject({ ok: false, code: "execution_failed" })
  }
})

test("an engine that never starts fails the run with its own message after the bounded wait", async () => {
  const scenario = connectScenario([warmingUp])

  const result = await scenario.run()

  expect(result).toEqual({
    ok: false,
    code: "connect_access_unavailable",
    message: "OpenCode base URL is missing for this workspace.",
  })
  expect(scenario.slept()).toBe(60_000)
  expect(scenario.materialized).toEqual([])
})

test("cancelling a run during engine warm-up stops waiting", async () => {
  const controller = new AbortController()
  const scenario = connectScenario([warmingUp])
  const pending = scenario.run(controller.signal)
  controller.abort(new Error("cancelled"))

  await expect(pending).rejects.toThrow("cancelled")
})
