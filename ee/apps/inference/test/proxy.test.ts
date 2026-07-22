import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import type { InferenceHandledErrorReport, InferenceReporter, InferenceRequestReport } from "../src/inference-reporting.js"

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
    async findActiveInferenceKey(_rawKey: string) {
      calls.findActiveInferenceKey += 1
      return {
        id: "inference_key_123",
        organization_id: options.organizationId ?? "organization_123",
        org_membership_id: "member_123",
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
    reporter,
  })

  return { app, upstreamRequests, calls, reports }
}

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
    body: JSON.stringify({ model: "openwork/openrouter/fusion", messages: [] }),
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
  assert.equal(body.model, "openrouter/fusion")
  assert.equal(body.user, "member_123")
  assert.equal(body.session_id, upstream.headers.get("x-openwork-request-id"))
  const trace = body.trace
  assert.ok(isRecord(trace))
  assert.equal(trace.generation_name, "openrouter/fusion")

  const report = requireRequestReport(reports)
  assert.equal(report.organizationId, "organization_123")
  assert.equal(report.inferenceKeyId, "inference_key_123")
  assert.equal(report.openworkRequestId, upstream.headers.get("x-openwork-request-id"))
  assert.equal(report.route, "/api/v1/chat/completions")
  assert.equal(report.method, "POST")
  assert.equal(report.incomingModel, "openwork/openrouter/fusion")
  assert.equal(report.resolvedUpstreamModel, "openrouter/fusion")
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
      model: "openrouter/fusion",
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
      model: "openrouter/fusion",
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
    body: JSON.stringify({ model: "openrouter/fusion", messages: [] }),
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
    body: JSON.stringify({ model: "openrouter/fusion", messages: [] }),
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
  assert.equal(errorReport.incomingModel, "openrouter/fusion")
  assert.equal(errorReport.resolvedUpstreamModel, "openrouter/fusion")
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
    body: JSON.stringify({ model: "openrouter/fusion", messages: [] }),
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
    body: JSON.stringify({ model: "openwork/openrouter/fusion", messages: [] }),
  }))

  assert.equal(response.status, 200)
  assert.equal(upstreamRequests.length, 1)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  const body = parseJsonObject(requireBodyText(upstream.body))
  assert.equal(body.model, "openrouter/fusion")
})

test("does not forward caller headers or session IDs that can affect routing", async () => {
  const { app, upstreamRequests } = createTestServer()
  const headers = authHeaders("application/json")
  headers.set("x-session-id", "caller-session")
  headers.set("x-openrouter-model", "attacker/model")
  const response = await app.fetch(inferenceRequest({
    method: "POST",
    headers,
    body: JSON.stringify({ model: "openrouter/fusion", messages: [], session_id: "caller-session" }),
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
      model: "openrouter/fusion",
      messages: [],
      [field]: value,
    })
  })
}

test("rejects the Fusion plugin", async () => {
  await expectUnsupportedModelSelection({
    model: "openrouter/fusion",
    messages: [],
    plugins: [{ id: "fusion" }],
  })
})

for (const field of ["model", "analysis_models", "allowed_models"]) {
  test(`rejects ${field} in an OpenRouter plugin context`, async () => {
    await expectUnsupportedModelSelection({
      model: "openrouter/fusion",
      messages: [],
      plugins: [{ id: "web", [field]: null }],
    })
  })

  test(`rejects parameters.${field} in an OpenRouter plugin context`, async () => {
    await expectUnsupportedModelSelection({
      model: "openrouter/fusion",
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
      model: "openrouter/fusion",
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
    body: JSON.stringify({ model: "openrouter/fusion", messages: [], tools }),
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
    body: JSON.stringify({ model: "openrouter/fusion", messages: [] }),
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
