import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import type { InferenceHandledErrorReport, InferenceReporter, InferenceRequestReport } from "../src/inference-reporting.js"
import type { GatewayRequestLogRow as InferenceRequestLogRow } from "../src/request-log.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/gateway_unit_fixture"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
process.env.OPENROUTER_UPSTREAM_URL = "https://upstream.test/api/v1"

const { registerProxyRoutes } = await import("../src/proxy.js")

type UpstreamRequest = {
  url: string
  method: string | undefined
  body: string | null
  headers: Headers
  redirect: RequestRedirect | undefined
}

type DependencyCalls = {
  findActiveInferenceKey: number
  policyOrganizationIds: string[]
  getOpenRouterProviderKey: number
  ensureUsableBuckets: number
}

type CapturedReports = {
  requests: InferenceRequestReport[]
  handledErrors: InferenceHandledErrorReport[]
  completions: Parameters<NonNullable<InferenceReporter["completion"]>>[0][]
}

type TestServerOptions = {
  assertOrganizationManagedModelsAllowed?: (organizationId: string) => Promise<void>
  organizationMetadata?: unknown
  invalidKey?: boolean
  analytics?: typeof import("../src/task-analytics.js").beginModelAnalytics
  organizationId?: string
  providerKey?: { encrypted_api_key: string } | null
  fetch?: typeof fetch
  usageLimited?: boolean
}

function sseResponse(events: string[], init: ResponseInit = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init })
}

