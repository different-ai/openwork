import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { Hono } from "hono"
import type { InferenceHandledErrorReport, InferenceReporter, InferenceRequestReport } from "../src/inference-reporting.js"
import { freeInferenceAccess, freeInferenceWindow, inferenceAccessMode, INFERENCE_ACCESS_REASONS, INFERENCE_FREE_MODEL_ID, readFreeInferenceConfig } from "@openwork/types/den/inference"
import { FREE_INPUT_CONTENT_MAX_BYTES, FREE_MAX_OUTPUT_TOKENS, FREE_REQUEST_MAX_BYTES, freeRequestReservation, inspectFreeRequest, prepareFreeRequest, readFreeRequest } from "../src/free-request.js"
import { meterFreeResponse } from "../src/free-response.js"
import type { FreeSettlement } from "../src/free-allowance.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
process.env.OPENROUTER_UPSTREAM_URL = "https://upstream.test/api/v1"

const { registerProxyRoutes } = await import("../src/proxy.js")

type UpstreamRequest = {
  url: string
  method: string | undefined
  body: string | null
  headers: Headers
}

type DependencyCalls = {
  findActiveInferenceKey: number
  getOpenRouterProviderKey: number
  ensureUsableBuckets: number
}

type CapturedReports = {
  requests: InferenceRequestReport[]
  handledErrors: InferenceHandledErrorReport[]
}

type TestServerOptions = {
  requireDesktopFree?: typeof import("../src/desktop-free-access.js").requireMemberFreeDesktop
  settleFreeInference?: typeof import("../src/free-allowance.js").settleFreeInference
  accessMode?: ReturnType<typeof inferenceAccessMode>
  missingUser?: boolean
  freeConfig?: ReturnType<typeof readFreeInferenceConfig>
  reserveFreeInference?: typeof import("../src/free-allowance.js").reserveFreeInference
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
  const reports: CapturedReports = { requests: [], handledErrors: [] }
  const calls: DependencyCalls = {
    findActiveInferenceKey: 0,
    getOpenRouterProviderKey: 0,
    ensureUsableBuckets: 0,
  }
  const upstreamFetch: typeof fetch = options.fetch ?? (async (input, init) => {
    upstreamRequests.push({
      url: requestUrl(input),
      method: init?.method,
      body: readInitBody(init?.body),
      headers: new Headers(init?.headers),
    })
    return Response.json({ ok: true })
  })
  const reporter: InferenceReporter = {
    request(report) {
      reports.requests.push(report)
    },
    handledError(report) {
      reports.handledErrors.push(report)
    },
  }

  registerProxyRoutes(app, {
    async findActiveInferenceKey(_key) {
      calls.findActiveInferenceKey += 1
      return {
        id: "inference_key_123",
        organization_id: options.organizationId ?? "organization_123",
        org_membership_id: "member_123",
        accessMode: options.accessMode ?? "paid",
        user_id: options.missingUser ? null : "user_123",
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
        bucketIds: {},
        bucketLimits: {},
      }
    },
    fetch: upstreamFetch,
    analytics: options.analytics,
    reporter,
    freeConfig: options.freeConfig ?? readFreeInferenceConfig({ INFERENCE_FREE_ENABLED: "true" }),
    freeUpstreamApiKey: "free-provider-key",
    reserveFreeInference: options.reserveFreeInference,
    settleFreeInference: options.settleFreeInference,
    // These existing tests isolate member accounting; desktop admission has
    // separate cryptographic tests, plus the real missing-proof guard below.
    requireDesktopFree: options.requireDesktopFree ?? (async () => null),
  })

  return { app, upstreamRequests, calls, reports }
}

test("member-free bearer alone cannot discover or spend, while paid remains independent", async () => {
  const { requireMemberFreeDesktop } = await import("../src/desktop-free-access.js")
  let reservations = 0
  const free = createTestServer({
    accessMode: "free", requireDesktopFree: requireMemberFreeDesktop,
    reserveFreeInference: async () => { reservations++; throw new Error("must not reserve") },
  })
  const models = await free.app.fetch(inferenceRequest({ path: "/api/v1/models", method: "GET", headers: authHeaders() }))
  assert.equal(models.status, 401)
  const chat = await free.app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "hi" }] }) }))
  assert.equal(chat.status, 401)
  assert.equal(reservations, 0)
  assert.equal(free.upstreamRequests.length, 0)
  assert.equal(free.calls.getOpenRouterProviderKey, 0)
  assert.equal(free.calls.ensureUsableBuckets, 0)
  const paid = createTestServer({ requireDesktopFree: async () => { throw new Error("paid must not enter desktop gate") } })
  assert.equal((await paid.app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: INFERENCE_FREE_MODEL_ID, messages: [] }) }))).status, 200)
  assert.equal(paid.upstreamRequests.length, 1)
})

