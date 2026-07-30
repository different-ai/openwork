import { beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://localhost:3005"
}

let app: typeof import("../src/app.js")["default"]

beforeAll(async () => {
  seedRequiredEnv()
  app = (await import("../src/app.js")).default
})

// Cloud instance pages live on rotating Daytona preview origins that can
// never be statically allowlisted. The handoff exchange is grant-in-body
// authenticated and ignores cookies, so it reflects any origin; every other
// route must keep the strict allowlist.
const INSTANCE_ORIGIN = "https://8787-rotating.daytonaproxy01.net"

describe("handoff exchange CORS", () => {
  test("preflight on the exchange route reflects a rotating instance origin", async () => {
    const res = await app.request("/v1/auth/desktop-handoff/exchange", {
      method: "OPTIONS",
      headers: {
        Origin: INSTANCE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization",
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(INSTANCE_ORIGIN)
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-allow-methods") ?? "").toContain("POST")
  })

  test("other routes do NOT reflect unknown origins", async () => {
    const res = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: {
        Origin: INSTANCE_ORIGIN,
        "Access-Control-Request-Method": "GET",
      },
    })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("allowlisted origins still work on other routes", async () => {
    // Read the allowlist that env actually resolved: when this file runs
    // alongside others, an earlier import may have frozen CORS_ORIGINS before
    // our seed ran, so asserting a hard-coded origin is order-dependent.
    const { env } = await import("../src/env.js")
    const allowlisted = env.corsOrigins[0]
    if (!allowlisted) return

    const res = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: {
        Origin: allowlisted,
        "Access-Control-Request-Method": "GET",
      },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe(allowlisted)
  })
})