async function waitForRows(rows: InferenceRequestLogRow[], count = 1) {
  for (let attempt = 0; attempt < 50 && (rows.length < count || rows.some((row) => !row.completed_at)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(rows.length, count)
  const row = rows[0]
  assert.ok(row)
  return row
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readInitBody(body: BodyInit | null | undefined) {
  if (typeof body === "string") return body
  if (!body) return null
  throw new Error("Expected forwarded body to be a string")
}

function requireBodyText(body: string | null) {
  if (body === null) {
    throw new Error("Expected forwarded body to be present")
  }
  return body
}

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (input instanceof Request) return input.url
  return input.toString()
}

function parseJsonObject(text: string) {
  const value: unknown = JSON.parse(text)
  assert.ok(isRecord(value))
  return value
}

function requireRequestReport(reports: CapturedReports, index = 0) {
  const report = reports.requests[index]
  assert.ok(report)
  return report
}

function requireHandledErrorReport(reports: CapturedReports, index = 0) {
  const report = reports.handledErrors[index]
  assert.ok(report)
  return report
}

function requireReportPayload(report: InferenceRequestReport) {
  assert.ok(isRecord(report.payload))
  return report.payload
}

async function readErrorCode(response: Response) {
  const payload: unknown = await response.json()
  assert.ok(isRecord(payload))
  const error = payload.error
  assert.ok(isRecord(error))
  const code = error.code
  if (typeof code !== "string") {
    throw new Error("Expected OpenAI error code to be a string")
  }
  return code
}

function authHeaders(contentType?: string) {
  const headers = new Headers({ authorization: "Bearer test-key" })
  if (contentType) {
    headers.set("content-type", contentType)
  }
  return headers
}

function inferenceRequest(input: { method: string; headers: Headers; body?: string; path?: string }) {
  return new Request(`http://openwork.test${input.path ?? "/api/v1/chat/completions"}`, {
    method: input.method,
    headers: input.headers,
    body: input.body,
  })
}

function createTestServer(options: TestServerOptions = {}) {
  const app = new Hono()
  const upstreamRequests: UpstreamRequest[] = []
  const reports: CapturedReports = { requests: [], handledErrors: [], completions: [] }
  const logRows: InferenceRequestLogRow[] = []
  const calls: DependencyCalls = {
    findActiveInferenceKey: 0,
    policyOrganizationIds: [],
    getOpenRouterProviderKey: 0,
    ensureUsableBuckets: 0,
  }
  const upstreamFetch: typeof fetch = options.fetch ?? (async (input, init) => {
    upstreamRequests.push({
      url: requestUrl(input),
      method: init?.method,
      body: readInitBody(init?.body),
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    })
    const request = parseJsonObject(requireBodyText(readInitBody(init?.body)))
    if (request.stream) return new Response('data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }] })
  })
  const reporter: InferenceReporter = {
    request(report) {
      reports.requests.push(report)
    },
    handledError(report) {
      reports.handledErrors.push(report)
    },
    completion(report) {
      reports.completions.push(report)
    },
  }

  registerProxyRoutes(app, {
    async findActiveInferenceKey(_key) {
      calls.findActiveInferenceKey += 1
      if (options.invalidKey) return null
      return {
        id: "inference_key_123",
        organization_id: options.organizationId ?? "organization_123",
        org_membership_id: "member_123",
      }
    },
    async assertOrganizationManagedModelsAllowed(organizationId) {
      calls.policyOrganizationIds.push(organizationId)
      if (options.assertOrganizationManagedModelsAllowed) {
        await options.assertOrganizationManagedModelsAllowed(organizationId)
      } else {
        assertManagedModelsAllowed(options.organizationMetadata)
      }
    },
    async getOpenRouterProviderKey(_organizationId: string) {
      calls.getOpenRouterProviderKey += 1
      if (options.providerKey === null) return null
      return options.providerKey ?? {
        encrypted_api_key: "provider-key",
      }
    },
    async ensureUsableBuckets(_organizationId: string) {
      calls.ensureUsableBuckets += 1
      if (options.usageLimited) {
        return {
          ok: false,
          bucketIds: {},
          bucketLimits: {},
          limitedBy: "bucket_123",
          windowType: "monthly",
          limitedBucket: {
            limitAmount: 100,
            usedAmount: 100,
            windowEndAt: new Date(Date.now() + 90_000),
          },
        }
      }
      return {
        ok: true,
        admittedAt: new Date("2026-09-08T12:00:00.123Z"),
        bucketIds: {},
        bucketLimits: {},
      }
    },
    fetch: upstreamFetch,
    analytics: options.analytics,
    async loadOrganization(organizationId) {
      return { id: organizationId, metadata: { inference: { enabled: true, tier: "tier1" } } }
    },
    async insertRequestLog(row) {
      logRows.push(row)
    },
    async updateRequestLog(row) {
      const index = logRows.findIndex((entry) => entry.id === row.id)
      if (index < 0) return false
      logRows[index] = row
      return true
    },
    reporter,
  })

  return { app, upstreamRequests, calls, reports, logRows }
}

for (const organizationMetadata of [undefined, null, {}, { dpaSigned: false }, '{"dpaSigned":false}', { nested: { dpaSigned: true } }]) {
  test(`allows managed models for metadata ${JSON.stringify(organizationMetadata)}`, async () => {
    const { app, upstreamRequests, calls } = createTestServer({ organizationMetadata })
    const response = await app.fetch(inferenceRequest({
      method: "POST", headers: authHeaders("application/json"),
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [], metadata: { dpaSigned: true } }),
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(calls.policyOrganizationIds, ["organization_123", "organization_123"])
    assert.equal(upstreamRequests.length, 1)
    assert.equal(upstreamRequests[0].redirect, "error")
  })
}

for (const policy of [
  { metadata: { dpaSigned: true }, code: "managed_models_disabled_for_dpa", status: 403 },
  { metadata: '{"dpaSigned":true}', code: "managed_models_disabled_for_dpa", status: 403 },
  { metadata: "{broken", code: "managed_models_policy_unavailable", status: 503 },
  { metadata: [], code: "managed_models_policy_unavailable", status: 503 },
]) {
  test(`blocks catalog and chat before body reporting for ${JSON.stringify(policy.metadata)}`, async () => {
    let analyticsCalls = 0
    const { app, upstreamRequests, calls, reports } = createTestServer({
      organizationMetadata: policy.metadata,
      analytics: async () => { analyticsCalls += 1; return null },
    })
    for (const input of [
      { method: "GET", path: "/api/v1/models" },
      { method: "POST", path: "/api/v1/chat/completions", body: "{invalid body" },
      { method: "POST", path: "/api/v1/chat/completions?model=ignored", body: "{}" },
    ]) {
      const request = inferenceRequest({ ...input, headers: authHeaders("application/json") })
      const response = await app.fetch(request)
      assert.equal(response.status, policy.status)
      assert.equal(await readErrorCode(response), policy.code)
      assert.equal(request.bodyUsed, false)
    }
    assert.deepEqual(calls.policyOrganizationIds, ["organization_123", "organization_123", "organization_123"])
    assert.equal(calls.ensureUsableBuckets, 0)
    assert.equal(calls.getOpenRouterProviderKey, 0)
    assert.equal(analyticsCalls, 0)
    assert.equal(upstreamRequests.length, 0)
    assert.deepEqual(reports, { requests: [], handledErrors: [], completions: [] })
  })
}

test("policy lookup failures fail closed without leaking the underlying error", async () => {
  for (const error of [new ManagedModelsPolicyError("managed_models_policy_unavailable"), new Error("private database failure")]) {
    const { app, calls, reports, upstreamRequests } = createTestServer({
      assertOrganizationManagedModelsAllowed: async () => { throw error },
    })
    const response = await app.fetch(inferenceRequest({ method: "GET", path: "/api/v1/models", headers: authHeaders() }))
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: {
      message: new ManagedModelsPolicyError("managed_models_policy_unavailable").message,
      type: "invalid_request_error",
      code: "managed_models_policy_unavailable",
    } })
    assert.equal(calls.ensureUsableBuckets, 0)
    assert.equal(calls.getOpenRouterProviderKey, 0)
    assert.equal(upstreamRequests.length, 0)
    assert.deepEqual(reports, { requests: [], handledErrors: [], completions: [] })
  }
})

test("policy uses only the authenticated key organization, not caller organization hints", async () => {
  const { app, calls } = createTestServer({ organizationId: "organization_key_owner" })
  const headers = authHeaders("application/json")
  headers.set("x-organization-id", "organization_caller")
  const response = await app.fetch(inferenceRequest({ method: "POST", headers,
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [], organizationId: "organization_caller", dpaSigned: false }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(calls.policyOrganizationIds, ["organization_key_owner", "organization_key_owner"])
})

for (const unavailable of [false, true]) {
  test(`rechecks fresh policy after quota, key and analytics awaits (${unavailable ? "unavailable" : "disabled"})`, async () => {
    let metadata: unknown = { dpaSigned: false }
    let analyticsCalls = 0
    const { app, calls, upstreamRequests } = createTestServer({
      assertOrganizationManagedModelsAllowed: async () => { assertManagedModelsAllowed(metadata) },
      analytics: async () => {
        assert.equal(calls.ensureUsableBuckets, 1)
        assert.equal(calls.getOpenRouterProviderKey, 1)
        assert.equal(calls.policyOrganizationIds.length, 1)
        await Promise.resolve()
        analyticsCalls += 1
        metadata = unavailable ? "{corrupt" : { dpaSigned: true }
        return null
      },
    })
    const request = () => inferenceRequest({ method: "POST", headers: authHeaders("application/json"),
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
    })
    const response = await app.fetch(request())
    assert.equal(response.status, unavailable ? 503 : 403)
    assert.equal(await readErrorCode(response), unavailable ? "managed_models_policy_unavailable" : "managed_models_disabled_for_dpa")
    assert.deepEqual(calls.policyOrganizationIds, ["organization_123", "organization_123"])
    assert.equal(upstreamRequests.length, 0)
    const retry = await app.fetch(request())
    assert.equal(retry.status, unavailable ? 503 : 403)
    assert.equal(calls.policyOrganizationIds.length, 3)
    assert.equal(calls.ensureUsableBuckets, 1)
    assert.equal(calls.getOpenRouterProviderKey, 1)
    assert.equal(analyticsCalls, 1)
    assert.equal(upstreamRequests.length, 0)
  })
}

test("new requests observe both enabling and disabling policy without a cached decision", async () => {
  let metadata = { dpaSigned: false }
  const { app, calls, upstreamRequests } = createTestServer({
    assertOrganizationManagedModelsAllowed: async () => { assertManagedModelsAllowed(metadata) },
  })
  for (const dpaSigned of [false, true, false]) {
    metadata = { dpaSigned }
    const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"),
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
    }))
    assert.equal(response.status, dpaSigned ? 403 : 200)
  }
  assert.equal(calls.policyOrganizationIds.length, 5)
  assert.equal(upstreamRequests.length, 2)
})

test("redirect rejection is not retried and a client retry rechecks policy", async () => {
  let fetchCalls = 0
  let metadata = { dpaSigned: false }
  const { app, calls } = createTestServer({
    assertOrganizationManagedModelsAllowed: async () => { assertManagedModelsAllowed(metadata) },
    fetch: async (_input, init) => {
      fetchCalls += 1
      assert.equal(init?.redirect, "error")
      metadata = { dpaSigned: true }
      throw new TypeError("redirect encountered")
    },
  })
  const request = () => inferenceRequest({ method: "POST", headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
  })
  const response = await app.fetch(request())
  assert.equal(response.status, 502)
  assert.equal(await readErrorCode(response), "upstream_unreachable")
  assert.equal(fetchCalls, 1)
  const retry = await app.fetch(request())
  assert.equal(retry.status, 403)
  assert.equal(await readErrorCode(retry), "managed_models_disabled_for_dpa")
  assert.equal(fetchCalls, 1)
  assert.equal(calls.policyOrganizationIds.length, 3)
})

test("invalid authentication never reads organization policy", async () => {
  const { app, calls, upstreamRequests, reports } = createTestServer({ invalidKey: true })
  const response = await app.fetch(inferenceRequest({ method: "GET", path: "/api/v1/models", headers: authHeaders() }))
  assert.equal(response.status, 401)
  assert.equal(await readErrorCode(response), "invalid_api_key")
  assert.deepEqual(calls.policyOrganizationIds, [])
  assert.equal(upstreamRequests.length, 0)
   assert.deepEqual(reports, { requests: [], handledErrors: [], completions: [] })
})

test("first-output telemetry survives a later malformed frame in the same chunk", async () => {
  const { app, reports } = createTestServer({
    fetch: async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\ndata: {broken\n\n', { headers: { "content-type": "text/event-stream" } }),
  })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }], stream: true }) }))
  const body = await response.text()
  assert.match(body, /Partial/)
  assert.match(body, /upstream_malformed_stream/)
  assert.doesNotMatch(body, /\[DONE\]/)
  assert.equal(reports.completions.length, 1)
  assert.equal(reports.completions[0]?.outcome, "incomplete")
  assert.equal(typeof reports.completions[0]?.firstOutputMs, "number")
})

