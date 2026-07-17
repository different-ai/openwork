import { describe, expect, test } from "bun:test"
import {
  MCP_CURRENT_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
} from "@openwork/enterprise-mcp-client"
import { rejectUnqualifiedCurrentMcpRequest } from "../src/mcp/protocol-version-gate.js"

function request(protocolVersion?: string, body: unknown = {
  jsonrpc: "2.0",
  id: "request-1",
  method: "server/discover",
  params: {},
}) {
  return new Request("https://api.example.test/mcp/agent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("MCP current protocol qualification gate", () => {
  test("does not intercept the stable lifecycle", async () => {
    expect(await rejectUnqualifiedCurrentMcpRequest(request(MCP_LEGACY_PROTOCOL_VERSION))).toBeNull()
    expect(await rejectUnqualifiedCurrentMcpRequest(request())).toBeNull()
  })

  test("rejects current traffic with the exact supported-version contract", async () => {
    const response = await rejectUnqualifiedCurrentMcpRequest(request(MCP_CURRENT_PROTOCOL_VERSION))
    expect(response?.status).toBe(400)
    expect(response?.headers.get("MCP-Protocol-Version")).toBe(MCP_LEGACY_PROTOCOL_VERSION)
    expect(await response?.json()).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      error: {
        code: -32022,
        message: `Unsupported MCP protocol version: ${MCP_CURRENT_PROTOCOL_VERSION}`,
        data: {
          supported: [MCP_LEGACY_PROTOCOL_VERSION],
          requested: MCP_CURRENT_PROTOCOL_VERSION,
        },
      },
    })
  })

  test("never reflects malformed JSON-RPC ids", async () => {
    const response = await rejectUnqualifiedCurrentMcpRequest(request(
      MCP_CURRENT_PROTOCOL_VERSION,
      { jsonrpc: "2.0", id: { secret: "not-an-id" }, method: "server/discover" },
    ))
    expect((await response?.json()).id).toBeNull()
  })

  test("does not buffer an oversized body just to recover its request id", async () => {
    const oversized = new Request("https://api.example.test/mcp/agent", {
      method: "POST",
      headers: {
        "content-length": String(64 * 1024 + 1),
        "content-type": "application/json",
        "MCP-Protocol-Version": MCP_CURRENT_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "must-not-be-reflected", method: "server/discover" }),
    })
    const response = await rejectUnqualifiedCurrentMcpRequest(oversized)
    expect((await response?.json()).id).toBeNull()
  })
})
