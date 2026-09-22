import { beforeAll, describe, expect, test } from "bun:test"
import { typeId } from "@openwork-ee/utils/typeid"

const WEB_ORIGIN = "https://web.selfhost.example.test"
const OTHER_WEB_ORIGIN = "https://other.selfhost.example.test"
const UNKNOWN_ORIGIN = "https://unknown.example.test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://localhost:3005"
  process.env.DEN_CORS_HANDLED_BY_EDGE = "false"
  process.env.DEN_WEB_HANDOFF_RETURN_ORIGINS_BY_ORG = JSON.stringify({
    [typeId.generator("organization")]: [WEB_ORIGIN],
    [typeId.generator("organization")]: [WEB_ORIGIN, OTHER_WEB_ORIGIN],
  })
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

  test.each(["/v1/me", "/v1/me/orgs"])("allows an explicitly trusted web origin on %s with authorization", async (path) => {
    const res = await app.request(path, {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN)
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization")
    expect(res.headers.get("access-control-allow-methods")).toContain("GET")
  })

  test("allows origins configured for a different organization without reflecting unknown origins", async () => {
    const allowed = await app.request("/v1/me/orgs", {
      method: "OPTIONS",
      headers: { Origin: OTHER_WEB_ORIGIN, "Access-Control-Request-Method": "GET" },
    })
    expect(allowed.headers.get("access-control-allow-origin")).toBe(OTHER_WEB_ORIGIN)

    const denied = await app.request("/v1/me/orgs", {
      method: "OPTIONS",
      headers: { Origin: UNKNOWN_ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    })
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
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