test("analytics storage failures preserve exact streamed bytes and upstream status", async () => {
  const { observeModelResponse } = await import("../src/task-analytics.js")
  const body = 'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const { app } = createTestServer({
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    analytics: async ({ requestId, startedAt }) => (streaming) => observeModelResponse({
      id: requestId, startedAt, streaming, sessionId: "session", taskId: "task", model: "model",
    }, async () => { throw new Error("store unavailable") }),
  })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", stream: true, messages: [{ role: "user", content: "Hello" }] }) }))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
})

for (const [failure, analytics] of [
  ["rejected check", async () => { throw new Error("analytics offline") }],
  ["synchronous check", () => { throw new Error("analytics offline") }],
  ["observer factory", async () => () => { throw new Error("observer unavailable") }],
  ["stalled check", () => new Promise<null>(() => {})],
] satisfies [string, NonNullable<TestServerOptions["analytics"]>][]) {
  test(`an analytics ${failure} leaves existing inference operational`, { timeout: 2000 }, async () => {
    const { app } = createTestServer({ analytics })
    const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }) }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }] })
  })
}

test("an analytics observer failure cannot truncate an upstream response", async () => {
  const body = 'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  let chunks = 0
  let finishes = 0
  const { app } = createTestServer({
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    analytics: async () => () => ({ chunk() { chunks += 1; throw new Error("parser unavailable") }, finish() { finishes += 1; throw new Error("observer unavailable") } }),
  })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", stream: true, messages: [{ role: "user", content: "Hello" }] }) }))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
  assert.ok(chunks > 0)
  assert.equal(finishes, 1)
})

