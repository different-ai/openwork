import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let mcpAuth: typeof import("../src/mcp/auth.js")

beforeAll(async () => {
  seedRequiredEnv()
  mcpAuth = await import("../src/mcp/auth.js")
})

test("MCP JWT verification pins issuer, audience, and signing algorithm", () => {
  expect(mcpAuth.getMcpJwtVerifyOptions()).toEqual({
    issuer: "http://127.0.0.1:8790/api/auth",
    audience: ["http://127.0.0.1:8790/mcp"],
    algorithms: ["EdDSA"],
  })
})
