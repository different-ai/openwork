import { describe, expect, test } from "bun:test"
import { redactDenRequestLogLine, redactRequestLogLine } from "../src/request-log-redaction.js"

describe("Den request log redaction", () => {
  test("redacts the complete external MCP callback query", () => {
    const line = redactDenRequestLogLine(
      "<-- GET /v1/mcp-connections/emc_example/connect/callback?code=secret-code&state=secret-state&custom=tenant-data",
    )
    expect(line).toBe("<-- GET /v1/mcp-connections/emc_example/connect/callback?oauth_callback=%5BREDACTED%5D")
    for (const secret of ["secret-code", "secret-state", "tenant-data"]) expect(line).not.toContain(secret)
  })

  test("preserves response status and timing after callback redaction", () => {
    const line = redactDenRequestLogLine(
      "--> GET /v1/mcp-connections/emc_example/connect/callback?%2563ode=encoded-code&st%61te=encoded-state 200 8ms",
    )
    expect(line).not.toContain("encoded-code")
    expect(line).not.toContain("encoded-state")
    expect(line).toEndWith(" 200 8ms")
  })

  test("redacts sensitive parameters on other routes without hiding safe values", () => {
    const line = redactRequestLogLine("<-- GET /callback?%63ode=secret&MIXED=value&Access_Token=token-secret")
    expect(line).toContain("%63ode=[REDACTED]")
    expect(line).toContain("Access_Token=[REDACTED]")
    expect(line).toContain("MIXED=value")
    expect(line).not.toContain("token-secret")
  })

  test("redacts provider denial details outside the canonical callback route", () => {
    const line = redactRequestLogLine("<-- GET /callback?error=access_denied&error_description=tenant-user-detail&error_uri=https%3A%2F%2Fprovider.invalid%2Fsecret&session_state=opaque-session&state=signed")
    for (const secret of ["access_denied", "tenant-user-detail", "provider.invalid", "opaque-session", "signed"]) {
      expect(line).not.toContain(secret)
    }
  })

  test("does not rewrite unrelated safe query parameters", () => {
    const line = "<-- GET /health?verbose=1"
    expect(redactDenRequestLogLine(line)).toBe(line)
  })
})
