import { expect, test } from "bun:test"
import { redactRequestLogLine } from "../src/request-log-redaction.js"

test("redacts OAuth and credential query values from request logs", () => {
  const line = "<-- GET /v1/mcp-connections/emc_1/connect/callback?code=secret-code&state=signed-state&safe=value&client_secret=hidden"
  const redacted = redactRequestLogLine(line)

  expect(redacted).toBe("<-- GET /v1/mcp-connections/emc_1/connect/callback?code=[REDACTED]&state=[REDACTED]&safe=value&client_secret=[REDACTED]")
  expect(redacted).not.toContain("secret-code")
  expect(redacted).not.toContain("signed-state")
  expect(redacted).not.toContain("hidden")
})

test("preserves ordinary diagnostic query parameters", () => {
  expect(redactRequestLogLine("<-- GET /health?verbose=1")).toBe("<-- GET /health?verbose=1")
})

test("redacts encoded and mixed-case credential parameter names", () => {
  const redacted = redactRequestLogLine("<-- GET /callback?%63ode=secret&MIXED=value&Access_Token=token-secret")
  expect(redacted).toContain("%63ode=[REDACTED]")
  expect(redacted).toContain("Access_Token=[REDACTED]")
  expect(redacted).toContain("MIXED=value")
  expect(redacted).not.toContain("token-secret")
})

test("redacts Microsoft and ServiceNow OAuth denial details", () => {
  const line = "<-- GET /callback?error=access_denied&error_description=tenant-user-detail&error_uri=https%3A%2F%2Fprovider.invalid%2Fsecret&session_state=opaque-session&state=signed"
  const redacted = redactRequestLogLine(line)
  for (const secret of ["access_denied", "tenant-user-detail", "provider.invalid", "opaque-session", "signed"]) {
    expect(redacted).not.toContain(secret)
  }
  expect(redacted).toContain("error=[REDACTED]")
  expect(redacted).toContain("error_description=[REDACTED]")
})
