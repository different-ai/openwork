import { expect, test } from "bun:test"
import {
  diagnoseExternalMcpToolCall,
  ExternalMcpToolCallInspector,
} from "../src/capability-sources/external-mcp-tool-inspection.js"

test("captures the real tools/call exchange while redacting credentials and query values", async () => {
  const inspector = new ExternalMcpToolCallInspector()
  const observedFetch = inspector.observeFetch(async () => new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ok" }] } }),
    {
      status: 200,
      headers: {
        authorization: "opaque-response-secret",
        "content-type": "application/json",
        "mcp-session-id": "provider-session-secret",
        "x-request-id": "provider-request-123",
      },
    },
  ))

  await observedFetch("https://mcp.example.test/rpc?tenant=private-tenant", {
    method: "POST",
    headers: {
      authorization: "Bearer access-token-secret",
      "content-type": "application/json",
      cookie: "session=browser-secret",
      "mcp-protocol-version": "2025-11-25",
      "ocp-apim-subscription-key": "azure-subscription-secret",
      "x-client-credential": "client-credential-secret",
      "x-provider-token": "provider-token-secret",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search_incidents", arguments: { query: "INC0001" } },
    }),
  })

  await inspector.settle()
  const inspection = inspector.snapshot()
  expect(inspection).toMatchObject({
    request: {
      method: "POST",
      url: "https://mcp.example.test/rpc?tenant=%5Bredacted%5D",
      headers: expect.arrayContaining([
        { name: "authorization", value: "Bearer [redacted]", redacted: true },
        { name: "cookie", value: "[redacted]", redacted: true },
        { name: "mcp-protocol-version", value: "2025-11-25", redacted: false },
        { name: "ocp-apim-subscription-key", value: "[redacted]", redacted: true },
        { name: "x-client-credential", value: "[redacted]", redacted: true },
        { name: "x-provider-token", value: "[redacted]", redacted: true },
      ]),
      body: { truncated: false },
    },
    response: {
      status: 200,
      headers: expect.arrayContaining([
        { name: "authorization", value: "[redacted]", redacted: true },
        { name: "mcp-session-id", value: "[redacted]", redacted: true },
        { name: "x-request-id", value: "provider-request-123", redacted: false },
      ]),
      body: { truncated: false },
    },
  })
  const serialized = JSON.stringify(inspection)
  expect(serialized).not.toContain("access-token-secret")
  expect(serialized).not.toContain("azure-subscription-secret")
  expect(serialized).not.toContain("browser-secret")
  expect(serialized).not.toContain("client-credential-secret")
  expect(serialized).not.toContain("provider-session-secret")
  expect(serialized).not.toContain("provider-token-secret")
  expect(serialized).not.toContain("opaque-response-secret")
  expect(inspection.request?.body.text).toContain('"method":"tools/call"')
  expect(inspection.response?.body.text).toContain('"text":"ok"')
})

test("ignores lifecycle requests and classifies a tools/call with no response as a network failure", async () => {
  const inspector = new ExternalMcpToolCallInspector()
  const observedFetch = inspector.observeFetch(async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : ""
    if (body.includes('"method":"tools/call"')) throw new TypeError("fetch failed")
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))
  })

  await observedFetch("https://mcp.example.test/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  })
  expect(inspector.snapshot()).toEqual({})

  await expect(observedFetch("https://mcp.example.test/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fail", arguments: {} } }),
  })).rejects.toThrow("fetch failed")

  await inspector.settle()
  const inspection = inspector.snapshot()
  expect(inspection.request?.body.text).toContain('"method":"tools/call"')
  expect(inspection.response).toBeUndefined()
  expect(diagnoseExternalMcpToolCall({ inspection, succeeded: false })).toEqual({
    status: "failed",
    layer: "network",
    summary: "OpenWork sent tools/call but did not receive an HTTP response from the remote MCP.",
  })
})