for (const streaming of [false, true]) {
  for (const completed of [false, true]) {
    test(`${streaming ? "streamed" : "JSON"} analytics requires managed protocol completion (${completed})`, async () => {
      const { observeModelResponse } = await import("../src/task-analytics.js")
      const events: import("@openwork-ee/telemetry").ModelsAnalyticsEvent[] = []
      const payload = {
        model: "z-ai/glm-5.2", provider: "test-provider",
        choices: [{ index: 0, ...(streaming ? { delta: { content: "private output" } } : { message: { role: "assistant", content: "private output" } }), finish_reason: completed ? "stop" : null }],
        usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.01, prompt_tokens_details: { cached_tokens: 2 } },
      }
      const { app } = createTestServer({
        fetch: async () => streaming
          ? new Response(`data: ${JSON.stringify(payload)}\n\n${completed ? "data: [DONE]\n\n" : ""}`, { headers: { "content-type": "text/event-stream" } })
          : Response.json(payload),
        analytics: async ({ requestId, startedAt, model }) => (streaming) => observeModelResponse({
          id: requestId, startedAt, model, streaming, sessionId: "session", taskId: "task",
        }, async (event) => { events.push(event) }),
      })
      const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", stream: streaming, messages: [{ role: "user", content: "private prompt" }] }) }))
      assert.equal(response.status, streaming || completed ? 200 : 502)
      const text = await response.text()
      assert.equal(text.includes("upstream_incomplete"), !completed)
      assert.equal(events.length, 1)
      assert.equal(events[0].id, response.headers.get("x-openwork-request-id"))
      assert.equal(events[0].status, completed ? "completed" : "failed")
      assert.equal(events[0].usageComplete, completed)
      assert.equal(events[0].inputTokens, 10)
      assert.equal(events[0].outputTokens, 4)
      assert.equal(events[0].cacheReadTokens, 2)
      assert.equal(events[0].costUsd, 0.01)
      assert.equal(events[0].provider, "test-provider")
      assert.ok(!JSON.stringify(events).includes("private"))
    })
  }
}

test("downstream cancellation records one cancelled analytics event, never success", async () => {
  const { observeModelResponse } = await import("../src/task-analytics.js")
  const events: import("@openwork-ee/telemetry").ModelsAnalyticsEvent[] = []
  let cancelled = false
  const { app } = createTestServer({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"cost":0.01}}\n\n'))
      },
      cancel() { cancelled = true },
    }), { headers: { "content-type": "text/event-stream" } }),
    analytics: async ({ requestId, startedAt, model }) => (streaming) => observeModelResponse({
      id: requestId, startedAt, model, streaming, sessionId: "session", taskId: "task",
    }, async (event) => { events.push(event) }),
  })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", stream: true, messages: [{ role: "user", content: "Hello" }] }) }))
  const reader = response.body?.getReader()
  assert.ok(reader)
  assert.equal((await reader.read()).done, false)
  await reader.cancel()
  assert.equal(cancelled, true)
  assert.equal(events.length, 1)
  assert.equal(events[0].status, "cancelled")
  assert.equal(events[0].usageComplete, false)
})

test("cancelled, malformed and oversized usage stays incomplete with one accounting event", async () => {
  const { observeModelResponse } = await import("../src/task-analytics.js")
  const events: import("@openwork-ee/telemetry").ModelsAnalyticsEvent[] = []
  for (const status of ["cancelled", "completed"] satisfies ("cancelled" | "completed")[]) {
    const observer = observeModelResponse({ id: status, sessionId: "session", taskId: "task", startedAt: Date.now(), model: "model", streaming: true }, async (event) => { events.push(event) })
    observer.chunk(new TextEncoder().encode('data: {"usage":nope}\n\n'))
    observer.chunk(new TextEncoder().encode("x".repeat(1_048_577)))
    observer.finish(status)
    observer.finish(status)
  }
  assert.equal(events.length, 2)
  assert.equal(events[0].status, "cancelled")
  assert.ok(events.every((event) => event.usageComplete === false && event.costUsd === undefined))
})

async function expectUnsupportedModelSelection(body: Record<string, unknown>) {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify(body),
  }))

  assert.equal(response.status, 400)
  assert.equal(await readErrorCode(response), "unsupported_model_selection")
  assert.equal(calls.findActiveInferenceKey, 1)
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
}

