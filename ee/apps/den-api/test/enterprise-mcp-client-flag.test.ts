import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseEnterpriseMcpClientEnabled } from "../src/enterprise-mcp-client-flag.js"

describe("DEN_ENABLE_ENTERPRISE_MCP_CLIENT", () => {
  it("keeps the current Den implementation when unset or false", () => {
    assert.equal(parseEnterpriseMcpClientEnabled(undefined), false)
    assert.equal(parseEnterpriseMcpClientEnabled("false"), false)
  })

  it("enables the enterprise MCP client only for true", () => {
    assert.equal(parseEnterpriseMcpClientEnabled("true"), true)
  })

  it("fails startup-oriented parsing for invalid values", () => {
    assert.throws(
      () => parseEnterpriseMcpClientEnabled("TRUE"),
      /DEN_ENABLE_ENTERPRISE_MCP_CLIENT must be true or false/,
    )
  })
})