test("analytics storage failures preserve exact streamed bytes and upstream status", async () => {
  const { observeModelResponse } = await import("../src/task-analytics.js")
  const body = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'
  const { app } = createTestServer({
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    analytics: async ({ requestId, startedAt }) => (streaming) => observeModelResponse({
      id: requestId, startedAt, streaming, sessionId: "session", taskId: "task", model: "model",
    }, async () => { throw new Error("store unavailable") }),
  })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }) }))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
})

test("an unavailable analytics check leaves existing inference operational", async () => {
  const { app } = createTestServer({ analytics: async () => { throw new Error("analytics offline") } })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test("an analytics observer failure cannot truncate an upstream response", async () => {
  const body = "data: original response\n\ndata: [DONE]\n\n"
  const { app } = createTestServer({
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    analytics: async () => () => ({ chunk() { throw new Error("parser unavailable") }, finish() { throw new Error("observer unavailable") } }),
  })
  const response = await app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }) }))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
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
    body: JSON.stringify({ model: "openwork/z-ai/glm-5.2", messages: [] }),
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

  const report = requireRequestReport(reports)
  assert.equal(report.organizationId, "organization_123")
  assert.equal(report.inferenceKeyId, "inference_key_123")
  assert.equal(report.openworkRequestId, upstream.headers.get("x-openwork-request-id"))
  assert.equal(report.route, "/api/v1/chat/completions")
  assert.equal(report.method, "POST")
  assert.equal(report.incomingModel, "openwork/z-ai/glm-5.2")
  assert.equal(report.resolvedUpstreamModel, "z-ai/glm-5.2")
})

test("returns model_not_found for unknown JSON model aliases", async () => {
  const { app, upstreamRequests, calls, reports } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "openwork/unknown-model", messages: [] }),
  }))

  assert.equal(response.status, 404)
  assert.equal(await readErrorCode(response), "model_not_found")
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
  assert.equal(upstreamRequests.length, 0)
  const report = requireRequestReport(reports)
  assert.equal(report.incomingModel, "openwork/unknown-model")
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

test("logs full debug organization payload with recursive credential redaction", async () => {
  const { app, reports } = createTestServer({ organizationId: "org_01krnrcabhe8htwpbnsw0zk0bw" })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({
      model: "z-ai/glm-5.2",
      api_key: "payload-secret-key",
      key: "generic-key-secret",
      private_key: "private-key-secret",
      client_secret: "client-secret-value",
      clientKey: "client-key-value",
      dsn: "dsn-secret",
      signature: "signature-secret",
      max_tokens: 128,
      nested: {
        password: "payload-password",
        providerKey: "provider-secret-key",
        inferenceKeyId: "inference_key_123",
        api_key_id: "api_key_id_123",
        provider_key_id: "provider_key_id_123",
      },
      messages: [{
        role: "assistant",
        content: "debug prompt content",
        tool_calls: [{
          type: "function",
          function: {
            name: "lookup_customer",
            arguments: JSON.stringify({
              password: "argument-password",
              private_key: "argument-private-key",
              query: "debug argument content",
              api_key_id: "argument_api_key_id",
            }),
          },
        }],
      }],
    }),
  }))

  assert.equal(response.status, 200)
  const report = requireRequestReport(reports)
  assert.equal(report.payloadMode, "full")
  const payloadText = JSON.stringify(report.payload)
  assert.ok(payloadText.includes("debug prompt content"))
  assert.ok(payloadText.includes("debug argument content"))
  assert.ok(payloadText.includes("inference_key_123"))
  assert.ok(payloadText.includes("api_key_id_123"))
  assert.ok(payloadText.includes("provider_key_id_123"))
  assert.ok(payloadText.includes("argument_api_key_id"))
  assert.ok(payloadText.includes("128"))
  assert.ok(!payloadText.includes("payload-secret-key"))
  assert.ok(!payloadText.includes("generic-key-secret"))
  assert.ok(!payloadText.includes("private-key-secret"))
  assert.ok(!payloadText.includes("client-secret-value"))
  assert.ok(!payloadText.includes("client-key-value"))
  assert.ok(!payloadText.includes("dsn-secret"))
  assert.ok(!payloadText.includes("signature-secret"))
  assert.ok(!payloadText.includes("payload-password"))
  assert.ok(!payloadText.includes("provider-secret-key"))
  assert.ok(!payloadText.includes("argument-password"))
  assert.ok(!payloadText.includes("argument-private-key"))
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
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
  }))

  assert.equal(response.status, 200)
  const report = requireRequestReport(reports)
  assert.equal(report.headers.authorization, "[REDACTED]")
  assert.equal(report.headers.key, "[REDACTED]")
  assert.equal(report.headers["x-api-key"], "[REDACTED]")
  assert.equal(report.headers["x-api-key-id"], "api_key_id_123")
  assert.equal(report.headers["x-provider-key-id"], "provider_key_id_123")
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
  assert.equal(report.headers["x-inference-key-id"], "inference_key_123")
  assert.equal(report.headers["x-safe-header"], "safe-value")
})