test("rewrites approved model aliases before forwarding JSON requests", async () => {
  const { app, upstreamRequests, calls, reports } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json; charset=utf-8"),
    body: JSON.stringify({ model: "openwork/z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 200)
  assert.equal(calls.ensureUsableBuckets, 1)
  assert.equal(calls.getOpenRouterProviderKey, 1)
  assert.equal(upstreamRequests.length, 1)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.method, "POST")
  assert.equal(upstream.url, "https://upstream.test/api/v1/chat/completions")
  assert.equal(upstream.headers.get("authorization"), "Bearer provider-key")
  assert.equal(upstream.headers.get("content-type"), "application/json")
  const body = parseJsonObject(requireBodyText(upstream.body))
  assert.equal(body.model, "z-ai/glm-5.2")
  assert.equal(body.user, "member_123")
  assert.equal(body.session_id, upstream.headers.get("x-openwork-request-id"))
  const trace = body.trace
  assert.ok(isRecord(trace))
  assert.equal(trace.generation_name, "z-ai/glm-5.2")
  assert.equal(trace.usage_started_at, "2026-09-08T12:00:00.123Z")

  const report = requireRequestReport(reports)
  assert.equal(report.organizationId, "organization_123")
  assert.equal(report.inferenceKeyId, "inference_key_123")
  assert.equal(report.openworkRequestId, upstream.headers.get("x-openwork-request-id"))
  assert.equal(report.route, "/api/v1/chat/completions")
  assert.equal(report.method, "POST")
  assert.equal(report.incomingModel, "z-ai/glm-5.2")
  assert.equal(report.resolvedUpstreamModel, "z-ai/glm-5.2")
})

test("returns model_not_found for unknown JSON model aliases", async () => {
  const { app, upstreamRequests, calls, reports } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "openwork/unknown-model", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 404)
  assert.equal(await readErrorCode(response), "model_not_found")
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
  const report = requireRequestReport(reports)
  assert.equal(report.incomingModel, null)
  assert.equal(report.resolvedUpstreamModel, null)
})

test("summarizes ordinary organization payload shape without message content or secrets", async () => {
  const { app, reports } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({
      model: "z-ai/glm-5.2",
      stream: true,
      api_key: "payload-secret-key",
      metadata: { password: "payload-password" },
      messages: [
        { role: "system", content: "top secret system prompt" },
        { role: "user", content: [{ type: "text", text: "top secret user prompt" }] },
      ],
      tools: [{
        type: "function",
        function: {
          name: "lookup_customer",
          description: "secret tool description",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "secret schema text" } },
            required: ["query"],
          },
        },
      }],
    }),
  }))

  assert.equal(response.status, 200)
  const report = requireRequestReport(reports)
  assert.equal(report.payloadMode, "summary")
  const payloadText = JSON.stringify(report.payload)
  assert.ok(!payloadText.includes("top secret system prompt"))
  assert.ok(!payloadText.includes("top secret user prompt"))
  assert.ok(!payloadText.includes("payload-secret-key"))
  assert.ok(!payloadText.includes("payload-password"))
  assert.ok(!payloadText.includes("secret tool description"))
  assert.ok(!payloadText.includes("secret schema text"))
  const payload = requireReportPayload(report)
  assert.equal(payload.stream, true)
  assert.equal(payload.messageCount, 2)
  assert.equal(payload.toolCount, 1)
})

test("every organization uses content-free diagnostics", async () => {
  const { app, reports } = createTestServer({ organizationId: "org_01krnrcabhe8htwpbnsw0zk0bw" })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "private prompt" }] }) }))
  assert.equal(response.status, 200)
  assert.equal(requireRequestReport(reports).payloadMode, "summary")
  assert.ok(!JSON.stringify(reports).includes("private prompt"))
})

test("redacts all caller-controlled header values", async () => {
  const { app, reports } = createTestServer()
  const headers = authHeaders("application/json")
  headers.set("key", "generic-header-key")
  headers.set("x-api-key", "test-key")
  headers.set("x-api-key-id", "api_key_id_123")
  headers.set("x-provider-key-id", "provider_key_id_123")
  headers.set("cookie", "session=secret")
  headers.set("client-secret", "client-secret-header")
  headers.set("x-private-key", "private-key-header")
  headers.set("sentry-dsn", "dsn-header")
  headers.set("x-signature", "signature-header")
  headers.set("x-custom-token", "caller-token")
  headers.set("forwarded", "for=203.0.113.1")
  headers.set("x-forwarded-for", "203.0.113.2")
  headers.set("x-real-ip", "203.0.113.3")
  headers.set("cf-connecting-ip", "203.0.113.4")
  headers.set("true-client-ip", "203.0.113.5")
  headers.set("x-inference-key-id", "inference_key_123")
  headers.set("x-safe-header", "safe-value")
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers,
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 200)
  const report = requireRequestReport(reports)
  assert.equal(report.headers.authorization, "[REDACTED]")
  assert.equal(report.headers.key, "[REDACTED]")
  assert.equal(report.headers["x-api-key"], "[REDACTED]")
  assert.equal(report.headers["x-api-key-id"], "[REDACTED]")
  assert.equal(report.headers["x-provider-key-id"], "[REDACTED]")
  assert.equal(report.headers.cookie, "[REDACTED]")
  assert.equal(report.headers["client-secret"], "[REDACTED]")
  assert.equal(report.headers["x-private-key"], "[REDACTED]")
  assert.equal(report.headers["sentry-dsn"], "[REDACTED]")
  assert.equal(report.headers["x-signature"], "[REDACTED]")
  assert.equal(report.headers["x-custom-token"], "[REDACTED]")
  assert.equal(report.headers.forwarded, "[REDACTED]")
  assert.equal(report.headers["x-forwarded-for"], "[REDACTED]")
  assert.equal(report.headers["x-real-ip"], "[REDACTED]")
  assert.equal(report.headers["cf-connecting-ip"], "[REDACTED]")
  assert.equal(report.headers["true-client-ip"], "[REDACTED]")
  assert.equal(report.headers["x-inference-key-id"], "[REDACTED]")
  assert.equal(report.headers["x-safe-header"], "[REDACTED]")
})

