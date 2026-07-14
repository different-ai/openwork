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
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search_incidents", arguments: { query: "INC0001" } },
    }),
  })

  const inspection = inspector.snapshot()
  expect(inspection).toMatchObject({
    request: {
      method: "POST",
      url: "https://mcp.example.test/rpc?tenant=%5Bredacted%5D",
      headers: expect.arrayContaining([
        { name: "authorization", value: "Bearer [redacted]", redacted: true },
        { name: "cookie", value: "[redacted]", redacted: true },
        { name: "mcp-protocol-version", value: "2025-11-25", redacted: false },
      ]),
      body: { truncated: false },
    },
    response: {
      status: 200,
      headers: expect.arrayContaining([
        { name: "mcp-session-id", value: "[redacted]", redacted: true },
        { name: "x-request-id", value: "provider-request-123", redacted: false },
      ]),
      body: { truncated: false },
    },
  })
  const serialized = JSON.stringify(inspection)
  expect(serialized).not.toContain("access-token-secret")
  expect(serialized).not.toContain("browser-secret")
  expect(serialized).not.toContain("provider-session-secret")
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

  const inspection = inspector.snapshot()
  expect(inspection.request?.body.text).toContain('"method":"tools/call"')
  expect(inspection.response).toBeUndefined()
  expect(diagnoseExternalMcpToolCall({ inspection, succeeded: false })).toEqual({
    status: "failed",
    layer: "network",
    summary: "OpenWork sent tools/call but did not receive an HTTP response from the remote MCP.",
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
