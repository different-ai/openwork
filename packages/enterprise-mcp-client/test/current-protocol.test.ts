import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createCurrentMcpRequest,
  createMcpUnsupportedVersionError,
  McpCurrentProtocolError,
  validateCurrentMcpRouting,
} from "../src/index.js"

function currentToolCall() {
  return createCurrentMcpRequest({
    id: "request-1",
    method: "tools/call",
    params: {
      name: "search",
      arguments: { tenant: "org-1", limit: 10 },
    },
    metadata: {
      clientInfo: { name: "OpenWork", version: "1.0.0" },
      clientCapabilities: { elicitation: {} },
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
    parameterHeaders: [{ parameterPath: ["tenant"], headerName: "Tenant" }],
  })
}

describe("MCP current request routing", () => {
  it("produces the standardized unsupported-version envelope", () => {
    assert.deepEqual(createMcpUnsupportedVersionError({
      id: "request-1",
      requested: "2026-07-28",
      supported: ["2025-11-25"],
    }), {
      jsonrpc: "2.0",
      id: "request-1",
      error: {
        code: -32022,
        message: "Unsupported MCP protocol version: 2026-07-28",
        data: {
          supported: ["2025-11-25"],
          requested: "2026-07-28",
        },
      },
    })
  })

  it("builds and validates stateless metadata and routing headers", () => {
    const request = currentToolCall()
    assert.equal(request.headers.get("MCP-Protocol-Version"), "2026-07-28")
    assert.equal(request.headers.get("Mcp-Method"), "tools/call")
    assert.equal(request.headers.get("Mcp-Name"), "search")
    assert.equal(request.headers.get("Mcp-Param-tenant"), "org-1")
    assert.equal(request.headers.has("Mcp-Session-Id"), false)

    const parsed = validateCurrentMcpRouting({
      headers: request.headers,
      body: request.body,
      parameterHeaders: [{ parameterPath: ["tenant"], headerName: "Tenant" }],
    })
    assert.equal(parsed.method, "tools/call")
  })

  it("rejects header/body mismatches with the current standardized code", () => {
    const request = currentToolCall()
    request.headers.set("Mcp-Name", "different-tool")
    assert.throws(
      () => validateCurrentMcpRouting({ headers: request.headers, body: request.body }),
      (error: unknown) => error instanceof McpCurrentProtocolError
        && error.code === "MCP_CURRENT_HEADER_MISMATCH"
        && error.jsonRpcCode === -32020,
    )
  })

  it("ignores a legacy request session without minting or depending on it", () => {
    const request = currentToolCall()
    request.headers.set("Mcp-Session-Id", "legacy-session")
    assert.doesNotThrow(
      () => validateCurrentMcpRouting({ headers: request.headers, body: request.body }),
    )
  })

  it("rejects unsafe parameter mappings and sentinel-encodes unsafe values", () => {
    assert.throws(
      () => createCurrentMcpRequest({
        id: 1,
        method: "tools/call",
        params: { name: "unsafe", arguments: { token: "safe" } },
        metadata: {
          clientInfo: { name: "OpenWork", version: "1.0.0" },
          clientCapabilities: {},
        },
        parameterHeaders: [{ parameterPath: ["token"], headerName: "bad header" }],
      }),
      McpCurrentProtocolError,
    )
    const encoded = createCurrentMcpRequest({
      id: 1,
      method: "tools/call",
      params: { name: "unsafe", arguments: { tenant: "org-1\r\nHost: attacker.test" } },
      metadata: {
        clientInfo: { name: "OpenWork", version: "1.0.0" },
        clientCapabilities: {},
      },
      parameterHeaders: [{ parameterPath: ["tenant"], headerName: "Tenant" }],
    })
    assert.match(encoded.headers.get("Mcp-Param-Tenant") ?? "", /^=\?base64\?.+\?=$/)
    assert.doesNotThrow(() => validateCurrentMcpRouting({
      headers: encoded.headers,
      body: encoded.body,
      parameterHeaders: [{ parameterPath: ["tenant"], headerName: "Tenant" }],
    }))

    const tabEncoded = createCurrentMcpRequest({
      id: 2,
      method: "tools/call",
      params: { name: "unsafe", arguments: { tenant: "\tindented" } },
      metadata: {
        clientInfo: { name: "OpenWork", version: "1.0.0" },
        clientCapabilities: {},
      },
      parameterHeaders: [{ parameterPath: ["tenant"], headerName: "Tenant" }],
    })
    assert.match(tabEncoded.headers.get("Mcp-Param-Tenant") ?? "", /^=\?base64\?.+\?=$/)
  })

  it("compares mirrored integer parameters numerically", () => {
    const request = currentToolCall()
    request.headers.set("Mcp-Param-Tenant", "org-1")
    request.headers.set("Mcp-Param-Limit", "10.0")
    assert.doesNotThrow(() => validateCurrentMcpRouting({
      headers: request.headers,
      body: request.body,
      parameterHeaders: [
        { parameterPath: ["tenant"], headerName: "Tenant" },
        { parameterPath: ["limit"], headerName: "Limit" },
      ],
    }))
  })
})