test("returns usage-limit 429 without reporting a handled error or contacting provider/upstream", async () => {
  const originalDateNow = Date.now
  Date.now = () => 1_700_000_000_000
  try {
    const { app, upstreamRequests, calls, reports } = createTestServer({ usageLimited: true })
    const response = await app.fetch(inferenceRequest({
      method: "POST",
      headers: authHeaders("application/json"),
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }),
    }))

    assert.equal(response.status, 429)
    assert.equal(await readErrorCode(response), "rate_limit_exceeded")
    assert.equal(response.headers.get("x-openwork-limit-bucket-id"), "bucket_123")
    assert.equal(response.headers.get("x-openwork-limit-window-type"), "monthly")
    assert.equal(response.headers.get("retry-after"), "90")
    assert.equal(response.headers.get("x-ratelimit-limit-tokens"), "100")
    assert.equal(response.headers.get("x-ratelimit-remaining-tokens"), "0")
    assert.equal(response.headers.get("x-ratelimit-reset-tokens"), "90s")
    assert.equal(calls.ensureUsableBuckets, 1)
    assert.equal(calls.getOpenRouterProviderKey, 0)
    assert.equal(upstreamRequests.length, 0)
    assert.equal(reports.handledErrors.length, 0)
  } finally {
    Date.now = originalDateNow
  }
})

test("reports handled upstream errors with searchable request context", async () => {
  const { app, reports } = createTestServer({
    fetch: async () => Response.json({ error: "upstream unavailable" }, { status: 503, statusText: "Service Unavailable" }),
  })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 503)
  const requestReport = requireRequestReport(reports)
  const errorReport = requireHandledErrorReport(reports)
  assert.equal(errorReport.reason, "upstream_failure")
  assert.equal(errorReport.organizationId, "organization_123")
  assert.equal(errorReport.inferenceKeyId, "inference_key_123")
  assert.equal(errorReport.openworkRequestId, requestReport.openworkRequestId)
  assert.equal(errorReport.route, "/api/v1/chat/completions")
  assert.equal(errorReport.method, "POST")
  assert.equal(errorReport.incomingModel, "z-ai/glm-5.2")
  assert.equal(errorReport.resolvedUpstreamModel, "z-ai/glm-5.2")
  assert.equal(errorReport.status, 503)
})

test("reports upstream connection failures without retaining exception payloads", async () => {
  const upstreamError = new Error("socket hang up")
  const { app, reports } = createTestServer({
    fetch: async () => {
      throw upstreamError
    },
  })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 502)
  const errorReport = requireHandledErrorReport(reports)
  assert.equal(errorReport.reason, "upstream_unreachable")
  assert.equal(errorReport.exception, undefined)
  assert.equal(errorReport.error, undefined)
  assert.equal(errorReport.organizationId, "organization_123")
  assert.equal(errorReport.inferenceKeyId, "inference_key_123")
})

test("blocks an unknown model when Content-Type is omitted", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "openwork/unknown-model", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 415)
  assert.equal(await readErrorCode(response), "unsupported_media_type")
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
})

test("blocks an unknown model sent as text/plain", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("text/plain"),
    body: JSON.stringify({ model: "openwork/unknown-model", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 415)
  assert.equal(await readErrorCode(response), "unsupported_media_type")
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
})

test("accepts application/*+json media types", async () => {
  const { app, upstreamRequests } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/vnd.openwork.request+json; charset=utf-8"),
    body: JSON.stringify({ model: "openwork/z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 200)
  assert.equal(upstreamRequests.length, 1)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  const body = parseJsonObject(requireBodyText(upstream.body))
  assert.equal(body.model, "z-ai/glm-5.2")
})

test("does not forward caller headers or session IDs that can affect routing", async () => {
  const { app, upstreamRequests } = createTestServer()
  const headers = authHeaders("application/json")
  headers.set("x-session-id", "caller-session")
  headers.set("x-openrouter-model", "attacker/model")
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers,
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }], session_id: "caller-session" }),
  }))

  assert.equal(response.status, 200)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.headers.get("x-session-id"), null)
  assert.equal(upstream.headers.get("x-openrouter-model"), null)
  const body = parseJsonObject(requireBodyText(upstream.body))
  assert.equal(body.session_id, upstream.headers.get("x-openwork-request-id"))
})

for (const [field, value] of [
  ["models", []],
  ["fallbacks", null],
  ["preset", ""],
  ["route", null],
] satisfies [string, unknown][]) {
  test(`rejects the top-level ${field} selector when present`, async () => {
    await expectUnsupportedModelSelection({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "Hello" }],
      [field]: value,
    })
  })
}

test("rejects the Fusion plugin", async () => {
  await expectUnsupportedModelSelection({
    model: "z-ai/glm-5.2",
    messages: [{ role: "user", content: "Hello" }],
    plugins: [{ id: "fusion" }],
  })
})

