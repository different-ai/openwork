import { beforeAll, expect, mock, test } from "bun:test"

// Better Auth renders its own error card at /api/auth/error (or bounces to
// `/?error=` in production). Den points that redirect at its branded page so
// OAuth authorization failures that cannot go back to the client are explained
// on the same surface as the MCP connect pages.
const API_ORIGIN = "http://127.0.0.1:8790"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? API_ORIGIN
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? API_ORIGIN
}

let app: typeof import("../src/app.js").default

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))
  app = (await import("../src/app.js")).default
})

test("Better Auth's error route redirects to Den web's OAuth error page with the error preserved", async () => {
  const response = await app.fetch(new Request(`${API_ORIGIN}/api/auth/error?error=invalid_redirect&error_description=invalid+redirect+uri`))
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get("location") ?? "")
  expect(`${location.origin}${location.pathname}`).toBe(`${process.env.BETTER_AUTH_URL}/connect/error`)
  expect(location.searchParams.get("error")).toBe("invalid_redirect")
  expect(location.searchParams.get("error_description")).toBe("invalid redirect uri")
})

test("an authorize request for an unknown client lands on the branded page, not Better Auth's card", async () => {
  const url = new URL(`${API_ORIGIN}/api/auth/oauth2/authorize`)
  url.searchParams.set("client_id", "does-not-exist")
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", "http://127.0.0.1:1/callback")
  url.searchParams.set("scope", "mcp:read")
  url.searchParams.set("resource", `${API_ORIGIN}/mcp/agent`)
  url.searchParams.set("code_challenge", "x".repeat(43))
  url.searchParams.set("code_challenge_method", "S256")
  const response = await app.fetch(new Request(url))
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get("location") ?? "")
  expect(location.pathname).toBe("/connect/error")
  expect(location.searchParams.get("error")).toBe("invalid_client")
})
