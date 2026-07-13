import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"

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

function createTestServer() {
  const app = new Hono()
  const upstreamRequests: UpstreamRequest[] = []
  const calls: DependencyCalls = {
    findActiveInferenceKey: 0,
    getOpenRouterProviderKey: 0,
    ensureUsableBuckets: 0,
  }
  const upstreamFetch: typeof fetch = async (input, init) => {
    upstreamRequests.push({
      url: requestUrl(input),
      method: init?.method,
      body: readInitBody(init?.body),
      headers: new Headers(init?.headers),
    })
    return Response.json({ ok: true })
  }

  registerProxyRoutes(app, {
    async findActiveInferenceKey(_rawKey: string) {
      calls.findActiveInferenceKey += 1
      return {
        id: "inference_key_123",
        organization_id: "organization_123",
        org_membership_id: "member_123",
      }
    },
    async getOpenRouterProviderKey(_organizationId: string) {
      calls.getOpenRouterProviderKey += 1
      return {
        encrypted_api_key: "provider-key",
      }
    },
    async ensureUsableBuckets(_organizationId: string) {
      calls.ensureUsableBuckets += 1
      return {
        ok: true,
        bucketIds: {},
        bucketLimits: {},
      }
    },
    fetch: upstreamFetch,
  })

  return { app, upstreamRequests, calls }
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
  const { app, upstreamRequests, calls } = createTestServer()
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
})

test("returns model_not_found for unknown JSON model aliases", async () => {
  const { app, upstreamRequests, calls } = createTestServer()
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