for (const field of ["model", "analysis_models", "allowed_models"]) {
  test(`rejects ${field} in an OpenRouter plugin context`, async () => {
    await expectUnsupportedModelSelection({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "Hello" }],
      plugins: [{ id: "web", [field]: null }],
    })
  })

  test(`rejects parameters.${field} in an OpenRouter plugin context`, async () => {
    await expectUnsupportedModelSelection({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "Hello" }],
      plugins: [{ id: "web", parameters: { [field]: null } }],
    })
  })
}

for (const type of [
  "openrouter:advisor",
  "openrouter:subagent",
  "openrouter:fusion",
  "openrouter:image_generation",
]) {
  test(`rejects the ${type} server tool`, async () => {
    await expectUnsupportedModelSelection({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ type }],
    })
  })
}

test("allows ordinary function tools with a model property in their JSON Schema", async () => {
  const { app, upstreamRequests } = createTestServer()
  const tools = [{
    type: "function",
    function: {
      name: "inspect_model",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string" },
        },
      },
    },
  }]
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }], tools }),
  }))

  assert.equal(response.status, 200)
  assert.equal(upstreamRequests.length, 1)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  const body = parseJsonObject(requireBodyText(upstream.body))
  assert.deepEqual(body.tools, tools)
})

test("returns the authenticated local model catalog without forwarding", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "GET",
    headers: authHeaders(),
    path: "/api/v1/models",
  }))

  assert.equal(response.status, 200)
  const payload: unknown = await response.json()
  assert.ok(isRecord(payload))
  assert.equal(payload.object, "list")
  assert.ok(Array.isArray(payload.data))
  assert.ok(payload.data.length > 0)
  const model = payload.data[0]
  assert.ok(isRecord(model))
  assert.equal(typeof model.id, "string")
  assert.ok(!model.id.startsWith("openwork/"))
  assert.equal(calls.findActiveInferenceKey, 1)
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
})

test("returns model IDs that can be requested as aliases", async () => {
  const { app, upstreamRequests } = createTestServer()
  const modelsResponse = await app.fetch(inferenceRequest({
    method: "GET",
    headers: authHeaders(),
    path: "/api/v1/models",
  }))
  const payload: unknown = await modelsResponse.json()
  assert.ok(isRecord(payload))
  assert.ok(Array.isArray(payload.data))
  const listedModel = payload.data[0]
  assert.ok(isRecord(listedModel))
  if (typeof listedModel.id !== "string") {
    throw new Error("Expected the local catalog to contain a model ID")
  }

  const chatResponse = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: listedModel.id, messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(chatResponse.status, 200)
  assert.equal(upstreamRequests.length, 1)
})

test("requires authentication before returning the local model catalog", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "GET",
    headers: new Headers(),
    path: "/api/v1/models",
  }))

  assert.equal(response.status, 401)
  assert.equal(await readErrorCode(response), "missing_api_key")
  assert.equal(calls.findActiveInferenceKey, 0)
  assert.deepEqual(calls.policyOrganizationIds, [])
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
})

for (const input of [
  { method: "GET", path: "/api/v1/chat/completions", status: 405, code: "method_not_allowed" },
  { method: "POST", path: "/api/v1/models", status: 405, code: "method_not_allowed" },
  { method: "POST", path: "/api/v1/responses", status: 404, code: "not_found" },
  { method: "GET", path: "/api/v1", status: 404, code: "not_found" },
]) {
  test(`blocks unsupported ${input.method} ${input.path} locally`, async () => {
    const { app, upstreamRequests, calls } = createTestServer()
    const response = await app.fetch(inferenceRequest({
      method: input.method,
      headers: authHeaders(),
      path: input.path,
    }))

    assert.equal(response.status, input.status)
    assert.equal(await readErrorCode(response), input.code)
    assert.equal(calls.findActiveInferenceKey, 1)
    assert.equal(calls.ensureUsableBuckets, 0)
    assert.equal(calls.getOpenRouterProviderKey, 0)
    assert.equal(upstreamRequests.length, 0)
  })
}

test("blocks chat completion query parameters locally", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    path: "/api/v1/chat/completions?model=attacker/random-model",
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "Hello" }] }),
  }))

  assert.equal(response.status, 400)
  assert.equal(await readErrorCode(response), "unsupported_query_parameters")
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
})

test("authenticates before rejecting unsupported routes", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: new Headers(),
    path: "/api/v1/responses",
  }))

  assert.equal(response.status, 401)
  assert.equal(await readErrorCode(response), "missing_api_key")
  assert.equal(calls.findActiveInferenceKey, 0)
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
})

