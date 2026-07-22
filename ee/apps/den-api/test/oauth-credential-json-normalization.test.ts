import { beforeAll, describe, expect, test } from "bun:test"

let normalization: typeof import("../src/capability-sources/oauth-credentials.js")

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_gwsreconnect"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  normalization = await import("../src/capability-sources/oauth-credentials.js")
})

describe("OAuth credential JSON normalization", () => {
  test("accepts parsed MySQL JSON and string-encoded MariaDB JSON", () => {
    const extra = { features: ["mailRead", "calendarRead"] }
    const scopes = ["openid", "Mail.Read"]

    expect(normalization.normalizeOAuthClientExtra(extra)).toEqual(extra)
    expect(normalization.normalizeOAuthClientExtra(JSON.stringify(extra))).toEqual(extra)
    expect(normalization.normalizeConnectedAccountScopes(scopes)).toEqual(scopes)
    expect(normalization.normalizeConnectedAccountScopes(JSON.stringify(scopes))).toEqual(scopes)
  })

  test("rejects malformed or incorrectly shaped JSON", () => {
    expect(normalization.normalizeOAuthClientExtra("not-json")).toBeNull()
    expect(normalization.normalizeOAuthClientExtra("[]")).toBeNull()
    expect(normalization.normalizeConnectedAccountScopes("not-json")).toBeNull()
    expect(normalization.normalizeConnectedAccountScopes('{"scope":"Mail.Read"}')).toBeNull()
    expect(normalization.normalizeConnectedAccountScopes('["Mail.Read",7]')).toBeNull()
  })
})
