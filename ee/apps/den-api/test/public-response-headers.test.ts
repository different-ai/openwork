import { describe, expect, test } from "bun:test"
import { sanitizePublicResponseHeaders } from "../src/public-response-headers.js"

describe("public response headers", () => {
  test("preserves public audit pagination without exposing internal request headers", () => {
    const headers = new Headers({
      "x-audit-next-cursor": "signed-cursor",
      "x-audit-snapshot-sequence": "42",
      "x-audit-resource-scope": "first_event",
      "x-request-id": "internal-request",
      "access-control-expose-headers": "X-Audit-Next-Cursor, X-Audit-Snapshot-Sequence, X-Audit-Resource-Scope, X-Request-Id",
    })
    sanitizePublicResponseHeaders(headers)
    expect(headers.get("x-audit-next-cursor")).toBe("signed-cursor")
    expect(headers.get("x-audit-snapshot-sequence")).toBe("42")
    expect(headers.get("x-audit-resource-scope")).toBe("first_event")
    expect(headers.get("x-request-id")).toBeNull()
    expect(headers.get("access-control-expose-headers")).toBe("X-Audit-Next-Cursor, X-Audit-Snapshot-Sequence, X-Audit-Resource-Scope")
  })

  test("strips internal and custom x-* headers from public responses", () => {
    const headers = new Headers({
      "access-control-expose-headers": "Content-Length, X-Request-Id, X-Origin-Host",
      "content-type": "application/json",
      "rndr-id": "render-request",
      "server": "internal-origin",
      "via": "internal-proxy",
      "x-cache-key": "cache:key",
      "x-content-type-options": "nosniff",
      "x-origin-host": "den-api.internal",
      "x-render-origin-server": "Render",
      "x-request-id": "req_internal",
    })

    sanitizePublicResponseHeaders(headers)

    expect(headers.get("access-control-expose-headers")).toBe("Content-Length")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("x-content-type-options")).toBe("nosniff")
    for (const header of [
      "rndr-id",
      "server",
      "via",
      "x-cache-key",
      "x-origin-host",
      "x-render-origin-server",
      "x-request-id",
    ]) {
      expect(headers.get(header)).toBeNull()
    }
  })
})