test("returns usage-limit 429 without reporting a handled error or contacting provider/upstream", async () => {
  const originalDateNow = Date.now
  Date.now = () => 1_700_000_000_000
  try {
    const { app, upstreamRequests, calls, reports } = createTestServer({ usageLimited: true })
    const response = await app.fetch(inferenceRequest({
      method: "POST",
      headers: authHeaders("application/json"),
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
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
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
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

test("reports caught upstream fetch exceptions with the original Error object", async () => {
  const upstreamError = new Error("socket hang up")
  const { app, reports } = createTestServer({
    fetch: async () => {
      throw upstreamError
    },
  })
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
  }))

  assert.equal(response.status, 502)
  const errorReport = requireHandledErrorReport(reports)
  assert.equal(errorReport.reason, "upstream_unreachable")
  assert.equal(errorReport.exception, upstreamError)
  assert.equal(errorReport.error, "socket hang up")
  assert.equal(errorReport.organizationId, "organization_123")
  assert.equal(errorReport.inferenceKeyId, "inference_key_123")
})

test("blocks an unknown model when Content-Type is omitted", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "openwork/unknown-model", messages: [] }),
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
    body: JSON.stringify({ model: "openwork/unknown-model", messages: [] }),
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
    body: JSON.stringify({ model: "openwork/z-ai/glm-5.2", messages: [] }),
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
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [], session_id: "caller-session" }),
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
      messages: [],
      [field]: value,
    })
  })
}

test("rejects the Fusion plugin", async () => {
  await expectUnsupportedModelSelection({
    model: "z-ai/glm-5.2",
    messages: [],
    plugins: [{ id: "fusion" }],
  })
})

for (const field of ["model", "analysis_models", "allowed_models"]) {
  test(`rejects ${field} in an OpenRouter plugin context`, async () => {
    await expectUnsupportedModelSelection({
      model: "z-ai/glm-5.2",
      messages: [],
      plugins: [{ id: "web", [field]: null }],
    })
  })

  test(`rejects parameters.${field} in an OpenRouter plugin context`, async () => {
    await expectUnsupportedModelSelection({
      model: "z-ai/glm-5.2",
      messages: [],
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
      messages: [],
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
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [], tools }),
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
    body: JSON.stringify({ model: listedModel.id, messages: [] }),
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
    body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [] }),
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

const freeConfig = readFreeInferenceConfig({ INFERENCE_FREE_ENABLED: "true" })
const lunaBody = { model: INFERENCE_FREE_MODEL_ID, messages: [{ role: "user", content: "Hello" }] }
function freeChat(app: Hono, body: Record<string, unknown> = lunaBody) {
  return app.fetch(inferenceRequest({ method: "POST", headers: authHeaders("application/json"), body: JSON.stringify(body) }))
}

test("ordinary free Luna reserves before forwarding and never uses paid credentials or buckets", async () => {
  let reserved = false
  const { app, calls } = createTestServer({
    accessMode: "free",
    reserveFreeInference: async (input) => {
      assert.ok(input.requestId.startsWith("free_"))
      assert.equal(input.keyId, "inference_key_123")
      assert.equal(input.config.modelID, INFERENCE_FREE_MODEL_ID)
      reserved = true
      return { ok: true, maxOutputTokens: 17, access: freeInferenceAccess({ config: freeConfig, mode: "free" }) }
    },
    fetch: async (input, init) => {
      assert.equal(reserved, true)
      assert.equal(requestUrl(input), "https://openrouter.ai/api/v1/chat/completions")
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer free-provider-key")
      assert.equal(init?.redirect, "error")
      const body = parseJsonObject(requireBodyText(readInitBody(init?.body)))
      assert.equal(body.model, INFERENCE_FREE_MODEL_ID)
      assert.equal(body.max_tokens, 17)
      assert.equal(body.max_completion_tokens, undefined)
      assert.ok(isRecord(body.trace))
      assert.match(String(body.trace.trace_id), /^[a-f0-9]{32}$/)
      assert.match(String(body.trace.openwork_request_id), /^free_[a-f0-9]{32}$/)
      assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0.5, completion: 1.8, request: 0 } })
      assert.deepEqual(body.transforms, [])
      return Response.json({ ok: true }, { headers: { "x-api-key": "must-not-leak" } })
    },
  })
  const response = await freeChat(app, { ...lunaBody, max_completion_tokens: 4000, reasoning: { effort: "high" } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("x-api-key"), null)
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
})

