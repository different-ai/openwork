import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { requestId } from "hono/request-id"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { normalizeErrorResponse } from "../src/operational-errors.js"
import { createAppLogger } from "../src/observability/logger.js"
import { createRequestContextMiddleware, currentRequestId } from "../src/observability/request-context.js"
import { sanitizePublicResponseHeaders } from "../src/public-response-headers.js"
import { requestGatewayProviderTest } from "../src/llm/gateway-provider-test.js"

const referenceId = createDenTypeId("request")

test("provider-test failure logs join Den's reference to the gateway's own upstream id", async (t) => {
  const lines: string[] = []
  t.mock.method(process.stdout, "write", (chunk: unknown) => {
    if (typeof chunk === "string") lines.push(chunk)
    return true
  })
  const app = new Hono()
  app.use("*", requestId({ headerName: "", generator: () => referenceId }))
  app.use("*", createRequestContextMiddleware())
  app.get("/test", async (c) => c.json(await requestGatewayProviderTest({ providerId: "example", model: "example-model", settings: {}, credential: { kind: "api_key", secret: "synthetic-key" } }, {
    baseUrl: "https://gateway.example.test", key: "synthetic-gateway-key", signingSecret: "synthetic-signing-secret", organizationId: "synthetic-organization", memberId: "synthetic-member",
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("x-request-id"), null)
      return Response.json({ error: "provider_unavailable" }, { status: 503, headers: { "x-openwork-request-id": "gateway-reference" } })
    },
  })))
  const response = await app.request("/test")
  assert.equal(response.status, 200)
  assert.ok(lines.some((line) => line.includes(`"request_id":"${referenceId}"`) && line.includes('"upstream_request_id":"gateway-reference"')))
  assert.ok(!lines.join("").includes("synthetic-key"))
})

test("one normalizer preserves error fields, protocol references and safe retry headers", async () => {
  for (const path of ["/v1/example", "/mcp", "/api/auth/oauth2/token"]) {
    const response = await normalizeErrorResponse(path, Response.json({ error: "invalid_request", message: "Invalid input", details: [{ path: ["name"], message: "Required" }], referenceId: "untrusted" }, {
      status: 429,
      headers: { "x-request-id": "internal", "x-origin-host": "internal.example", "x-retry-after": "10", "content-length": "1" },
    }), referenceId)
    sanitizePublicResponseHeaders(response.headers)
    const body: unknown = await response.json()
    assert.deepEqual(body, {
      error: "invalid_request", message: "Invalid input", details: [{ path: ["name"], message: "Required" }], referenceId,
      ...(path.includes("oauth2") ? { error_description: "Invalid input", reference_id: referenceId } : {}),
    })
    assert.equal(response.headers.get("x-request-id"), null)
    assert.equal(response.headers.get("x-origin-host"), null)
    assert.equal(response.headers.get("content-length"), null)
    assert.equal(response.headers.get("retry-after"), "10")
  }
})

test("JSON-RPC references remain in error.data without discarding protocol or provider fields", async () => {
  const response = await normalizeErrorResponse("/mcp", Response.json({ jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Invalid request", data: { retryable: true } } }, { status: 400 }), referenceId)
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Invalid request", data: { retryable: true, referenceId } } })
  const generic = await normalizeErrorResponse("/v1/example", Response.json({ error: { code: "invalid" } }, { status: 400 }), referenceId)
  assert.deepEqual(await generic.json(), { error: { code: "invalid" }, referenceId })
})

test("plain HTTP errors gain a reference while successful and streaming responses remain untouched", async () => {
  const response = await normalizeErrorResponse("/v1/example", new Response("Too many requests", { status: 429 }), referenceId)
  assert.deepEqual(await response.json(), { error: "Too many requests", referenceId })
  for (const response of [Response.json({ ok: true }), new Response("data: error\n\n", { status: 500, headers: { "content-type": "text/event-stream" } })]) {
    const normalized = await normalizeErrorResponse("/mcp", response, referenceId)
    if (response.status < 400) assert.equal(normalized, response)
    assert.equal(normalized.body, response.body)
    assert.equal(response.bodyUsed, false)
  }
})

test("loggers created outside concurrent requests inherit the server id, not supplied fields", async () => {
  const lines: string[] = []
  const logger = createAppLogger({ write: (line) => lines.push(line) }).child({ component: "reference-proof" })
  const gate = Promise.withResolvers<void>()
  let arrived = 0
  const app = new Hono()
  app.use("*", requestId({ headerName: "", generator: () => createDenTypeId("request") }))
  app.use("*", createRequestContextMiddleware())
  app.get("/:name", async (c) => {
    if (++arrived === 2) gate.resolve()
    await gate.promise
    logger.info(c.req.param("name"), { request_id: "spoofed" })
    return c.json({ referenceId: currentRequestId() })
  })
  const responses = await Promise.all([app.request("/first"), app.request("/second")])
  const bodies: unknown[] = await Promise.all(responses.map((response) => response.json()))
  assert.notDeepEqual(bodies[0], bodies[1])
  for (const [index, name] of ["first", "second"].entries()) {
    const body = bodies[index]
    assert.ok(typeof body === "object" && body !== null && "referenceId" in body)
    assert.ok(lines.some((line) => line.includes(`"message":"${name}"`) && line.includes(`"request_id":"${body.referenceId}"`)))
  }
  assert.equal(currentRequestId(), undefined)
})
