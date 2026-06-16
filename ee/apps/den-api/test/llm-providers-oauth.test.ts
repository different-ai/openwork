import { beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
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

function createRouteApp() {
  const app = new Hono()
  llmProviderModule.registerOrgLlmProviderRoutes(app)
  return app
}

function jwtWithClaims(claims: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".")
}

test("generic provider payload redaction removes API key and OAuth auth material", () => {
  const redacted = llmProviderModule.redactLlmProviderCredentials({
    id: "llmProvider_secret_123",
    apiKey: "sk-secret",
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
    apiKey: "sk-secret",
    opencodeAuth: JSON.stringify({ type: "oauth", access: "access", refresh: "refresh", expires: 1 }),
  })).toEqual({ hasApiKey: true, hasOpencodeAuth: true, hasCredential: true })
})

test("OpenCode OAuth credential type rejects non-OpenAI providers", () => {
  expect(llmProviderModule.isOpencodeOauthProviderAllowed("openai")).toBe(true)
  expect(llmProviderModule.isOpencodeOauthProviderAllowed(" OpenAI ")).toBe(true)
  expect(llmProviderModule.isOpencodeOauthProviderAllowed("anthropic")).toBe(false)
  expect(llmProviderModule.isOpencodeOauthProviderAllowed(undefined)).toBe(false)
})

test("OAuth credential and import permission gates require organization admin role", () => {
  const owner = { currentMember: { isOwner: true, role: "member" } }
  const admin = { currentMember: { isOwner: false, role: "admin" } }
  const creatorOnly = { currentMember: { isOwner: false, role: "member" } }

  expect(llmProviderModule.canUseOpenAiOAuthCredentialFlow(owner)).toBe(true)
  expect(llmProviderModule.canUseOpenAiOAuthCredentialFlow(admin)).toBe(true)
  expect(llmProviderModule.canUseOpenAiOAuthCredentialFlow(creatorOnly)).toBe(false)
  expect(llmProviderModule.canImportLlmProviderCredential(owner)).toBe(true)
  expect(llmProviderModule.canImportLlmProviderCredential(admin)).toBe(true)
  expect(llmProviderModule.canImportLlmProviderCredential(creatorOnly)).toBe(false)
})

test("OpenAI OAuth routes require an authenticated caller before returning credential material", async () => {
  const app = createRouteApp()

  const startResponse = await app.request("http://den.local/v1/llm-providers/openai-oauth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  expect(startResponse.status).toBe(401)
  await expect(startResponse.json()).resolves.toEqual({ error: "unauthorized" })

  const completeResponse = await app.request("http://den.local/v1/llm-providers/openai-oauth/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceAuthId: "dev", userCode: "code" }),
  })
  expect(completeResponse.status).toBe(401)
  await expect(completeResponse.json()).resolves.toEqual({ error: "unauthorized" })
})

test("purpose-specific import endpoint requires authentication", async () => {
  const app = createRouteApp()
  const response = await app.request("http://den.local/v1/llm-providers/llmProvider_secret_123/import-credential", {
    method: "GET",
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: "unauthorized" })
})

test("OpenAI OAuth completion reports pending authorization without tokens", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 403 })) as typeof fetch
  try {
    await expect(llmProviderModule.completeOpenAiDeviceAuth({
      deviceAuthId: "device-pending",
      userCode: "CODE",
    })).rejects.toMatchObject({ error: "openai_oauth_pending", status: 409 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI OAuth completion reports expired device authorization separately from pending", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as typeof fetch
  try {
    await expect(llmProviderModule.completeOpenAiDeviceAuth({
      deviceAuthId: "device-expired",
      userCode: "CODE",
    })).rejects.toMatchObject({ error: "openai_oauth_expired", status: 410 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI OAuth start reports upstream failure without credential material", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "upstream" }), { status: 500 })) as typeof fetch
  try {
    await expect(llmProviderModule.startOpenAiDeviceAuth()).rejects.toMatchObject({
      error: "openai_oauth_start_failed",
      status: 502,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI OAuth completion reports token exchange failure without credential material", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json({ authorization_code: "authorization-code", code_verifier: "verifier" })
    }
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ error: "exchange_failed" }), { status: 500 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  try {
    await expect(llmProviderModule.completeOpenAiDeviceAuth({
      deviceAuthId: "device-failure",
      userCode: "CODE",
    })).rejects.toMatchObject({ error: "openai_oauth_complete_failed", status: 502 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("OpenAI OAuth completion returns importable OpenCode OAuth auth on success", async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      return Response.json({ authorization_code: "authorization-code", code_verifier: "verifier" })
    }
    if (url.endsWith("/oauth/token")) {
      return Response.json({
        access_token: jwtWithClaims({ chatgpt_account_id: "acct_123" }),
        refresh_token: "refresh-token",
        expires_in: 60,
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  try {
    const completed = await llmProviderModule.completeOpenAiDeviceAuth({
      deviceAuthId: "device-complete",
      userCode: "CODE",
    })
    const auth = JSON.parse(completed.opencodeAuth) as Record<string, unknown>

    expect(calls).toHaveLength(2)
    expect(auth.type).toBe("oauth")
    expect(typeof auth.access).toBe("string")
    expect(auth.refresh).toBe("refresh-token")
    expect(auth.accountId).toBe("acct_123")
    expect(completed.accountId).toBe("acct_123")
    expect(typeof auth.expires).toBe("number")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("LLM provider migration journal remains valid JSON", async () => {
  const journal = await readFile(new URL("../../../packages/den-db/drizzle/meta/_journal.json", import.meta.url), "utf8")
  const parsed = JSON.parse(journal) as { entries?: Array<{ tag?: string }> }

  expect(parsed.entries?.some((entry) => entry.tag === "0026_llm_provider_opencode_oauth")).toBe(true)
})

test("LLM provider OAuth migration snapshot metadata is present", async () => {
  const snapshot = await readFile(new URL("../../../packages/den-db/drizzle/meta/0026_snapshot.json", import.meta.url), "utf8")
  const parsed = JSON.parse(snapshot) as { tables?: Record<string, { columns?: Record<string, unknown> }> }
  const llmProviderColumns = parsed.tables?.llm_provider?.columns ?? {}

  expect("credential_kind" in llmProviderColumns).toBe(true)
  expect("opencode_auth" in llmProviderColumns).toBe(true)
})
