import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { VoiceDependencies } from "../src/voice.js"
import type { SettleUsageInput } from "../src/webhooks.js"
import { assertManagedModelsAllowed, ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import type { InferenceHandledErrorReport, InferenceReporter, InferenceRequestReport } from "../src/inference-reporting.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
process.env.OPENROUTER_UPSTREAM_URL = "https://upstream.test/api/v1"

const { registerProxyRoutes } = await import("../src/proxy.js")
const { registerVoiceRoutes, validateSpeechAudio } = await import("../src/voice.js")
const { VOICE_SPEECH_MODEL, VOICE_TRANSCRIPTION_MODEL } = await import("../src/model-catalog.js")

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
    reporter,
  })

  return { app, upstreamRequests, calls, reports }
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
  assert.deepEqual(payload.roles, ["system", "user"])
})

test("every organization uses content-free diagnostics", async () => {
  const { app, reports } = createTestServer({ organizationId: "org_01krnrcabhe8htwpbnsw0zk0bw" })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "private prompt" }] }) }))
  assert.equal(response.status, 200)
  assert.equal(requireRequestReport(reports).payloadMode, "summary")
  assert.ok(!JSON.stringify(reports).includes("private prompt"))
})

test("redacts credential-like incoming headers without redacting non-secret IDs", async () => {
  const { app, reports } = createTestServer()
  const headers = authHeaders("application/json")
  headers.set("key", "generic-header-key")
  headers.set("x-api-key", "caller-api-key")
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
  assert.deepEqual(report.headers, { "content-type": "application/json" })
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
  assert.equal(errorReport.error, "Upstream connection failed")
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

function mp3(frames = 3) {
  const bytes = new Uint8Array(417 * frames)
  for (let frame = 0; frame < frames; frame++) bytes.set([255, 251, 144, 100], frame * 417)
  return bytes
}

function voiceServer(overrides: Partial<VoiceDependencies> = {}) {
  const app = new Hono()
  const key: NonNullable<Awaited<ReturnType<VoiceDependencies["findActiveInferenceKey"]>>> = {
    id: createDenTypeId("inferenceKey"), organization_id: createDenTypeId("organization"), org_membership_id: createDenTypeId("member"),
    status: "active", revoked_at: null, name: "Fixture", key_hash: "fixture-hash", key_prefix: "fixture", created_at: new Date(), updated_at: new Date(),
  }
  const calls: UpstreamRequest[] = []
  const receipts: SettleUsageInput[] = []
  const dependencies: VoiceDependencies = {
    async findActiveInferenceKey() { return key },
    async findInferenceKeyById() { return key },
    async assertOrganizationManagedModelsAllowed() {},
    async readVoiceMembership() { return "ready" },
    async getOpenRouterProviderKey() { return {
      id: createDenTypeId("inferenceOrgProviderKey"), organization_id: key.organization_id, provider: "openrouter", encrypted_api_key: "server-only-provider-key",
      key_prefix: "fixture", external_key_hash: null, external_workspace_id: null, status: "active", revoked_at: null, created_at: new Date(), updated_at: new Date(),
    } },
    async ensureUsableBuckets() { return { ok: true, admittedAt: new Date(), bucketLimits: {}, bucketIds: {
      five_hour: createDenTypeId("inferenceOrgUsageBucket"), weekly: createDenTypeId("inferenceOrgUsageBucket"), monthly: createDenTypeId("inferenceOrgUsageBucket"),
    } } },
    async pendingVoiceRequests() {
      const latest = new Map(receipts.map((entry) => [entry.span.openworkRequestId, entry]))
      return [...latest.values()].filter((entry) => entry.costAmount === null).map(({ inferenceKey, span }) => ({
        id: createDenTypeId("inferenceUsageLedgerEntry"), organization_id: inferenceKey.organization_id,
        org_membership_id: inferenceKey.org_membership_id, inference_key_id: inferenceKey.id,
        external_job_id: span.openworkRequestId, external_event_id: span.externalEventId, cost_amount: 0, model_id: span.reportedModel,
        provider_id: "openrouter", input_tokens: null, output_tokens: null, total_tokens: null, event_type: "openrouter_audio_pending",
        provider_usage: null, occurred_at: span.occurredAt, created_at: span.occurredAt,
      }))
    },
    async recordInferenceRequest(input) {
      receipts.push(structuredClone(input))
      return input.costAmount === null ? "deferred" : "ingested"
    },
    async fetch(url, init) {
      calls.push({ url: requestUrl(url), method: init?.method, body: readInitBody(init?.body), headers: new Headers(init?.headers), redirect: init?.redirect })
      if (requestUrl(url).includes("/generation?")) return Response.json({ data: { id: "gen-fixture", model: VOICE_SPEECH_MODEL, api_type: null, total_cost: 0.002 } })
      if (requestUrl(url).endsWith("/speech")) return new Response(mp3(), { headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-fixture" } })
      return Response.json({ text: "A transcription", usage: { cost: 0.001 } }, { headers: { "x-generation-id": "gen-fixture" } })
    },
    timeoutMs: 1000,
    ...overrides,
  }
  registerVoiceRoutes(app, dependencies)
  const request = (path: string, body?: unknown, signal?: AbortSignal) => app.fetch(new Request(`http://inference.test/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: authHeaders(body === undefined ? undefined : "application/json"),
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  }))
  return { app, request, calls, receipts, key, dependencies }
}

test("voice status and dispatch enforce membership, credentials, policy, readiness and quota", async () => {
  for (const [override, status, access, code] of [
    [{ readVoiceMembership: async () => "membership_required" }, 403, "membership_required", "voice_membership_required"],
    [{ assertOrganizationManagedModelsAllowed: async () => { throw new Error("private database details") } }, 503, "unavailable", "voice_unavailable"],
    [{ getOpenRouterProviderKey: async () => null }, 503, "unavailable", "voice_unavailable"],
    [{ ensureUsableBuckets: async () => ({ ok: false, bucketIds: {}, bucketLimits: {}, limitedBy: "fixture", windowType: "monthly" }) }, 429, "unavailable", "voice_quota_exhausted"],
  ] satisfies Array<[Partial<VoiceDependencies>, number, string, string]>) {
    const server = voiceServer(override)
    const read = await server.request("voice")
    assert.equal(read.status, 200)
    assert.equal((await read.json()).access, access)
    const denied = await server.request("audio/speech", { input: "Hello" })
    assert.equal(denied.status, status)
    assert.equal(await readErrorCode(denied), code)
    assert.equal(server.calls.length, 0)
    assert.equal(server.receipts.length, 0)
  }
  const invalid = voiceServer({ findActiveInferenceKey: async () => null })
  assert.equal((await invalid.request("voice")).status, 401)
  const ready = voiceServer()
  assert.deepEqual(await (await ready.request("voice")).json(), { access: "ready" })
  assert.equal(ready.calls.length, 0)
  assert.equal(ready.receipts.length, 0)
})

test("voice pins OpenRouter models, counts response cost once, and returns only text or validated MP3", async () => {
  const stt = voiceServer()
  const response = await stt.request("audio/transcriptions", { input_audio: { data: "AQID", format: "webm" } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { text: "A transcription" })
  assert.equal(stt.calls.length, 1)
  assert.equal(stt.calls[0]!.url, "https://upstream.test/api/v1/audio/transcriptions")
  const sent = parseJsonObject(stt.calls[0]!.body!)
  assert.equal(sent.model, VOICE_TRANSCRIPTION_MODEL)
  assert.equal(sent.user, stt.key.org_membership_id)
  assert.equal(stt.calls[0]!.headers.get("authorization"), "Bearer server-only-provider-key")
  assert.equal(stt.calls[0]!.redirect, "error")
  assert.equal(stt.receipts[0]!.admitVoice, true)
  assert.deepEqual(stt.receipts.map((entry) => entry.costAmount), [null, null, 100000])
  assert.equal(new Set(stt.receipts.map((entry) => entry.span.openworkRequestId)).size, 1)
  assert.equal(stt.receipts.at(-1)!.span.externalEventId, "gen-fixture")
  assert.equal(JSON.stringify(stt.receipts).includes("A transcription"), false)

  const tts = voiceServer()
  const speech = await tts.request("audio/speech", { input: "Hello" })
  assert.equal(speech.status, 200)
  assert.equal(speech.headers.get("content-type"), "audio/mpeg")
  assert.deepEqual(new Uint8Array(await speech.arrayBuffer()), mp3())
  assert.deepEqual(parseJsonObject(tts.calls[0]!.body!).voice, "coral")
  assert.equal(parseJsonObject(tts.calls[0]!.body!).model, VOICE_SPEECH_MODEL)
  assert.equal(tts.calls[1]!.url, "https://upstream.test/api/v1/generation?id=gen-fixture")
  assert.equal(tts.calls[1]!.redirect, "error")
  assert.equal(tts.receipts.at(-1)!.costAmount, 200000)
})

test("voice rejects invalid or oversized input before admission, including streamed bodies without length", async () => {
  const server = voiceServer()
  for (const input of [{ input: " " }, { input: "x".repeat(601) }, { input: "Hi", model: "other" }, { input: "Hi", voice: "other" }]) {
    assert.equal((await server.request("audio/speech", input)).status, 400)
  }
  for (const data of ["", "%%==", "AR==", "AQID\n", "data:audio/webm;base64,AQID"]) {
    assert.equal((await server.request("audio/transcriptions", { input_audio: { data, format: "webm" } })).status, 400)
  }
  assert.equal((await server.request("audio/transcriptions", { input_audio: { data: "AQID", format: "flac" } })).status, 400)
  let cancelled = false
  const request = new Request("http://inference.test/api/v1/audio/transcriptions", {
    method: "POST", headers: authHeaders("application/json"), duplex: "half",
    body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } }),
  })
  assert.equal((await server.app.fetch(request)).status, 413)
  assert.equal(cancelled, true)
  assert.equal(server.receipts.length, 0)
  assert.equal(server.calls.length, 0)
})

test("voice rechecks revocation at dispatch and settles a known undispatched request as zero", async () => {
  let checks = 0
  const server = voiceServer({ readVoiceMembership: async () => ++checks === 1 ? "ready" : "membership_required" })
  const response = await server.request("audio/speech", { input: "Hello" })
  assert.equal(response.status, 403)
  assert.equal(await readErrorCode(response), "voice_membership_required")
  assert.equal(server.calls.length, 0)
  assert.equal(server.receipts.at(-1)!.costAmount, 0)

  const revoked = voiceServer()
  let providerReads = 0
  let removed = false
  const provider = revoked.dependencies.getOpenRouterProviderKey
  revoked.dependencies.getOpenRouterProviderKey = async (org) => {
    const result = await provider(org)
    if (++providerReads === 2) removed = true
    return result
  }
  revoked.dependencies.findActiveInferenceKey = async () => removed ? null : revoked.key
  assert.equal((await revoked.request("audio/speech", { input: "No longer authorized" })).status, 401)
  assert.equal(revoked.calls.length, 0)
  assert.equal(revoked.receipts.at(-1)!.costAmount, 0)
})

test("missing or mismatched generation accounting retains an unknown receipt under its hold", async () => {
  for (const payload of [null, { id: "different", model: VOICE_SPEECH_MODEL, api_type: "tts", total_cost: 1 }, { id: "gen-fixture", model: VOICE_SPEECH_MODEL, api_type: "tts", total_cost: null }, { id: "gen-fixture", model: VOICE_SPEECH_MODEL, api_type: "stt", total_cost: 1 }]) {
    let generations = 0
    const server = voiceServer({ fetch: async (url) => {
      if (requestUrl(url).includes("/generation?")) return Response.json({ data: payload })
      generations++
      return new Response(mp3(), { headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-fixture" } })
    } })
    const response = await server.request("audio/speech", { input: "Hello" })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "audio/mpeg")
    assert.equal(server.receipts.at(-1)!.costAmount, null)
    assert.equal(generations, 1)
  }
  const noPrice = voiceServer({ fetch: async () => Response.json({ text: "Not free", usage: { cost: null } }) })
  assert.equal((await noPrice.request("audio/transcriptions", { input_audio: { data: "AQID", format: "wav" } })).status, 200)
  assert.equal(noPrice.receipts.at(-1)!.costAmount, null)
})

test("voice cancellation finishes one admitted packet for accounting and the next status is ready", async () => {
  for (const operation of ["speech", "transcriptions"]) for (const phase of ["headers", "body"]) {
    const controller = new AbortController()
    let generations = 0
    let readComplete = false
    const server = voiceServer({ fetch: async (url, init) => {
      if (requestUrl(url).includes("/generation?")) {
        assert.equal(readComplete, true)
        assert.equal(init?.signal?.aborted, false)
        return Response.json({ data: { id: "gen-fixture", model: VOICE_SPEECH_MODEL, api_type: null, total_cost: 0.003 } })
      }
      generations++
      if (phase === "headers") controller.abort()
      assert.equal(init?.signal?.aborted, false)
      return new Response(new ReadableStream({ pull(output) {
        if (phase === "body") controller.abort()
        assert.equal(init?.signal?.aborted, false)
        output.enqueue(operation === "speech" ? mp3() : new TextEncoder().encode(JSON.stringify({ text: "Never delivered", usage: { cost: 0.003 } })))
        output.close()
        readComplete = true
      } }, { highWaterMark: 0 }), { headers: { "content-type": operation === "speech" ? "audio/mpeg" : "application/json", "x-generation-id": "gen-fixture" } })
    } })
    const response = await server.request(`audio/${operation}`, operation === "speech" ? { input: "Hello" } : { input_audio: { data: "AQID", format: "wav" } }, controller.signal)
    assert.equal(response.status, 408)
    assert.equal(await readErrorCode(response), "voice_request_cancelled")
    assert.equal(readComplete, true)
    assert.equal(server.receipts.at(-1)!.costAmount, 300000)
    assert.deepEqual(await (await server.request("voice")).json(), { access: "ready" })
    assert.equal(generations, 1)
  }

  const before = voiceServer()
  const controller = new AbortController()
  const record = before.dependencies.recordInferenceRequest
  before.dependencies.recordInferenceRequest = async (receipt) => {
    const result = await record(receipt)
    if (receipt.admitVoice) controller.abort()
    return result
  }
  assert.equal((await before.request("audio/speech", { input: "Do not send" }, controller.signal)).status, 408)
  assert.equal(before.calls.length, 0)
  assert.equal(before.receipts.at(-1)!.costAmount, 0)
  assert.deepEqual(await (await before.request("voice")).json(), { access: "ready" })
})

test("known provider rejections settle zero without blocking retry; ambiguous failures stay pending", async () => {
  for (const status of [400, 401, 402, 403, 404, 405, 413, 415, 422, 429, 408, 500]) {
    const server = voiceServer()
    const fetch = server.dependencies.fetch
    server.dependencies.fetch = async () => Response.json({ error: "Rejected" }, { status })
    assert.equal((await server.request("audio/speech", { input: "Hello" })).status, 503)
    const unknown = status === 408 || status === 500
    assert.equal(server.receipts.at(-1)!.costAmount, unknown ? null : 0)
    server.dependencies.fetch = fetch
    assert.equal((await (await server.request("voice")).json()).access, "ready")
    if (status === 404) assert.equal((await server.request("audio/speech", { input: "Retry" })).status, 200)
  }
  const withGeneration = voiceServer({ fetch: async (url) => requestUrl(url).includes("/generation?")
    ? Response.json({ data: { id: "gen-fixture", model: VOICE_SPEECH_MODEL, api_type: null, total_cost: 0.001 } })
    : Response.json({ error: "Rejected after generation" }, { status: 400, headers: { "x-generation-id": "gen-fixture" } }),
  })
  assert.equal((await withGeneration.request("audio/speech", { input: "Hello" })).status, 503)
  assert.equal(withGeneration.receipts.at(-1)!.costAmount, 100000)
})

test("speech rejects truncated and over-duration MP3 and still accounts for rejected output", async () => {
  assert.doesNotThrow(() => validateSpeechAudio(mp3()))
  for (const bytes of [new Uint8Array(), mp3().slice(0, -1), mp3(4600)]) assert.throws(() => validateSpeechAudio(bytes))
  const server = voiceServer({ fetch: async (url) => requestUrl(url).includes("/generation?")
    ? Response.json({ data: { id: "gen-fixture", model: VOICE_SPEECH_MODEL, api_type: "tts", total_cost: 0.002 } })
    : new Response(mp3().slice(0, -1), { headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-fixture" } }),
  })
  assert.equal((await server.request("audio/speech", { input: "Hello" })).status, 503)
  assert.equal(server.receipts.at(-1)!.costAmount, 200000)
})

test("voice recovery never resynthesizes an old request or couples readiness to a lost receipt", async () => {
  const server = voiceServer()
  let pending = true
  let id: string | null = "gen-fixture"
  server.dependencies.pendingVoiceRequests = async () => pending ? [{
    id: createDenTypeId("inferenceUsageLedgerEntry"), organization_id: server.key.organization_id,
    org_membership_id: server.key.org_membership_id, inference_key_id: server.key.id,
    external_job_id: "original-request", external_event_id: id, cost_amount: 0, model_id: VOICE_SPEECH_MODEL,
    provider_id: "openrouter", input_tokens: null, output_tokens: null, total_tokens: null, event_type: "openrouter_audio_pending",
    provider_usage: null, occurred_at: new Date("2026-09-08T12:00:00Z"), created_at: new Date(),
  }] : []
  const originalRecord = server.dependencies.recordInferenceRequest
  server.dependencies.recordInferenceRequest = async (receipt) => {
    const result = await originalRecord(receipt)
    if (result === "ingested") pending = false
    return result
  }
  assert.deepEqual(await (await server.request("voice")).json(), { access: "ready" })
  assert.equal(server.calls.length, 0)
  assert.equal((await server.request("audio/speech", { input: "New packet" })).status, 200)
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 1)
  assert.ok(server.calls[0]!.url.includes("/generation?"))
  assert.equal(server.receipts[0]!.span.openworkRequestId, "original-request")
  assert.equal(server.receipts[0]!.span.occurredAt.toISOString(), "2026-09-08T12:00:00.000Z")
  assert.equal(server.receipts[0]!.costAmount, 200000)
  pending = true
  id = null
  assert.equal((await (await server.request("voice")).json()).access, "ready")
  assert.equal((await server.request("audio/speech", { input: "Another new packet" })).status, 200)
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 2)
  const refused = voiceServer({ recordInferenceRequest: async () => "skipped" })
  assert.equal((await refused.request("audio/speech", { input: "No reservation capacity" })).status, 429)
  assert.equal(refused.calls.length, 0)
})

test("speech response byte limits cancel a lengthless provider stream without losing its charge", async () => {
  let cancelled = false
  const server = voiceServer({ fetch: async (url) => requestUrl(url).includes("/generation?")
    ? Response.json({ data: { id: "gen-fixture", model: VOICE_SPEECH_MODEL, api_type: "tts", total_cost: 0.002 } })
    : new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } }),
      { headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-fixture" } }),
  })
  assert.equal((await server.request("audio/speech", { input: "Hello" })).status, 503)
  assert.equal(cancelled, true)
  assert.equal(server.receipts.at(-1)!.costAmount, 200000)
})

test("voice upload deadlines are bounded without admission or upstream work", async () => {
  const server = voiceServer({ timeoutMs: 20 })
  const request = new Request("http://inference.test/api/v1/audio/speech", {
    method: "POST", headers: authHeaders("application/json"), duplex: "half", body: new ReadableStream(),
  })
  const response = await server.app.fetch(request)
  assert.equal(response.status, 504)
  assert.equal(server.receipts.length, 0)
  assert.equal(server.calls.length, 0)
})
