import { expect, test } from "bun:test"
import { preflightMcpJsonRpcRequest } from "../src/mcp/json-rpc-preflight.js"

function jsonRequest(body: string) {
  return new Request("http://127.0.0.1:8790/mcp/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
}

async function expectJsonRpcError(response: Response, code: -32700 | -32600, message: "Parse error" | "Invalid Request", referenceId: string) {
  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(response.headers.get("X-Request-Id")).toBe(referenceId)
  await expect(response.json()).resolves.toMatchObject({
    jsonrpc: "2.0",
    id: null,
    error: {
      code,
      message,
      data: { referenceId },
    },
  })
}

test("invalid authenticated MCP JSON returns JSON-RPC parse error without consuming the original request", async () => {
  const request = jsonRequest("{")
  const response = await preflightMcpJsonRpcRequest(request, "req_parse")

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    await expectJsonRpcError(response, -32700, "Parse error", "req_parse")
  }
  await expect(request.text()).resolves.toBe("{")
})

test("structurally malformed MCP JSON-RPC returns invalid request", async () => {
  const response = await preflightMcpJsonRpcRequest(jsonRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, params: {} })), "req_invalid")

  expect(response).toBeInstanceOf(Response)
  if (response instanceof Response) {
    await expectJsonRpcError(response, -32600, "Invalid Request", "req_invalid")
  }
})

test("non-object, wrong jsonrpc, and empty method payloads are invalid requests", async () => {
  for (const body of [
    [],
    { jsonrpc: "1.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 1, method: "" },
    { jsonrpc: "2.0", id: 1, method: "   " },
  ]) {
    const response = await preflightMcpJsonRpcRequest(jsonRequest(JSON.stringify(body)), "req_invalid_shape")
    expect(response).toBeInstanceOf(Response)
    if (response instanceof Response) {
      await expectJsonRpcError(response, -32600, "Invalid Request", "req_invalid_shape")
    }
  }
})

test("valid notifications, initialize, and tools calls pass through", async () => {
  for (const body of [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]) {
    await expect(preflightMcpJsonRpcRequest(jsonRequest(JSON.stringify(body)), "req_valid")).resolves.toBeNull()
  }
})

test("non-POST and unsupported media types stay delegated to transport", async () => {
  await expect(preflightMcpJsonRpcRequest(new Request("http://127.0.0.1:8790/mcp/agent"), "req_get")).resolves.toBeNull()
  await expect(preflightMcpJsonRpcRequest(new Request("http://127.0.0.1:8790/mcp/agent", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ jsonrpc: "2.0" }),
  }), "req_text")).resolves.toBeNull()
})
