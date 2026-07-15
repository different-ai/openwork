import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseEnterpriseMcpClientEnabled } from "../src/enterprise-mcp-client-flag.js"

describe("DEN_ENABLE_ENTERPRISE_MCP_CLIENT", () => {
  it("defaults to the enterprise client while preserving false as rollback", () => {
    assert.equal(parseEnterpriseMcpClientEnabled(undefined), true)
    assert.equal(parseEnterpriseMcpClientEnabled("false"), false)
  })

  it("accepts an explicit true value", () => {
    assert.equal(parseEnterpriseMcpClientEnabled("true"), true)
  })

  it("fails startup-oriented parsing for invalid values", () => {
    assert.throws(
      () => parseEnterpriseMcpClientEnabled("TRUE"),
      /DEN_ENABLE_ENTERPRISE_MCP_CLIENT must be true or false/,
    )
  })
})