test("returns a streamed response to the transport before the stream ends and settles a bounded capture", async () => {
  const inspector = new ExternalMcpToolCallInspector()
  const encoder = new TextEncoder()
  const sseEvent = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } })}\n\n`
  // A remote MCP that sends the tool response event but holds the SSE stream
  // open. The transport must still receive the response immediately.
  const observedFetch = inspector.observeFetch(async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent))
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ))

  const response = await observedFetch("https://mcp.example.test/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stream", arguments: {} } }),
  })
  // The transport's branch of the body is untouched and readable right away.
  const reader = response.body!.getReader()
  const firstChunk = await reader.read()
  expect(new TextDecoder().decode(firstChunk.value)).toContain('"jsonrpc"')

  await inspector.settle()
  const inspection = inspector.snapshot()
  expect(inspection.response?.status).toBe(200)
  expect(inspection.response?.body.text).toContain('"result"')
  expect(inspection.response?.body.unavailable).toBeUndefined()
  // The stream never ended, so the capture is marked incomplete.
  expect(inspection.response?.body.truncated).toBe(true)
})

test("caps the captured response body at the inspection limit without failing on multibyte content", async () => {
  const inspector = new ExternalMcpToolCallInspector()
  const oversized = "é".repeat(400 * 1024) // 800 KiB of UTF-8, above the 512 KiB cap
  const observedFetch = inspector.observeFetch(async () => new Response(oversized, {
    status: 200,
    headers: { "content-type": "application/json" },
  }))

  await observedFetch("https://mcp.example.test/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "big", arguments: {} } }),
  })
  await inspector.settle()

  const body = inspector.snapshot().response?.body
  expect(body?.truncated).toBe(true)
  expect(body?.bytes).toBeGreaterThan(512 * 1024)
  // Capture stays within the limit (plus at most one replacement character
  // for a multibyte sequence split at the boundary).
  expect(Buffer.byteLength(body?.text ?? "", "utf8")).toBeLessThanOrEqual(512 * 1024 + 3)
  expect(body?.text.startsWith("é")).toBe(true)
})

test("does not change the tool response when the body cannot be cloned for inspection", async () => {
  const inspector = new ExternalMcpToolCallInspector()
  const providerResponse = new Response("provider result", { status: 200 })
  Object.defineProperty(providerResponse, "clone", {
    value: () => {
      throw new Error("body clone unavailable")
    },
  })
  const observedFetch = inspector.observeFetch(async () => providerResponse)

  const response = await observedFetch("https://mcp.example.test/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "clone_failure", arguments: {} } }),
  })

  expect(await response.text()).toBe("provider result")
  await inspector.settle()
  expect(inspector.snapshot().response?.body).toEqual({
    text: "",
    bytes: 0,
    truncated: false,
    unavailable: true,
  })
})

test("attributes a blocked or deadline-stopped tools/call to the right layer", () => {
  expect(diagnoseExternalMcpToolCall({
    inspection: { request: { method: "POST", url: "https://mcp.example.test/rpc", startedAt: new Date().toISOString(), headers: [], body: { text: "{}", bytes: 2, truncated: false } } },
    succeeded: false,
    diagnostic: { phase: "CONFIGURATION", category: "security_blocked", code: "MCP_URL_BLOCKED" },
  })).toEqual({
    status: "failed",
    layer: "openwork",
    summary: "OpenWork's outbound network safety policy blocked this tools/call request, so it was not sent to the remote MCP.",
  })
  expect(diagnoseExternalMcpToolCall({
    inspection: { request: { method: "POST", url: "https://mcp.example.test/rpc", startedAt: new Date().toISOString(), headers: [], body: { text: "{}", bytes: 2, truncated: false } } },
    succeeded: false,
    diagnostic: { phase: "MCP_TOOL_EXECUTION", category: "lifecycle_deadline", code: "MCP_LIFECYCLE_DEADLINE" },
  })).toEqual({
    status: "failed",
    layer: "network",
    summary: "OpenWork sent tools/call but the remote MCP did not answer before OpenWork stopped waiting at its deadline.",
  })
})

test("distinguishes remote MCP setup failures from OpenWork failures before tools/call", () => {
  expect(diagnoseExternalMcpToolCall({
    inspection: {},
    succeeded: false,
    diagnostic: { phase: "MCP_INITIALIZE" },
  })).toEqual({
    status: "failed",
    layer: "mcp_connection",
    summary: "The remote MCP session, authentication, or initialization failed before tools/call could be sent.",
  })
  expect(diagnoseExternalMcpToolCall({
    inspection: {},
    succeeded: false,
    diagnostic: { phase: "NETWORK_TCP" },
  })).toEqual({
    status: "failed",
    layer: "network",
    summary: "OpenWork could not reach the remote MCP while preparing the session, so tools/call was not sent.",
  })
})
