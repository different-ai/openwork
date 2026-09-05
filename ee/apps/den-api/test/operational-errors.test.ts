import { expect, test } from "bun:test"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { normalizeOperationalErrorResponse, operationalErrorResponse } from "../src/operational-errors.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function operationalErrorApp(path: string, error: Error, requestId: string) {
  const app = new Hono()
  app.onError((safeError, c) => operationalErrorResponse(safeError, c, requestId))
  app.get(path, () => {
    throw error
  })
  return app
}

test("thrown MCP HTTPException preserves its response and gains a support reference", async () => {
  const error = new HTTPException(404, {
    res: new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000, message: "Unsupported protocol version" },
    }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  })
  const response = await operationalErrorApp("/mcp/agent", error, "req_mcp_404").request("/mcp/agent")

  expect(response.status).toBe(404)
  const body: unknown = await response.json()
  expect(body).toMatchObject({
    jsonrpc: "2.0",
    id: 7,
    error: {
      code: -32000,
      message: "Unsupported protocol version",
      data: { referenceId: "req_mcp_404" },
    },
  })
})

test("thrown plain MCP errors remain sanitized 500 responses", async () => {
  const response = await operationalErrorApp(
    "/mcp/agent",
    new Error("provider secret must not escape"),
    "req_mcp_500",
  ).request("/mcp/agent")

  expect(response.status).toBe(500)
  const body: unknown = await response.json()
  expect(body).toEqual({
    error: "internal_server_error",
    message: "An unexpected server error occurred.",
    referenceId: "req_mcp_500",
  })
  expect(JSON.stringify(body)).not.toContain("provider secret")
})

test("thrown OAuth HTTPException preserves status, fields, headers, and gains a support reference", async () => {
  const error = new HTTPException(401, {
    res: new Response(JSON.stringify({
      error: "invalid_client",
      error_description: "Client authentication failed.",
    }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Basic realm=oauth",
      },
    }),
  })
  const response = await operationalErrorApp(
    "/api/auth/oauth2/token",
    error,
    "req_oauth_401",
  ).request("/api/auth/oauth2/token")

  expect(response.status).toBe(401)
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(response.headers.get("Pragma")).toBe("no-cache")
  expect(response.headers.get("www-authenticate")).toBe("Basic realm=oauth")
  const body: unknown = await response.json()
  expect(body).toEqual({
    error: "invalid_client",
    error_description: "Client authentication failed.",
    reference_id: "req_oauth_401",
  })
})

test("OAuth token errors include cache headers and a support reference", async () => {
  const response = await normalizeOperationalErrorResponse(
    "/api/auth/oauth2/token",
    new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
    "req_oauth_token",
  )

  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(response.headers.get("Pragma")).toBe("no-cache")
  expect(response.headers.get("X-Request-Id")).toBeNull()
  const body: unknown = await response.json()
  expect(isRecord(body) && body.reference_id).toBe("req_oauth_token")
})

test("OAuth 429 errors expose standard Retry-After", async () => {
  const response = await normalizeOperationalErrorResponse(
    "/api/auth/oauth2/authorize",
    new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "x-retry-after": "17" },
    }),
    "req_rate_limit",
  )

  expect(response.headers.get("Retry-After")).toBe("17")
  const body: unknown = await response.json()
  expect(isRecord(body) && body.reference_id).toBe("req_rate_limit")
})

test("OAuth text/plain JSON 429 errors are parsed and normalized", async () => {
  const response = await normalizeOperationalErrorResponse(
    "/api/auth/oauth2/authorize",
    new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
      status: 429,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-retry-after": "23" },
    }),
    "req_text_plain_rate_limit",
  )

  expect(response.headers.get("content-type")).toBe("application/json")
  expect(response.headers.get("Cache-Control")).toBe("no-store")
  expect(response.headers.get("Pragma")).toBe("no-cache")
  expect(response.headers.get("Retry-After")).toBe("23")
  expect(response.headers.get("X-Request-Id")).toBeNull()

  const body: unknown = await response.json()
  expect(body).toMatchObject({
    error: "request_failed",
    error_description: "Too many requests. Please try again later.",
    reference_id: "req_text_plain_rate_limit",
  })
})

