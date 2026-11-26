import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeExceptionForTelemetry } from "../src/observability/safe-fields.js"
import { statusFromError } from "../src/observability/hono.js"

class DatabaseError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message)
    this.name = "DatabaseError"
  }
}

test("a failed PlanetScale query keeps the driver's status and code in telemetry", () => {
  const cause = new DatabaseError("upstream connect error", 503, { code: "UNAVAILABLE", message: "upstream connect error" })
  const query = new Error("Failed query: select 1 from `connected_account` where `id` = ?\nparams: secret-param", { cause })

  const sanitized = sanitizeExceptionForTelemetry(query)
  const sanitizedCause = sanitized.cause as Error & { httpStatus?: number; providerCode?: string }

  assert.equal(sanitized.message.includes("secret-param"), false)
  assert.equal(sanitizedCause.message, "upstream connect error (UNAVAILABLE, HTTP 503)")
  assert.equal(sanitizedCause.httpStatus, 503)
  assert.equal(sanitizedCause.providerCode, "UNAVAILABLE")
  // The request still fails as a 500; the driver's HTTP status is diagnostic only.
  assert.equal(statusFromError(sanitized), 500)
  assert.equal("status" in sanitizedCause, false)
})

test("errors that are not PlanetScale DatabaseErrors keep their message unchanged", () => {
  const error = Object.assign(new Error("not found"), { status: 404, body: { code: "NOT_FOUND" } })
  const sanitized = sanitizeExceptionForTelemetry(error) as Error & { httpStatus?: number }
  assert.equal(sanitized.message, "not found")
  assert.equal(sanitized.httpStatus, undefined)
})