test("free discovery can show upsell models but paid model execution is a non-retryable upgrade error", async () => {
  const { app, upstreamRequests, calls } = createTestServer({ accessMode: "free" })
  assert.equal((await app.fetch(inferenceRequest({ method: "GET", path: "/api/v1/models", headers: authHeaders() }))).status, 200)
  const response = await freeChat(app, { ...lunaBody, model: "z-ai/glm-5.2" })
  assert.equal(response.status, 402)
  assert.equal(await readErrorCode(response), "managed_model_requires_upgrade")
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(upstreamRequests.length, 0)
})

test("reservation exhaustion returns reset and sanitized state without retry-after or upstream calls", async () => {
  const now = new Date("2026-09-08T12:00:00Z")
  const window = freeInferenceWindow(now)
  const access = freeInferenceAccess({ config: freeConfig, mode: "free", now, bucket: { window_start_at: window.start, window_end_at: window.end, limit_amount: 100_000_000, used_amount: 100_000_000, reserved_amount: 0, blocked: false } })
  const { app, upstreamRequests } = createTestServer({ accessMode: "free", reserveFreeInference: async () => ({ ok: false, access }) })
  const response = await freeChat(app)
  assert.equal(response.status, 402)
  assert.equal(response.headers.get("retry-after"), null)
  const body = parseJsonObject(await response.text())
  assert.ok(isRecord(body.error))
  assert.equal(body.error.code, "free_allowance_exhausted")
  assert.equal(body.error.resetsAt, "2026-09-14T00:00:00.000Z")
  assert.deepEqual(body.error.access, access)
  assert.equal(upstreamRequests.length, 0)
})

test("paid exhaustion never falls through to the free allowance", async () => {
  const { app, upstreamRequests } = createTestServer({ usageLimited: true, reserveFreeInference: async () => { throw new Error("must not reserve free usage") } })
  const response = await freeChat(app)
  assert.equal(response.status, 429)
  assert.equal(await readErrorCode(response), "rate_limit_exceeded")
  assert.equal(upstreamRequests.length, 0)
})

for (const options of [
  { accessMode: "admin_disabled" }, { accessMode: "not_eligible" },
  { accessMode: "free", missingUser: true },
  { accessMode: "free", freeConfig: readFreeInferenceConfig({}) },
] satisfies TestServerOptions[]) {
  test(`free eligibility fails closed: ${JSON.stringify(options)}`, async () => {
    const { app, upstreamRequests } = createTestServer(options)
    assert.equal((await freeChat(app)).status, 403)
    assert.equal(upstreamRequests.length, 0)
  })
}

test("uncertain accounting sends nothing upstream; provider failures retain the committed hold", async () => {
  const unavailable = createTestServer({ accessMode: "free", reserveFreeInference: async () => { throw new Error("uncertain database commit") } })
  assert.equal((await freeChat(unavailable.app)).status, 503)
  assert.equal(unavailable.upstreamRequests.length, 0)
  let reservations = 0
  const failure = createTestServer({
    accessMode: "free",
    reserveFreeInference: async () => {
      reservations++
      return { ok: true, maxOutputTokens: 1, access: freeInferenceAccess({ config: freeConfig, mode: "free" }) }
    },
    fetch: async () => new Response("provider-secret-error", { status: 500 }),
  })
  const response = await freeChat(failure.app)
  assert.equal(response.status, 502)
  const text = await response.text()
  assert.ok(text.includes("reservation remains held"))
  assert.ok(!text.includes("provider-secret-error"))
  assert.equal(reservations, 1)
})

test("the display hold fits remaining money but one unit left still admits the full capped reply", () => {
  const prepared = prepareFreeRequest({ ...lunaBody, max_tokens: 16384, reasoning: { effort: "max" } })
  assert.ok(prepared.ok)
  const pricing = prepared.pricing
  assert.equal(pricing.maxOutputTokens, FREE_MAX_OUTPUT_TOKENS)
  assert.equal(pricing.inputTokenPrice, 50)
  assert.equal(pricing.outputTokenPrice, 180)
  assert.deepEqual(freeRequestReservation(pricing, 1), { amount: 1, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS })
  assert.deepEqual(freeRequestReservation(pricing, 100), { amount: 100, maxOutputTokens: FREE_MAX_OUTPUT_TOKENS })
  assert.equal(freeRequestReservation(pricing, 0), null)
  assert.equal(freeRequestReservation({ ...pricing, inputTokenEstimate: NaN }, 100_000_000), null)
  assert.equal(freeRequestReservation({ ...pricing, inputTokenEstimate: 0 }, 100_000_000), null)
  assert.equal(freeRequestReservation({ ...pricing, outputTokenPrice: -1 }, 100_000_000), null)
  const short = prepareFreeRequest({ ...lunaBody, max_completion_tokens: 17 })
  assert.ok(short.ok)
  assert.equal(short.pricing.maxOutputTokens, 17)
})

