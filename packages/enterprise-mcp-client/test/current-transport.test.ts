import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MCP_CURRENT_PROTOCOL_VERSION,
  McpCurrentTransportError,
  parseCurrentMcpResponse,
} from "../src/index.js"

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "MCP-Protocol-Version": MCP_CURRENT_PROTOCOL_VERSION,
      ...init.headers,
    },
  })
}

describe("MCP current response transport", () => {
  it("parses one bounded JSON result", async () => {
    assert.deepEqual(await parseCurrentMcpResponse({
      response: response(JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        result: { resultType: "complete", tools: [] },
      })),
      requestId: "request-1",
    }), {
      resultType: "complete",
      tools: [],
    })
  })

  it("parses SSE while selecting exactly one matching response", async () => {
    const body = [
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}`,
      "",
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { resultType: "complete" } })}`,
      "",
    ].join("\n")
    assert.deepEqual(await parseCurrentMcpResponse({
      response: response(body, { headers: { "content-type": "text/event-stream" } }),
      requestId: 7,
    }), { resultType: "complete" })
  })

  it("rejects legacy sessions, mismatched versions, malformed envelopes, and oversized bodies", async () => {
    const cases: Array<{ value: Response; code: string; maxBytes?: number }> = [
      {
        value: response("{}", { headers: { "Mcp-Session-Id": "legacy-session" } }),
        code: "MCP_CURRENT_RESPONSE_VERSION_MISMATCH",
      },
      {
        value: response("{}", { headers: { "MCP-Protocol-Version": "2025-11-25" } }),
        code: "MCP_CURRENT_RESPONSE_VERSION_MISMATCH",
      },
      {
        value: response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "bad" } })),
        code: "MCP_CURRENT_RESPONSE_INVALID",
      },
      {
        value: response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: "too large" } })),
        code: "MCP_CURRENT_RESPONSE_SIZE_LIMIT",
        maxBytes: 8,
      },
    ]
    for (const entry of cases) {
      await assert.rejects(
        parseCurrentMcpResponse({
          response: entry.value,
          requestId: 1,
          ...(entry.maxBytes ? { maxBytes: entry.maxBytes } : {}),
        }),
        (error: unknown) => error instanceof McpCurrentTransportError && error.code === entry.code,
      )
    }
  })

  it("maps provider JSON-RPC errors without retaining provider data", async () => {
    await assert.rejects(
      parseCurrentMcpResponse({
        response: response(JSON.stringify({
          jsonrpc: "2.0",
          id: "request-1",
          error: {
            code: -32022,
            message: "secret provider text",
            data: { token: "must-not-survive" },
          },
        }), { status: 400 }),
        requestId: "request-1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpCurrentTransportError)
        assert.equal(error.code, "MCP_CURRENT_RPC_ERROR")
        assert.equal(error.rpcCode, -32022)
        assert.doesNotMatch(error.message, /secret|token/)
        return true
      },
    )
  })

  it("rejects unsolicited requests and malformed messages hidden beside an SSE response", async () => {
    for (const hidden of [
      { jsonrpc: "2.0", id: "server-request", method: "sampling/create", params: {} },
      { jsonrpc: "2.0", method: "", result: { smuggled: true } },
    ]) {
      const body = [
        `data: ${JSON.stringify(hidden)}`,
        "",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { resultType: "complete" } })}`,
        "",
      ].join("\n")
      await assert.rejects(
        parseCurrentMcpResponse({
          response: response(body, { headers: { "content-type": "text/event-stream" } }),
          requestId: 7,
        }),
        (error: unknown) => error instanceof McpCurrentTransportError
          && error.code === "MCP_CURRENT_RESPONSE_INVALID",
      )
    }
  })
})
