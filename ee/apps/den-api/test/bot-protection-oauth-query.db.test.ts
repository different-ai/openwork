import { afterAll, beforeAll, expect, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { makeSignature } from "better-auth/crypto"

// Proves the MCP OAuth bypass uses Better Auth's real signature check.
// Needs an isolated, schema-pushed MySQL database:
// DATABASE_URL=$DEN_TEST_DATABASE_URL bun test --conditions development test/bot-protection-oauth-query.db.test.ts
const SECRET = "botid-oauth-query-test-secret-0123456789"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
process.env.BETTER_AUTH_SECRET = SECRET
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
process.env.OPENWORK_DEV_MODE = "0"

const clientId = `client_${createDenTypeId("oauthClient")}`
let verifyMcpOAuthQuery: typeof import("../src/bot-protection.js").verifyMcpOAuthQuery
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

beforeAll(async () => {
  const modules = await Promise.all([
    import("../src/bot-protection.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  verifyMcpOAuthQuery = modules[0].verifyMcpOAuthQuery
  db = modules[1].db
  schema = modules[2]
  drizzle = modules[3]
  await db.insert(schema.OAuthClientTable).values({
    id: createDenTypeId("oauthClient"),
    clientId,
    name: "BotID agent context test",
    redirectUris: JSON.stringify(["http://127.0.0.1:49152/oauth/callback"]),
    tokenEndpointAuthMethod: "none",
    grantTypes: JSON.stringify(["authorization_code"]),
    responseTypes: JSON.stringify(["code"]),
    public: true,
    requirePKCE: true,
  })
})

afterAll(async () => {
  await db.delete(schema.OAuthClientTable).where(drizzle.eq(schema.OAuthClientTable.clientId, clientId))
})

function canonical(params: URLSearchParams) {
  const sorted = new URLSearchParams()
  const entries = [...params.entries()].sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)
  for (const [key, value] of entries) sorted.append(key, value)
  return sorted
}

async function signedQuery(exp: number, secret = SECRET) {
  const params = new URLSearchParams({ client_id: clientId, exp: String(exp), response_type: "code" })
  params.set("sig", await makeSignature(canonical(params).toString(), secret))
  return params.toString()
}

async function verifies(query: string) {
  return verifyMcpOAuthQuery(query).catch(() => false)
}

const inTenMinutes = () => Math.floor(Date.now() / 1000) + 600

test("accepts an authorize query signed with the Better Auth secret", async () => {
  expect(await verifies(await signedQuery(inTenMinutes()))).toBe(true)
})

test("rejects forged, wrongly signed, tampered, and expired queries", async () => {
  expect(await verifies(`client_id=${clientId}&exp=${inTenMinutes()}&sig=forged`)).toBe(false)
  expect(await verifies(await signedQuery(inTenMinutes(), "attacker-chosen-secret-0123456789"))).toBe(false)
  expect(await verifies((await signedQuery(inTenMinutes())).replace("response_type=code", "response_type=token"))).toBe(false)
  expect(await verifies(await signedQuery(Math.floor(Date.now() / 1000) - 60))).toBe(false)
})
