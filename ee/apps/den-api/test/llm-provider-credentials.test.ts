import { beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let llmProviderModule: typeof import("../src/routes/org/llm-providers.js")

beforeAll(async () => {
  seedRequiredEnv()
  llmProviderModule = await import("../src/routes/org/llm-providers.js")
})

test("generic provider payload redaction removes API key and OAuth auth material", () => {
  const redacted = llmProviderModule.redactLlmProviderCredentials({
    id: "llmProvider_secret_123",
    apiKey: "plain-secret",
    opencodeAuth: JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: 1 }),
  })

  expect(redacted).toEqual({
    id: "llmProvider_secret_123",
    apiKey: undefined,
    opencodeAuth: undefined,
  })
})

test("credential flags expose presence only, never credential values", () => {
  expect(llmProviderModule.getCredentialFlags({
    credentialKind: "opencode_oauth",
    apiKey: "plain-secret",
    opencodeAuth: JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: 1 }),
  })).toEqual({ hasApiKey: true, hasOpencodeAuth: true, hasCredential: true })
})

test("credential import permission gate requires organization admin role", () => {
  const owner = { currentMember: { isOwner: true, role: "member" } }
  const admin = { currentMember: { isOwner: false, role: "admin" } }
  const creatorOnly = { currentMember: { isOwner: false, role: "member" } }

  expect(llmProviderModule.canImportLlmProviderCredential(owner)).toBe(true)
  expect(llmProviderModule.canImportLlmProviderCredential(admin)).toBe(true)
  expect(llmProviderModule.canImportLlmProviderCredential(creatorOnly)).toBe(false)
})

test("purpose-specific import endpoint requires authentication", async () => {
  const app = new Hono()
  llmProviderModule.registerOrgLlmProviderRoutes(app)

  const response = await app.request("http://den.local/v1/llm-providers/llmProvider_secret_123/import-credential", {
    method: "GET",
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" })
})