for (const unsupported of [
  { n: 2 }, { plugins: [{ id: "web" }] }, { models: [INFERENCE_FREE_MODEL_ID] },
  { provider: { max_price: { prompt: 999 } } }, { service_tier: "priority" },
  { tools: [{ type: "openrouter:image_generation" }] }, { prediction: { content: "x" } },
  { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://image.invalid/test.png" } }] }] },
  { max_tokens: 0 }, { reasoning: { max_tokens: 999_999 } }, { unknown_future_feature: true },
  { reasoning: { mode: "pro" } },
  { messages: [{ role: "assistant", content: "", reasoning_details: [{ type: "unknown", data: "opaque" }] }] },
]) {
  test(`free requests reject unbounded or per-call features: ${JSON.stringify(unsupported)}`, () => {
    const result = prepareFreeRequest({ ...lunaBody, ...unsupported })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "unsupported_free_inference_input")
  })
}

test("shared config and metadata separate explicit opt-out, paid precedence and free eligibility", () => {
  assert.ok(INFERENCE_ACCESS_REASONS.includes("free_request_in_progress"))
  assert.equal(new Set<string>(INFERENCE_ACCESS_REASONS).has("insufficient_request_budget"), false)
  assert.equal(readFreeInferenceConfig({}).weeklyBudgetUsd, 1)
  assert.equal(readFreeInferenceConfig({ INFERENCE_FREE_WEEKLY_BUDGET_USD: "0" }).weeklyLimitAmount, 0)
  for (const budget of ["-1", "NaN", "Infinity", "", "1e20"]) assert.throws(() => readFreeInferenceConfig({ INFERENCE_FREE_WEEKLY_BUDGET_USD: budget }))
  assert.throws(() => readFreeInferenceConfig({ INFERENCE_FREE_ENABLED: "yes" }))
  assert.throws(() => readFreeInferenceConfig({ INFERENCE_FREE_MODEL_ID: "openai/gpt-5.6-luna-pro" }))
  assert.equal(inferenceAccessMode(null), "not_eligible")
  assert.equal(inferenceAccessMode({ inferenceFree: { offerAllowed: true } }), "free")
  assert.equal(inferenceAccessMode({ inferenceFree: { offerAllowed: false } }), "admin_disabled")
  assert.equal(inferenceAccessMode({ inference: { enabled: false }, inferenceFree: { offerAllowed: true } }), "admin_disabled")
  assert.equal(inferenceAccessMode({ inference: { enabled: true, tier: "tier1" }, inferenceFree: { offerAllowed: true } }), "paid")
})

test("weekly status is Monday UTC with no rollover and never reuses a previous window's balance", () => {
  const sunday = new Date("2026-09-13T23:59:59.999Z")
  const monday = new Date("2026-09-14T00:00:00.000Z")
  const oldWindow = freeInferenceWindow(sunday)
  assert.equal(oldWindow.start.toISOString(), "2026-09-07T00:00:00.000Z")
  assert.equal(oldWindow.end.getTime(), monday.getTime())
  assert.equal(freeInferenceWindow(monday).start.getTime(), monday.getTime())
  const bucket = { window_start_at: oldWindow.start, window_end_at: oldWindow.end, limit_amount: 100_000_000, used_amount: 100_500_000, reserved_amount: 0, blocked: false }
  assert.equal(freeInferenceAccess({ config: freeConfig, mode: "free", bucket, now: sunday }).kind, "exhausted")
  assert.equal(freeInferenceAccess({ config: freeConfig, mode: "free", bucket, now: monday }).reason, "accounting_unavailable")
  const newWeek = freeInferenceAccess({ config: freeConfig, mode: "free", bucket: null, now: monday })
  assert.equal(newWeek.remainingUsd, 1)
  assert.equal(newWeek.usedUsd, 0)
  assert.equal(newWeek.reservedUsd, 0)
})

test("invalid and blocked accounting never exposes spendable free balance", () => {
  const now = new Date("2026-09-08T12:00:00Z")
  const window = freeInferenceWindow(now)
  const bucket = { window_start_at: window.start, window_end_at: window.end, limit_amount: 100_000_000, used_amount: 10, reserved_amount: 10, blocked: false }
  for (const invalid of [{ used_amount: -1 }, { used_amount: NaN }, { reserved_amount: -1 }, { blocked: true }]) {
    const access = freeInferenceAccess({ config: freeConfig, mode: "free", bucket: { ...bucket, ...invalid }, now })
    assert.equal(access.kind, "unavailable")
    assert.equal(access.reason, "accounting_unavailable")
  }
})

test("cancelling a free stream cannot release its reservation", async () => {
  let held = 0
  let cancelled = false
  const { app } = createTestServer({
    accessMode: "free",
    reserveFreeInference: async () => { held++; return { ok: true, maxOutputTokens: 1, access: freeInferenceAccess({ config: freeConfig, mode: "free" }) } },
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { "content-type": "text/event-stream" } }),
  })
  const response = await freeChat(app, { ...lunaBody, stream: true })
  assert.equal(response.status, 200)
  await response.body?.cancel()
  assert.equal(cancelled, true)
  assert.equal(held, 1)
})

