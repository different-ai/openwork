import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const WEB_ORIGIN = "https://web.selfhost.example.test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://localhost:3005"
  process.env.DEN_CORS_HANDLED_BY_EDGE = "true"
}

let app: typeof import("../src/app.js")["default"]
let corsOrigins: string[]
let webOrigins: typeof import("../src/organization-web-origins.js")
const lookedUpOrigins: string[] = []

beforeAll(async () => {
  seedRequiredEnv()
  app = (await import("../src/app.js")).default
  corsOrigins = (await import("../src/env.js")).env.corsOrigins
  webOrigins = await import("../src/organization-web-origins.js")
  webOrigins.setWebOriginApprovalLookupForTest(async ({ origin }) => {
    lookedUpOrigins.push(origin)
    return origin === WEB_ORIGIN
  })
})

afterAll(() => {
  webOrigins.setWebOriginApprovalLookupForTest(null)
})

// Behind an edge that answers CORS itself (the Daytona preview proxy reflects
// the caller's origin on every response), den-api's own headers would be
// duplicates that browsers reject. With the flag on, den-api emits none while
// the allowlist itself stays resolved for proxy-trust decisions.
describe("DEN_CORS_HANDLED_BY_EDGE", () => {
  test("den-api emits no CORS headers for an allowlisted origin", async () => {
    const allowlisted = corsOrigins[0]
    expect(allowlisted).toBeTruthy()
    const res = await app.request("/health", { headers: { Origin: allowlisted } })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(res.headers.get("access-control-allow-credentials")).toBeNull()
  })

  test.each(["/v1/me", "/v1/me/orgs"])("den-api leaves approved web origin preflights on %s to the edge", async (path) => {
    const res = await app.request(path, {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(res.headers.get("access-control-allow-credentials")).toBeNull()
    expect(res.headers.get("access-control-allow-headers")).toBeNull()
    expect(lookedUpOrigins).toEqual([])
  })

  test("the handoff exchange route stops reflecting origins too", async () => {
    const res = await app.request("/v1/auth/desktop-handoff/exchange", {
      method: "OPTIONS",
      headers: {
        Origin: "https://8787-rotating.daytonaproxy01.net",
        "Access-Control-Request-Method": "POST",
      },
    })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("the allowlist is still resolved", () => {
    expect(corsOrigins.length).toBeGreaterThan(0)
  })
})
