import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"

const WEB_ORIGIN = "https://web.selfhost.example.test"
const OTHER_WEB_ORIGIN = "https://other.selfhost.example.test"
const UNKNOWN_ORIGIN = "https://unknown.example.test"
const APPROVED_ORIGINS = new Set([WEB_ORIGIN, OTHER_WEB_ORIGIN])

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://localhost:3005"
  process.env.DEN_CORS_HANDLED_BY_EDGE = "false"
}

let app: typeof import("../src/app.js")["default"]
let webOrigins: typeof import("../src/organization-web-origins.js")
let lookupFails = false
const lookedUpOrigins: string[] = []

beforeAll(async () => {
  seedRequiredEnv()
  app = (await import("../src/app.js")).default
  webOrigins = await import("../src/organization-web-origins.js")
})

beforeEach(() => {
  lookupFails = false
  lookedUpOrigins.length = 0
  webOrigins.setWebOriginApprovalLookupForTest(async ({ origin }) => {
    lookedUpOrigins.push(origin)
    if (lookupFails) throw new Error("database unavailable")
    return APPROVED_ORIGINS.has(origin)
  })
})

afterAll(() => {
  webOrigins.setWebOriginApprovalLookupForTest(null)
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

  test("allows origins approved by any organization without reflecting unknown origins", async () => {
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

  test("a failing approved-origin lookup fails closed instead of failing the request", async () => {
    lookupFails = true
    const res = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: { Origin: WEB_ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(lookedUpOrigins).toEqual([WEB_ORIGIN])
  })

  test("approved origins are cached so repeated preflights skip the lookup", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await app.request("/v1/me", {
        method: "OPTIONS",
        headers: { Origin: WEB_ORIGIN, "Access-Control-Request-Method": "GET" },
      })
      expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN)
    }
    expect(lookedUpOrigins).toEqual([WEB_ORIGIN])
  })

  test("non-canonical and non-HTTPS origins are rejected without a lookup", async () => {
    for (const origin of ["http://web.selfhost.example.test", "https://WEB.selfhost.example.test", "null"]) {
      const res = await app.request("/v1/me", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      })
      expect(res.headers.get("access-control-allow-origin")).toBeNull()
    }
    expect(lookedUpOrigins).toEqual([])
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
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    expect(lookedUpOrigins).toEqual([])
  })
})