test("a final admitted reply can exceed the weekly limit and subsequent retries are exhausted without upstream calls", async () => {
  const now = new Date()
  const window = freeInferenceWindow(now)
  const bucket = { window_start_at: window.start, window_end_at: window.end, limit_amount: 100_000_000, used_amount: 99_999_999, reserved_amount: 0, blocked: false }
  let upstreamCalls = 0
  let settlements = 0
  const access = () => freeInferenceAccess({ config: freeConfig, mode: "free", bucket, now })
  const { app, calls } = createTestServer({
    accessMode: "free",
    reserveFreeInference: async ({ pricing }) => {
      const state = access()
      if (state.kind !== "free" || state.reason === "free_request_in_progress") return { ok: false, access: state }
      const reservation = freeRequestReservation(pricing, bucket.limit_amount - bucket.used_amount)
      assert.ok(reservation)
      assert.equal(reservation.amount, 1)
      bucket.reserved_amount = reservation.amount
      return { ok: true, maxOutputTokens: reservation.maxOutputTokens, access: access() }
    },
    fetch: async (_input, init) => {
      upstreamCalls++
      const body = parseJsonObject(requireBodyText(readInitBody(init?.body)))
      assert.equal(body.max_tokens, FREE_MAX_OUTPUT_TOKENS)
      assert.equal(body.n, 1)
      return Response.json({ id: "gen_last", model: INFERENCE_FREE_MODEL_ID, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Reply" } }], usage: { cost: 0.008 } })
    },
    settleFreeInference: async (receipt) => {
      assert.ok("costUsd" in receipt)
      assert.equal(receipt.costUsd, 0.008)
      assert.equal(receipt.eventId, "gen_last")
      settlements++
      bucket.used_amount += Math.ceil(receipt.costUsd * 100_000_000)
      bucket.reserved_amount = 0
      return true
    },
  })
  const response = await freeChat(app)
  assert.equal(response.status, 200)
  await response.json()
  assert.equal(settlements, 1)
  assert.equal(access().kind, "exhausted")
  assert.equal(access().reason, "free_allowance_exhausted")
  assert.equal(access().remainingUsd, 0)
  assert.ok(bucket.used_amount > bucket.limit_amount)
  for (let retry = 0; retry < 2; retry++) {
    const denied = await freeChat(app)
    assert.equal(denied.status, 402)
    assert.equal(await readErrorCode(denied), "free_allowance_exhausted")
  }
  assert.equal(upstreamCalls, 1)
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
})

test("unknown model selectors and unpriced attachments produce input errors rather than an upsell", async () => {
  const { app, upstreamRequests } = createTestServer({ accessMode: "free" })
  for (const body of [{ ...lunaBody, model: "unknown/unpriced" }, { ...lunaBody, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://image.invalid/test" } }] }] }]) {
    const response = await freeChat(app, body)
    assert.equal(response.status, 400)
    assert.equal(await readErrorCode(response), "unsupported_free_inference_input")
  }
  assert.equal(upstreamRequests.length, 0)
})

test("OpenCode OpenRouter wire shapes, parameterless functions and null/empty tools pass input validation unchanged", () => {
  const body = {
    model: INFERENCE_FREE_MODEL_ID,
    max_tokens: 16384,
    messages: [
      { role: "system", content: [{ type: "text", text: "Use the supplied tools." }] },
      { role: "user", content: "Check status." },
      { role: "assistant", content: "", tool_calls: [{ id: "call_status", type: "function", function: { name: "status", arguments: "{}" } }], reasoning_details: [] },
      { role: "tool", name: "status", tool_call_id: "call_status", content: "ready" },
    ],
    tools: [{ type: "function", function: { name: "status" } }],
    tool_choice: "auto",
    usage: { include: true },
    reasoningEffort: "medium",
    textVerbosity: "low",
    reasoning: { effort: "high" },
    stream: true,
    stream_options: { include_usage: true },
  }
  const original = JSON.stringify(body)
  assert.equal(inspectFreeRequest(body).ok, true)
  assert.equal(JSON.stringify(body), original)
  for (const tools of [null, [], [{ type: "function", function: { name: "status", parameters: {} } }]]) {
    assert.equal(inspectFreeRequest({ ...body, tools }).ok, true)
  }
  assert.equal(inspectFreeRequest({ ...lunaBody, messages: [{ role: "assistant", content: null, tool_calls: null }], temperature: null, top_p: null, stop: null }).ok, true)
  assert.equal(prepareFreeRequest({ ...body, messages: [{ role: "assistant", content: "", reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", id: "rs_test", format: "openai-responses-v1" }] }] }).ok, true)
})

test("UTF-8 byte measurement includes Unicode, system and tool/schema structure, never a characters/4 heuristic", () => {
  for (const content of ["ascii", "\u00e9", "\u304a\u8a95\u751f\u65e5", "\u{1f680}", "e\u0301", "\ud800", "\u0000"]) {
    const body = { ...lunaBody, messages: [{ role: "system", content: "System rules" }, { role: "user", content }], tools: [{ type: "function", function: { name: "status", description: content, parameters: { type: "object", properties: { detail: { type: "string", description: content } } } } }], response_format: { type: "json_schema", json_schema: { name: "status", schema: { type: "object", properties: { result: { type: "string" } } } } } }
    const inspected = inspectFreeRequest(body)
    assert.ok(inspected.ok)
    assert.equal(inspected.inputContentBytes, Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools, response_format: body.response_format }), "utf8"))
    assert.ok(inspected.inputContentBytes > Buffer.byteLength(content, "utf8"))
    // Bytes only bound supplied content, never a complete upstream prompt.
    const preparation = prepareFreeRequest(body)
    assert.ok(preparation.ok)
    assert.ok(preparation.pricing.inputTokenEstimate > inspected.inputContentBytes)
    assert.equal(preparation.pricing.maxOutputTokens, FREE_MAX_OUTPUT_TOKENS)
  }
})

test("free input rejects oversized content and schema overhead instead of silently trimming", async () => {
  const overhead = Buffer.byteLength(JSON.stringify({ messages: [{ role: "user", content: "" }] }), "utf8")
  const fitting = { ...lunaBody, messages: [{ role: "user", content: "x".repeat(FREE_INPUT_CONTENT_MAX_BYTES - overhead) }] }
  const before = JSON.stringify(fitting)
  const fit = inspectFreeRequest(fitting)
  assert.ok(fit.ok)
  assert.equal(fit.inputContentBytes, FREE_INPUT_CONTENT_MAX_BYTES)
  const tooLarge = { ...fitting, tools: [{ type: "function", function: { name: "status" } }] }
  const inspected = inspectFreeRequest(tooLarge)
  assert.equal(inspected.ok, false)
  if (!inspected.ok) assert.equal(inspected.code, "free_inference_input_too_large")
  assert.equal(JSON.stringify(fitting), before)
  const { app, upstreamRequests } = createTestServer({ accessMode: "free" })
  const response = await freeChat(app, tooLarge)
  assert.equal(response.status, 413)
  assert.equal(await readErrorCode(response), "free_inference_input_too_large")
  assert.equal(upstreamRequests.length, 0)
})

test("raw request limits count actual UTF-8 bytes regardless of content-length, including fragmented Unicode", async () => {
  const text = JSON.stringify({ ...lunaBody, messages: [{ role: "user", content: "\u{1f680}\u00e9" }] })
  const bytes = new TextEncoder().encode(text)
  const request = new Request("https://inference.invalid", { method: "POST", body: new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }), duplex: "half" })
  assert.deepEqual(await readFreeRequest(request), { ok: true, value: JSON.parse(text), bodyHash: createHash("sha256").update(text).digest("hex") })
  const tooLarge = new Request("https://inference.invalid", { method: "POST", headers: { "content-length": "1" }, body: " ".repeat(FREE_REQUEST_MAX_BYTES + 1) })
  const result = await readFreeRequest(tooLarge)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, "free_inference_request_too_large")
  const invalid = await readFreeRequest(new Request("https://inference.invalid", { method: "POST", body: new Uint8Array([0xff]) }))
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.code, "invalid_json")
})

test("an estimated hold preserves entitlement and actual remaining money, and concurrent requests require manual retry", async () => {
  const now = new Date()
  const window = freeInferenceWindow(now)
  const bucket = { window_start_at: window.start, window_end_at: window.end, limit_amount: 100_000_000, used_amount: 0, reserved_amount: 100_000_000, blocked: false }
  const access = freeInferenceAccess({ config: freeConfig, mode: "free", bucket, now })
  assert.equal(access.kind, "free")
  assert.equal(access.reason, "free_request_in_progress")
  assert.equal(access.remainingUsd, 1)
  assert.equal(access.usedUsd, 0)
  const { app, upstreamRequests, calls } = createTestServer({ accessMode: "free", reserveFreeInference: async () => ({ ok: false, access }) })
  for (let retry = 0; retry < 2; retry++) {
    const response = await freeChat(app)
    assert.equal(response.status, 423)
    assert.equal(response.headers.get("retry-after"), null)
    const payload = parseJsonObject(await response.text())
    assert.ok(isRecord(payload.error))
    assert.equal(payload.error.code, "free_request_in_progress")
    assert.equal(payload.error.retryable, false)
    assert.ok(String(payload.error.message).includes("retry manually"))
    assert.ok(String(payload.error.message).includes("not a request to upgrade"))
  }
  assert.equal(upstreamRequests.length, 0)
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.getOpenRouterProviderKey, 0)
})

const responseIdentity = { requestId: "free_response", inferenceKeyId: "key", orgMembershipId: "member", requestModel: INFERENCE_FREE_MODEL_ID }
const terminalFrame = { id: "gen_response", model: INFERENCE_FREE_MODEL_ID, choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] }
const usageFrame = { id: "gen_response", model: INFERENCE_FREE_MODEL_ID, choices: [], usage: { cost: 0.0042 } }