test("injects stream_options.include_usage and logs one row with usage from the final stream chunk", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    fetch: async (input, init) => {
      upstreamRequests.push({ url: requestUrl(input), method: init?.method, body: readInitBody(init?.body), headers: new Headers(init?.headers) })
      return sseResponse([
        'data: {"id":"gen-1","model":"z-ai/glm-5.2","choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"id":"gen-1","model":"z-ai/glm-5.2","choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"id":"gen-1","model":"z-ai/glm-5.2","choices":[],"usage":{"prompt_tokens":1',
        '2,"completion_tokens":5,"total_tokens":17,"cost":0.00123,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
        "data: [DONE]\n\n",
      ], { headers: { "content-type": "text/event-stream", "x-request-id": "upstream-req-1" } })
    },
  })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", stream: true, stream_options: { foo: "bar" }, messages: [] }),
  }))

  assert.equal(response.status, 200)
  const requestId = response.headers.get("x-openwork-request-id")
  assert.ok(requestId)
  const text = await response.text()
  assert.ok(text.includes('"content":"Hel"'))
  assert.ok(text.endsWith("data: [DONE]\n\n"))

  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  const body = parseJsonObject(requireBodyText(upstream.body))
  assert.deepEqual(body.stream_options, { foo: "bar", include_usage: true })

  const row = await waitForRows(logRows)
  assert.equal(row.openwork_request_id, requestId)
  assert.equal(row.route, "openwork_openrouter")
  assert.equal(row.protocol, "openai_chat")
  assert.equal(row.upstream_provider_id, "openrouter")
  assert.equal(row.upstream_host, "upstream.test")
  assert.equal(row.upstream_path, "/api/v1/chat/completions")
  assert.equal(row.organization_id, "organization_123")
  assert.equal(row.org_membership_id, "member_123")
  assert.equal(row.inference_key_id, "inference_key_123")
  assert.equal(row.stream, true)
  assert.equal(row.status, 200)
  assert.equal(row.outcome, "ok")
  assert.equal(row.usage_source, "stream")
  assert.equal(row.input_tokens, 12)
  assert.equal(row.output_tokens, 5)
  assert.equal(row.total_tokens, 17)
  assert.equal(row.cache_read_tokens, 4)
  assert.equal(row.reasoning_tokens, 2)
  assert.equal(row.cost_micro_usd, 1230)
  assert.equal(row.upstream_model, "z-ai/glm-5.2")
  assert.equal(row.requested_model, "z-ai/glm-5.2")
  assert.equal(row.upstream_request_id, "upstream-req-1")
  assert.ok(row.first_byte_at)
  assert.ok(row.completed_at)
  assert.equal(row.response_bytes, Buffer.byteLength(text))
})

test("logs usage from a non-streaming JSON response without altering the bytes", async () => {
  const upstreamBody = JSON.stringify({ id: "gen-2", model: "z-ai/glm-5.2-upstream", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })
  const { app, logRows } = createTestServer({
    fetch: async () => new Response(upstreamBody, { status: 200, headers: { "content-type": "application/json" } }),
  })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
  }))

  assert.equal(response.status, 200)
  assert.ok(response.headers.get("x-openwork-request-id"))
  assert.equal(await response.text(), upstreamBody)
  const row = await waitForRows(logRows)
  assert.equal(row.stream, false)
  assert.equal(row.outcome, "ok")
  assert.equal(row.usage_source, "json")
  assert.equal(row.input_tokens, 3)
  assert.equal(row.output_tokens, 4)
  assert.equal(row.total_tokens, 7)
  assert.equal(row.cost_micro_usd, null)
  assert.equal(row.upstream_model, "z-ai/glm-5.2-upstream")
})

test("logs a rejected row for model_not_found", async () => {
  const { app, logRows } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "openwork/unknown-model", stream: true, messages: [] }),
  }))

  assert.equal(response.status, 404)
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "rejected")
  assert.equal(row.error_code, "model_not_found")
  assert.equal(row.status, 404)
  assert.equal(row.protocol, "openai_chat")
  assert.equal(row.requested_model, "openwork/unknown-model")
  assert.equal(row.upstream_model, "openwork/unknown-model")
  assert.equal(row.stream, true)
  assert.equal(row.usage_source, "missing")
  assert.equal(row.upstream_host, "upstream.test")
})

test("logs a rejected row for rate_limit_exceeded", async () => {
  const { app, logRows } = createTestServer({ usageLimited: true })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
  }))

  assert.equal(response.status, 429)
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "rejected")
  assert.equal(row.error_code, "rate_limit_exceeded")
  assert.equal(row.status, 429)
  assert.equal(row.upstream_model, "z-ai/glm-5.2")
})

test("does not log a row for 401 authentication failures", async () => {
  const { app, logRows } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
  }))

  assert.equal(response.status, 401)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(logRows.length, 0)
})

test("logs client_aborted when the client cancels mid-stream", async () => {
  let upstreamCancelled = false
  const encoder = new TextEncoder()
  const { app, logRows } = createTestServer({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"model":"z-ai/glm-5.2","choices":[{"delta":{"content":"partial"}}]}\n\n'))
      },
      cancel() {
        upstreamCancelled = true
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", stream: true, messages: [] }),
  }))

  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  await reader.cancel()

  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "client_aborted")
  assert.equal(row.status, 200)
  assert.equal(row.usage_source, "missing")
  assert.equal(row.input_tokens, null)
  assert.ok(row.first_byte_at)
  assert.equal(upstreamCancelled, true)
})

test("logs upstream_error for a non-2xx upstream response", async () => {
  const { app, logRows } = createTestServer({
    fetch: async () => Response.json({ error: "upstream unavailable" }, { status: 503 }),
  })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
  }))

  assert.equal(response.status, 503)
  await response.arrayBuffer()
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "upstream_error")
  assert.equal(row.status, 503)
  assert.equal(row.usage_source, "missing")
})