test("MCP JSON-RPC errors carry reference IDs under error data", async () => {
  const response = await normalizeOperationalErrorResponse(
    "/mcp/agent",
    new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Tool failed" },
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
    "req_mcp_rpc",
  )

  const body: unknown = await response.json()
  expect(isRecord(body)).toBe(true)
  if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.data)) {
    throw new Error("Normalized MCP error did not include JSON-RPC error data")
  }
  expect(body.error.data.referenceId).toBe("req_mcp_rpc")
})

test("streaming non-JSON MCP errors keep their body and content type", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: retry\n\n"))
      controller.close()
    },
  })

  const response = await normalizeOperationalErrorResponse(
    "/mcp/agent",
    new Response(stream, {
      status: 500,
      headers: { "content-type": "text/event-stream" },
    }),
    "req_mcp_stream",
  )

  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(response.headers.get("X-Request-Id")).toBeNull()
  await expect(response.text()).resolves.toBe("data: retry\n\n")
})

test("streaming non-JSON MCP errors are not parsed as JSON", async () => {
  const pendingStream = new ReadableStream<Uint8Array>()
  const result = await Promise.race([
    normalizeOperationalErrorResponse(
      "/mcp/agent",
      new Response(pendingStream, {
        status: 500,
        headers: { "content-type": "text/event-stream" },
      }),
      "req_mcp_pending_stream",
    ),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ])

  expect(result).toBeInstanceOf(Response)
  if (result instanceof Response) {
    expect(result.headers.get("content-type")).toBe("text/event-stream")
    expect(result.headers.get("X-Request-Id")).toBeNull()
  }
})

test("streaming JSON-seq MCP errors are not buffered as finite JSON", async () => {
  const pendingStream = new ReadableStream<Uint8Array>()
  const result = await Promise.race([
    normalizeOperationalErrorResponse(
      "/mcp/agent",
      new Response(pendingStream, {
        status: 500,
        headers: { "content-type": "application/json-seq" },
      }),
      "req_mcp_json_seq",
    ),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ])

  expect(result).toBeInstanceOf(Response)
  if (result instanceof Response) {
    expect(result.headers.get("content-type")).toBe("application/json-seq")
    expect(result.headers.get("X-Request-Id")).toBeNull()
  }
})

test("streaming stream+json MCP errors are not buffered as finite JSON", async () => {
  const pendingStream = new ReadableStream<Uint8Array>()
  const result = await Promise.race([
    normalizeOperationalErrorResponse(
      "/mcp/agent",
      new Response(pendingStream, {
        status: 500,
        headers: { "content-type": "application/stream+json" },
      }),
      "req_mcp_stream_json",
    ),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ])

  expect(result).toBeInstanceOf(Response)
  if (result instanceof Response) {
    expect(result.headers.get("content-type")).toBe("application/stream+json")
    expect(result.headers.get("X-Request-Id")).toBeNull()
  }
})

test("operational route error logging omits provider-controlled exception text", async () => {
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }

  const app = new Hono()
  app.post("/register", () => {
    const error = new Error("state=state-value code=code-value client_secret=secret-value token=token-value")
    error.name = "state=name-state code=name-code client_secret=name-secret token=name-token"
    throw error
  })
  app.onError((error, c) => operationalErrorResponse(error, c, "req_safe_log"))

  try {
    const response = await app.request("/register", { method: "POST" })
    expect(response.status).toBe(500)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Pragma")).toBe("no-cache")
    expect(response.headers.get("X-Request-Id")).toBeNull()
    const body: unknown = await response.json()
    expect(body).toMatchObject({
      error: "server_error",
      error_description: "An unexpected server error occurred.",
      reference_id: "req_safe_log",
    })
  } finally {
    console.error = originalError
  }

  const loggedText = errors
    .flat()
    .map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry))
    .join(" ")
  expect(loggedText).toContain("req_safe_log")
  expect(loggedText).not.toContain("state=")
  expect(loggedText).not.toContain("code=")
  expect(loggedText).not.toContain("state-value")
  expect(loggedText).not.toContain("code-value")
  expect(loggedText).not.toContain("secret-value")
  expect(loggedText).not.toContain("name-secret")
  expect(loggedText).not.toContain("token=")
  expect(loggedText).not.toContain("token-value")
  expect(loggedText).not.toContain("name-token")
  expect(loggedText).not.toContain("client_secret")
})