test("fragmented free SSE settles final actual cost exactly once before DONE, preserving original bytes", async () => {
  const text = `data: ${JSON.stringify({ id: "gen_response", model: INFERENCE_FREE_MODEL_ID, choices: [{ index: 0, delta: { content: "\u{1f680}" }, finish_reason: null }] })}\r\n\r\ndata: ${JSON.stringify(terminalFrame)}\r\n\r\ndata: ${JSON.stringify(usageFrame)}\r\n\r\ndata: ${JSON.stringify(usageFrame)}\r\n\r\ndata: [DONE]\r\n\r\n`
  const receipts: FreeSettlement[] = []
  const bytes = new TextEncoder().encode(text)
  const stream = meterFreeResponse(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }), {
    streaming: true,
    identity: responseIdentity,
    settle: async (receipt) => { receipts.push(receipt); return true },
  })
  assert.ok(stream)
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let received = ""
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    received += decoder.decode(result.value, { stream: true })
    if (received.endsWith("[DONE]\r\n\r\n")) assert.equal(receipts.length, 1)
  }
  received += decoder.decode()
  assert.equal(received, text)
  assert.deepEqual(receipts, [{ ...responseIdentity, responseModel: INFERENCE_FREE_MODEL_ID, currency: "USD", eventId: "gen_response", costUsd: 0.0042 }])
})

