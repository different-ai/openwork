import { describe, expect, test } from "bun:test"
import { redactDenRequestLogLine } from "../src/request-log-redaction.js"

describe("Den request log redaction", () => {
  test("redacts OAuth code and state on external MCP callbacks", () => {
    const line = redactDenRequestLogLine(
      "<-- GET /v1/mcp-connections/emc_example/connect/callback?code=secret-code&state=secret-state&safe=visible",
    )
    expect(line).not.toContain("secret-code")
    expect(line).not.toContain("secret-state")
    expect(line).not.toContain("visible")
    expect(line).toContain("oauth_callback=%5BREDACTED%5D")
  })

  test("redacts percent-encoded OAuth parameter names on response logs", () => {
    const line = redactDenRequestLogLine(
      "--> GET /v1/mcp-connections/emc_example/connect/callback?%2563ode=encoded-code&st%61te=encoded-state 200 8ms",
    )
    expect(line).not.toContain("encoded-code")
    expect(line).not.toContain("encoded-state")
    expect(line).toEndWith(" 200 8ms")
  })

  test("redacts provider denial descriptions and arbitrary callback parameters", () => {
    const line = redactDenRequestLogLine(
      "<-- GET /v1/mcp-connections/emc_example/connect/callback?error=access_denied&error_description=tenant-sensitive&custom=provider-data&state=secret-state",
    )
    expect(line).not.toContain("access_denied")
    expect(line).not.toContain("tenant-sensitive")
    expect(line).not.toContain("provider-data")
    expect(line).not.toContain("secret-state")
  })

  test("does not rewrite unrelated request paths", () => {
    const line = "<-- GET /v1/search?state=california&code=incident"
    expect(redactDenRequestLogLine(line)).toBe(line)
  })
})