test("free JSON settlement requires a terminal matching model and actual cost, never a token-based estimate", async () => {
  for (const usage of [{ cost: 0 }, { prompt_tokens: 12, completion_tokens: 3 }]) {
    const receipts: FreeSettlement[] = []
    const text = JSON.stringify({ ...terminalFrame, usage })
    const stream = meterFreeResponse(new Response(text).body, { streaming: false, identity: responseIdentity, settle: async (receipt) => { receipts.push(receipt); return true } })
    assert.equal(await new Response(stream).text(), text)
    assert.equal(receipts.length, "cost" in usage ? 1 : 0)
  }
})

for (const text of [
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: ${JSON.stringify(usageFrame)}\n\n`,
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: [DONE]\n\n`,
  `data: ${JSON.stringify(usageFrame)}\n\ndata: [DONE]\n\n`,
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: ${JSON.stringify({ ...usageFrame, model: "other/model" })}\n\ndata: [DONE]\n\n`,
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: ${JSON.stringify({ ...usageFrame, id: "other_generation" })}\n\ndata: [DONE]\n\n`,
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: ${JSON.stringify({ ...usageFrame, usage: { cost: -1 } })}\n\ndata: [DONE]\n\n`,
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: ${JSON.stringify(usageFrame)}\n\ndata: {"error":{"message":"incomplete"}}\n\ndata: [DONE]\n\n`,
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: not-json\n\ndata: [DONE]\n\n`,
  `data: ${JSON.stringify(terminalFrame)}\n\ndata: ${JSON.stringify(usageFrame)}\n\nevent: error\ndata: {"message":"incomplete"}\n\ndata: [DONE]\n\n`,
]) {
  test(`missing or invalid final free accounting retains the hold (${text.length} bytes, ${text.slice(-24)})`, async () => {
    let settlements = 0
    const stream = meterFreeResponse(new Response(text).body, { streaming: true, identity: responseIdentity, settle: async () => { settlements++; return true } })
    assert.equal(await new Response(stream).text(), text)
    assert.equal(settlements, 0)
  })
}

test("cancelled free accounting and unavailable settlement retain holds without corrupting replies", async () => {
  let settlements = 0
  const cancelled = meterFreeResponse(new ReadableStream(), { streaming: true, identity: responseIdentity, settle: async () => { settlements++; return true } })
  await cancelled?.cancel()
  assert.equal(settlements, 0)
  const text = `data: ${JSON.stringify(terminalFrame)}\n\ndata: ${JSON.stringify(usageFrame)}\n\ndata: [DONE]\n\n`
  const failed = meterFreeResponse(new Response(text).body, { streaming: true, identity: responseIdentity, settle: async () => { settlements++; throw new Error("store unavailable") } })
  assert.equal(await new Response(failed).text(), text)
  assert.equal(settlements, 1)
})
