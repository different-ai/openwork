import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import type { GatewayCredential, GatewayProvider } from "../src/gateway.js"
import type { InferenceReporter } from "../src/inference-reporting.js"
import type { MintGcpAccessToken } from "../src/credentials/gcp-service-account.js"
import type { RefreshGoogleOauthToken } from "../src/credentials/google-oauth-refresh.js"
import { createProviderCatalog } from "../src/provider-catalog.js"
import type { InferenceRequestLogRow } from "../src/request-log.js"
import { bedrockStreamFrames } from "./helpers/event-stream.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
process.env.OPENROUTER_UPSTREAM_URL = "https://upstream.test/api/v1"

const { registerProxyRoutes } = await import("../src/proxy.js")

const organizationId = "org_test_org"
const memberId = "om_test_member"
const providerId = "ipr_test_provider"
const credentialId = "ipc_test_credential"

const catalog = createProviderCatalog({
  anthropic: { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
  openai: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] },
  azure: { npm: "@ai-sdk/azure", env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
  google: { npm: "@ai-sdk/google", env: ["GOOGLE_GENERATIVE_AI_API_KEY"] },
  "google-vertex": { npm: "@ai-sdk/google-vertex", env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"] },
  "google-vertex-anthropic": { npm: "@ai-sdk/google-vertex/anthropic", env: ["GOOGLE_VERTEX_PROJECT"] },
  openrouter: { npm: "@openrouter/ai-sdk-provider", api: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"] },
  groq: { npm: "@ai-sdk/groq", api: "https://api.groq.com/openai/v1", env: ["GROQ_API_KEY"] },
  "amazon-bedrock": { npm: "@ai-sdk/amazon-bedrock", env: ["AWS_ACCESS_KEY_ID"] },
})

type UpstreamRequest = {
  url: string
  method: string | undefined
  body: string | null
  headers: Headers
}

type TestServerOptions = {
  provider?: Partial<GatewayProvider> | null
  credential?: Partial<GatewayCredential> | null
  access?: boolean
  fetch?: typeof fetch
  now?: Date
  refreshGoogleOauthToken?: RefreshGoogleOauthToken
  mintGcpAccessToken?: MintGcpAccessToken
}

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: providerId,
    organization_id: organizationId,
    provider_id: "openai",
    provider_config: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] },
    settings: {},
    credential_mode: "org",
    status: "active",
    oauth_client_id: null,
    oauth_client_secret: null,
    ...overrides,
  }
}

function credential(overrides: Partial<GatewayCredential> = {}): GatewayCredential {
  return {
    id: credentialId,
    kind: "api_key",
    secret: "upstream-secret",
    expires_at: null,
    status: "active",
    ...overrides,
  }
}

function sseResponse(events: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } })
}

function readInitBody(body: BodyInit | null | undefined) {
  if (typeof body === "string") return body
  if (!body) return null
  throw new Error("Expected forwarded body to be a string")
}

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (input instanceof Request) return input.url
  return input.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonObject(text: string | null) {
  assert.ok(text !== null)
  const value: unknown = JSON.parse(text)
  assert.ok(isRecord(value))
  return value
}

async function readError(response: Response) {
  const payload: unknown = await response.json()
  assert.ok(isRecord(payload))
  assert.ok(isRecord(payload.error))
  return payload.error
}

async function waitForRows(rows: InferenceRequestLogRow[], count = 1) {
  for (let attempt = 0; attempt < 50 && rows.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(rows.length, count)
  const row = rows[0]
  assert.ok(row)
  return row
}

function createTestServer(options: TestServerOptions = {}) {
  const app = new Hono()
  const upstreamRequests: UpstreamRequest[] = []
  const logRows: InferenceRequestLogRow[] = []
  const accessChecks: Array<{ inferenceProviderId: string; orgMembershipId: string }> = []
  const credentialLookups: Array<{ inferenceProviderId: string; subject: string }> = []
  const reporter: InferenceReporter = { request() {}, handledError() {} }
  const capturingFetch: typeof fetch = async (input, init) => {
    upstreamRequests.push({
      url: requestUrl(input),
      method: init?.method,
      body: readInitBody(init?.body),
      headers: new Headers(init?.headers),
    })
    if (options.fetch) return options.fetch(input, init)
    return Response.json({ ok: true })
  }
  const providerRow = options.provider === null ? null : provider(options.provider)
  const credentialRow = options.credential === null ? null : credential(options.credential)

  registerProxyRoutes(app, {
    async findActiveInferenceKey() {
      return { id: "ik_test_key", organization_id: organizationId, org_membership_id: memberId }
    },
    async getOpenRouterProviderKey() {
      return null
    },
    async ensureUsableBuckets() {
      return { ok: true, bucketIds: {}, bucketLimits: {} }
    },
    fetch: capturingFetch,
    async loadOrganization(id) {
      return { id, metadata: null }
    },
    async insertRequestLog(row) {
      logRows.push(row)
    },
    reporter,
    gateway: {
      catalog,
      now: options.now ? () => options.now ?? new Date() : undefined,
      refreshGoogleOauthToken: options.refreshGoogleOauthToken ?? (async () => {
        throw new Error("unexpected oauth refresh")
      }),
      mintGcpAccessToken: options.mintGcpAccessToken ?? (async () => {
        throw new Error("unexpected gcp token mint")
      }),
      async loadInferenceProvider(input) {
        if (!providerRow || input.organizationId !== providerRow.organization_id || input.inferenceProviderId !== providerRow.id) return null
        return providerRow
      },
      async hasProviderAccess(input) {
        accessChecks.push(input)
        return options.access ?? true
      },
      async loadProviderCredential(input) {
        credentialLookups.push(input)
        return credentialRow
      },
    },
  })

  return { app, upstreamRequests, logRows, accessChecks, credentialLookups }
}

function gatewayRequest(input: { path: string; method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; id?: string }) {
  const headers = new Headers({ authorization: "Bearer ow_inf_test", ...input.headers })
  const body = input.rawBody ?? (input.body === undefined ? undefined : JSON.stringify(input.body))
  if (input.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  return new Request(`http://openwork.test/api/v1/providers/${input.id ?? providerId}${input.path}`, {
    method: input.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  })
}

const openAiChatUsageEvent = 'data: {"id":"chatcmpl-1","model":"gpt-4o-2024","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"prompt_tokens_details":{"cached_tokens":6}}}\n\n'

test("openai chat: forwards with bearer auth, strips incoming auth, injects include_usage and logs stream usage", async () => {
  const { app, upstreamRequests, logRows, accessChecks, credentialLookups } = createTestServer({
    fetch: async () => sseResponse(
      ['data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\n', openAiChatUsageEvent, "data: [DONE]\n\n"],
      { "x-request-id": "req_up_1", "content-encoding": "gzip", "content-length": "999" },
    ),
  })
  const response = await app.fetch(gatewayRequest({
    path: "/chat/completions",
    body: { model: "gpt-4o", stream: true, messages: [] },
    headers: { "openai-organization": "org-abc", "x-stainless-lang": "js", cookie: "a=b", "x-api-key": "leak", "anthropic-version": "2023-06-01" },
  }))

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-encoding"), null)
  assert.equal(response.headers.get("content-length"), null)
  assert.ok(response.headers.get("x-openwork-request-id"))
  await response.text()

  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://api.openai.com/v1/chat/completions")
  assert.equal(upstream.method, "POST")
  assert.equal(upstream.headers.get("authorization"), "Bearer upstream-secret")
  assert.equal(upstream.headers.get("x-api-key"), null)
  assert.equal(upstream.headers.get("cookie"), null)
  assert.equal(upstream.headers.get("anthropic-version"), null)
  assert.equal(upstream.headers.get("openai-organization"), "org-abc")
  assert.equal(upstream.headers.get("x-stainless-lang"), "js")
  assert.equal(upstream.headers.get("x-openwork-request-id"), response.headers.get("x-openwork-request-id"))
  const body = parseJsonObject(upstream.body)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.model, "gpt-4o")

  assert.deepEqual(accessChecks, [{ inferenceProviderId: providerId, orgMembershipId: memberId }])
  assert.deepEqual(credentialLookups, [{ inferenceProviderId: providerId, subject: "org" }])

  const row = await waitForRows(logRows)
  assert.equal(row.route, "org_provider")
  assert.equal(row.protocol, "openai_chat")
  assert.equal(row.upstream_provider_id, "openai")
  assert.equal(row.inference_provider_id, providerId)
  assert.equal(row.inference_provider_credential_id, credentialId)
  assert.equal(row.upstream_host, "api.openai.com")
  assert.equal(row.upstream_path, "/v1/chat/completions")
  assert.equal(row.requested_model, "gpt-4o")
  assert.equal(row.upstream_model, "gpt-4o-2024")
  assert.equal(row.stream, true)
  assert.equal(row.outcome, "ok")
  assert.equal(row.usage_source, "stream")
  assert.equal(row.input_tokens, 10)
  assert.equal(row.output_tokens, 20)
  assert.equal(row.cache_read_tokens, 6)
  assert.equal(row.upstream_request_id, "req_up_1")
  assert.equal(row.openwork_request_id, response.headers.get("x-openwork-request-id"))
})

test("openai responses: JSON usage is captured and the path selects the responses protocol", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    fetch: async () => Response.json({ id: "resp_1", model: "gpt-5", usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } } }),
  })
  const response = await app.fetch(gatewayRequest({ path: "/responses", body: { model: "gpt-5", input: "hi" } }))
  assert.equal(response.status, 200)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://api.openai.com/v1/responses")
  const body = parseJsonObject(upstream.body)
  assert.equal(body.stream_options, undefined)

  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "openai_responses")
  assert.equal(row.usage_source, "json")
  assert.equal(row.total_tokens, 7)
  assert.equal(row.reasoning_tokens, 2)
  assert.equal(row.upstream_model, "gpt-5")
  assert.equal(row.stream, false)
})

test("anthropic: x-api-key auth, anthropic headers preserved, stream usage from message_start/delta", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { provider_id: "anthropic", provider_config: { npm: "@ai-sdk/anthropic" } },
    fetch: async () => sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":25,"cache_creation_input_tokens":4,"cache_read_input_tokens":9,"output_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
    ], { "request-id": "req_anthropic" }),
  })
  const response = await app.fetch(gatewayRequest({
    path: "/messages",
    body: { model: "claude-sonnet-4-5", stream: true, messages: [] },
    headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "tools-2024" },
  }))
  assert.equal(response.status, 200)
  await response.text()

  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://api.anthropic.com/v1/messages")
  assert.equal(upstream.headers.get("x-api-key"), "upstream-secret")
  assert.equal(upstream.headers.get("authorization"), null)
  assert.equal(upstream.headers.get("anthropic-version"), "2023-06-01")
  assert.equal(upstream.headers.get("anthropic-beta"), "tools-2024")
  const body = parseJsonObject(upstream.body)
  assert.equal(body.stream_options, undefined)

  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "anthropic_messages")
  assert.equal(row.input_tokens, 25)
  assert.equal(row.output_tokens, 42)
  assert.equal(row.cache_write_tokens, 4)
  assert.equal(row.cache_read_tokens, 9)
  assert.equal(row.upstream_model, "claude-sonnet-4-5")
  assert.equal(row.upstream_request_id, "req_anthropic")
})

test("azure: api-key auth, api-version query preserved, resource base from settings, api_key_map picks the key env", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { provider_id: "azure", provider_config: { npm: "@ai-sdk/azure" }, settings: { resourceName: "acme-openai" } },
    credential: { kind: "api_key_map", secret: JSON.stringify({ AZURE_RESOURCE_NAME: "acme-openai", AZURE_API_KEY: "azure-key" }) },
  })
  const response = await app.fetch(gatewayRequest({
    path: "/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
    body: { model: "gpt-4o", messages: [] },
  }))
  assert.equal(response.status, 200)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://acme-openai.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21")
  assert.equal(upstream.headers.get("api-key"), "azure-key")
  assert.equal(upstream.headers.get("authorization"), null)
  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "openai_chat")
  assert.equal(row.upstream_path, "/openai/deployments/gpt-4o/chat/completions")
})

test("openai-compatible: catalog api base and bearer auth; unknown npm with api falls back to openai_chat", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { provider_id: "groq", provider_config: { npm: "@ai-sdk/groq" } },
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "llama-3", messages: [] } }))
  assert.equal(response.status, 200)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://api.groq.com/openai/v1/chat/completions")
  assert.equal(upstream.headers.get("authorization"), "Bearer upstream-secret")
  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "openai_chat")
  assert.equal(row.upstream_provider_id, "groq")
})

test("provider_config options.baseURL overrides the catalog base", async () => {
  const { app, upstreamRequests } = createTestServer({
    provider: { provider_id: "openrouter", provider_config: { npm: "@openrouter/ai-sdk-provider", options: { baseURL: "https://router.internal/v1/" } } },
  })
  await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x", messages: [] } }))
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://router.internal/v1/chat/completions")
})

test("settings.upstreamBaseUrl overrides both provider_config.options.baseURL and the catalog base", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: {
      provider_id: "anthropic",
      provider_config: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://api.anthropic.com/v1" } },
      settings: { upstreamBaseUrl: "http://127.0.0.1:4321/fake-anthropic/v1/" },
    },
  })
  const response = await app.fetch(gatewayRequest({ path: "/messages", body: { model: "claude-sonnet-4-5", messages: [] } }))
  assert.equal(response.status, 200)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "http://127.0.0.1:4321/fake-anthropic/v1/messages")
  assert.equal(upstream.headers.get("x-api-key"), "upstream-secret")
  const row = await waitForRows(logRows)
  assert.equal(row.upstream_host, "127.0.0.1")
  assert.equal(row.upstream_path, "/fake-anthropic/v1/messages")

  // Negative half: a non-string or empty override is ignored, not treated as a base.
  const ignored = createTestServer({
    provider: { provider_id: "anthropic", provider_config: { npm: "@ai-sdk/anthropic" }, settings: { upstreamBaseUrl: "" } },
  })
  await ignored.app.fetch(gatewayRequest({ path: "/messages", body: { model: "claude-sonnet-4-5", messages: [] } }))
  assert.equal(ignored.upstreamRequests[0]?.url, "https://api.anthropic.com/v1/messages")
})

test("google: x-goog-api-key auth, key query stripped, alt=sse preserved, model from path, stream usage", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { provider_id: "google", provider_config: { npm: "@ai-sdk/google" } },
    fetch: async () => sseResponse([
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}\n\n',
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":13,"totalTokenCount":20,"thoughtsTokenCount":5},"modelVersion":"gemini-2.5-pro-001"}\n\n',
    ], { "x-goog-request-id": "goog_1" }),
  })
  const response = await app.fetch(gatewayRequest({
    path: "/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=leaked",
    body: { contents: [] },
  }))
  assert.equal(response.status, 200)
  await response.text()

  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")
  assert.equal(upstream.headers.get("x-goog-api-key"), "upstream-secret")
  assert.equal(upstream.headers.get("authorization"), null)

  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "google_generate_content")
  assert.equal(row.requested_model, "gemini-2.5-pro")
  assert.equal(row.upstream_model, "gemini-2.5-pro-001")
  assert.equal(row.stream, true)
  assert.equal(row.input_tokens, 7)
  assert.equal(row.output_tokens, 13)
  assert.equal(row.reasoning_tokens, 5)
  assert.equal(row.upstream_request_id, "goog_1")
  assert.equal(row.upstream_path, "/v1beta/models/gemini-2.5-pro:streamGenerateContent")
})

test("google vertex (gemini): path rewritten under the project/location publisher with bearer auth", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: {
      provider_id: "google-vertex",
      provider_config: { npm: "@ai-sdk/google-vertex" },
      settings: { project: "acme-proj", location: "us-central1" },
    },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "ya29.token" }) },
  })
  const response = await app.fetch(gatewayRequest({
    path: "/v1beta/models/gemini-2.5-pro:generateContent",
    body: { contents: [] },
  }))
  assert.equal(response.status, 200)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://us-central1-aiplatform.googleapis.com/v1/projects/acme-proj/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent")
  assert.equal(upstream.headers.get("authorization"), "Bearer ya29.token")
  assert.equal(upstream.headers.get("x-goog-api-key"), null)
  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "google_generate_content")
  assert.equal(row.upstream_host, "us-central1-aiplatform.googleapis.com")
  assert.equal(row.requested_model, "gemini-2.5-pro")
})

test("google vertex (anthropic): rawPredict path, model removed, anthropic_version set, anthropic-version header dropped, global host", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: {
      provider_id: "google-vertex-anthropic",
      provider_config: { npm: "@ai-sdk/google-vertex/anthropic" },
      settings: { project: "acme-proj", location: "global" },
    },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "ya29.token" }) },
  })
  const response = await app.fetch(gatewayRequest({
    path: "/messages",
    body: { model: "claude-sonnet-4-5", stream: true, messages: [] },
    headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "beta-1" },
  }))
  assert.equal(response.status, 200)
  await response.text()
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://aiplatform.googleapis.com/v1/projects/acme-proj/locations/global/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict")
  assert.equal(upstream.headers.get("authorization"), "Bearer ya29.token")
  assert.equal(upstream.headers.get("anthropic-version"), null)
  assert.equal(upstream.headers.get("anthropic-beta"), "beta-1")
  const body = parseJsonObject(upstream.body)
  assert.equal(body.model, undefined)
  assert.equal(body.anthropic_version, "vertex-2023-10-16")
  assert.equal(body.stream, true)
  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "anthropic_messages")
  assert.equal(row.requested_model, "claude-sonnet-4-5")
  assert.equal(row.upstream_path, "/v1/projects/acme-proj/locations/global/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict")
})

test("google vertex: non-stream anthropic uses rawPredict; missing project/location → 502 provider_misconfigured", async () => {
  const ok = createTestServer({
    provider: { provider_id: "google-vertex-anthropic", provider_config: {}, settings: { project: "p", location: "europe-west1" } },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "t" }) },
  })
  await ok.app.fetch(gatewayRequest({ path: "/messages", body: { model: "claude", messages: [] } }))
  assert.ok(ok.upstreamRequests[0]?.url.endsWith("/publishers/anthropic/models/claude:rawPredict"))

  const broken = createTestServer({ provider: { provider_id: "google-vertex", provider_config: {}, settings: {} } })
  const response = await broken.app.fetch(gatewayRequest({ path: "/models/gemini:generateContent", body: { contents: [] } }))
  assert.equal(response.status, 502)
  assert.equal((await readError(response)).code, "provider_misconfigured")
  assert.equal(broken.upstreamRequests.length, 0)
  const row = await waitForRows(broken.logRows)
  assert.equal(row.outcome, "rejected")
  assert.equal(row.error_code, "provider_misconfigured")
})

test("passthrough: GET /models forwarded with query, no body, no usage parsed", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    fetch: async () => Response.json({ object: "list", data: [], usage: { prompt_tokens: 1 } }),
  })
  const response = await app.fetch(gatewayRequest({ path: "/models?limit=5", method: "GET" }))
  assert.equal(response.status, 200)
  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://api.openai.com/v1/models?limit=5")
  assert.equal(upstream.method, "GET")
  assert.equal(upstream.body, null)
  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "passthrough")
  assert.equal(row.usage_source, "missing")
  assert.equal(row.input_tokens, null)
  assert.equal(row.outcome, "ok")
  assert.equal(row.requested_model, null)
})

test("rejects with 404 provider_not_found for another org's provider and unknown ids without logging", async () => {
  const { app, upstreamRequests, logRows, accessChecks } = createTestServer({ provider: { organization_id: "org_other" } })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 404)
  assert.equal((await readError(response)).code, "provider_not_found")

  const unknown = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" }, id: "ipr_missing" }))
  assert.equal(unknown.status, 404)
  assert.equal(upstreamRequests.length, 0)
  assert.equal(accessChecks.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(logRows.length, 0)
})

test("rejects with 403 provider_access_denied and logs a rejected row", async () => {
  const { app, upstreamRequests, logRows, credentialLookups } = createTestServer({ access: false })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 403)
  assert.equal((await readError(response)).code, "provider_access_denied")
  assert.ok(response.headers.get("x-openwork-request-id"))
  assert.equal(upstreamRequests.length, 0)
  assert.equal(credentialLookups.length, 0)
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "rejected")
  assert.equal(row.error_code, "provider_access_denied")
  assert.equal(row.status, 403)
  assert.equal(row.inference_provider_id, providerId)
  assert.equal(row.upstream_host, "api.openai.com")
})

test("member mode without a credential → 401 openwork_auth_required with header", async () => {
  const { app, upstreamRequests, logRows, credentialLookups } = createTestServer({
    provider: { credential_mode: "member" },
    credential: null,
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-openwork-auth-required"), "1")
  const error = await readError(response)
  assert.equal(error.code, "openwork_auth_required")
  assert.equal(error.provider_id, providerId)
  assert.equal(typeof error.message, "string")
  assert.deepEqual(credentialLookups, [{ inferenceProviderId: providerId, subject: memberId }])
  assert.equal(upstreamRequests.length, 0)
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "rejected")
  assert.equal(row.error_code, "member_auth_required")
})

test("member mode with an expired oauth token → 401 openwork_auth_required", async () => {
  const now = new Date("2026-09-03T12:00:00Z")
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { credential_mode: "member" },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "old" }), expires_at: new Date("2026-09-03T11:59:59Z") },
    now,
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-openwork-auth-required"), "1")
  assert.equal((await readError(response)).code, "openwork_auth_required")
  assert.equal(upstreamRequests.length, 0)
  const row = await waitForRows(logRows)
  assert.equal(row.inference_provider_credential_id, credentialId)
  assert.equal(row.started_at.toISOString(), now.toISOString())
})

test("member mode with a valid oauth token forwards it as the bearer", async () => {
  const { app, upstreamRequests } = createTestServer({
    provider: { credential_mode: "member" },
    credential: { kind: "oauth_azure", secret: JSON.stringify({ accessToken: "fresh" }), expires_at: new Date(Date.now() + 60_000) },
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 200)
  assert.equal(upstreamRequests[0]?.headers.get("authorization"), "Bearer fresh")
})

test("org mode without a credential → 502 provider_credential_missing", async () => {
  const { app, logRows } = createTestServer({ credential: null })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 502)
  assert.equal((await readError(response)).code, "provider_credential_missing")
  assert.equal(response.headers.get("x-openwork-auth-required"), null)
  const row = await waitForRows(logRows)
  assert.equal(row.error_code, "provider_credential_missing")
})

test("member oauth_google near expiry is refreshed under the lock and the fresh bearer is forwarded", async () => {
  const now = new Date("2026-09-03T12:00:00Z")
  const refreshCalls: Array<Parameters<RefreshGoogleOauthToken>[0]> = []
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { credential_mode: "member", provider_id: "google-vertex", provider_config: { npm: "@ai-sdk/google-vertex" }, settings: { project: "p", location: "us-central1" }, oauth_client_id: "cid", oauth_client_secret: "csecret" },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "old", refreshToken: "rt" }), expires_at: new Date(now.getTime() + 30_000) },
    now,
    async refreshGoogleOauthToken(input) {
      refreshCalls.push(input)
      return {
        kind: "refreshed",
        credential: { ...input.credential, secret: JSON.stringify({ accessToken: "fresh", refreshToken: "rt" }), expires_at: new Date(now.getTime() + 3600_000) },
      }
    },
  })
  const response = await app.fetch(gatewayRequest({ path: "/v1beta/models/gemini-2.5-pro:generateContent", body: { contents: [] } }))
  assert.equal(response.status, 200)
  assert.equal(upstreamRequests[0]?.headers.get("authorization"), "Bearer fresh")
  assert.equal(refreshCalls.length, 1)
  assert.equal(refreshCalls[0]?.provider.oauth_client_id, "cid")
  assert.equal(refreshCalls[0]?.token.refreshToken, "rt")
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "ok")
  assert.equal(row.inference_provider_credential_id, credentialId)
})

test("member oauth_google with plenty of time left is not refreshed", async () => {
  const { app, upstreamRequests } = createTestServer({
    provider: { credential_mode: "member" },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "current", refreshToken: "rt" }), expires_at: new Date(Date.now() + 10 * 60_000) },
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 200)
  assert.equal(upstreamRequests[0]?.headers.get("authorization"), "Bearer current")
})

test("member oauth_google refresh invalid_grant → 401 openwork_auth_required; stale outcome forwards the old token", async () => {
  const now = new Date("2026-09-03T12:00:00Z")
  const failed = createTestServer({
    provider: { credential_mode: "member" },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "old", refreshToken: "rt" }), expires_at: new Date(now.getTime() - 1000) },
    now,
    refreshGoogleOauthToken: async () => ({ kind: "auth_required" }),
  })
  const response = await failed.app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-openwork-auth-required"), "1")
  const error = await readError(response)
  assert.equal(error.code, "openwork_auth_required")
  assert.match(String(error.message), /refresh_failed/)
  assert.equal(failed.upstreamRequests.length, 0)
  const row = await waitForRows(failed.logRows)
  assert.equal(row.error_code, "member_auth_required")

  const stale = createTestServer({
    provider: { credential_mode: "member" },
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "old", refreshToken: "rt" }), expires_at: new Date(now.getTime() - 1000) },
    now,
    refreshGoogleOauthToken: async () => ({ kind: "stale" }),
    fetch: async () => Response.json({ error: "expired" }, { status: 401 }),
  })
  const staleResponse = await stale.app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(staleResponse.status, 401)
  assert.equal(staleResponse.headers.get("x-openwork-auth-required"), null)
  assert.equal(stale.upstreamRequests[0]?.headers.get("authorization"), "Bearer old")
})

test("org-subject oauth expired → 502 provider_credential_expired, no refresh attempted", async () => {
  const now = new Date("2026-09-03T12:00:00Z")
  const { app, upstreamRequests, logRows } = createTestServer({
    credential: { kind: "oauth_google", secret: JSON.stringify({ accessToken: "old", refreshToken: "rt" }), expires_at: new Date(now.getTime() - 1000) },
    now,
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 502)
  assert.equal((await readError(response)).code, "provider_credential_expired")
  assert.equal(upstreamRequests.length, 0)
  const row = await waitForRows(logRows)
  assert.equal(row.error_code, "provider_credential_expired")
})

test("org gcp_service_account on vertex mints a bearer from the service account", async () => {
  const mintCalls: string[] = []
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { provider_id: "google-vertex", provider_config: { npm: "@ai-sdk/google-vertex" }, settings: { project: "p", location: "us-east1" } },
    credential: { kind: "gcp_service_account", secret: JSON.stringify({ client_email: "a@b", private_key: "k", token_uri: "https://oauth2.googleapis.com/token" }) },
    async mintGcpAccessToken(input) {
      mintCalls.push(`${input.credentialId}:${input.serviceAccount.client_email}`)
      return { kind: "token", accessToken: "ya29.sa" }
    },
  })
  const response = await app.fetch(gatewayRequest({ path: "/models/gemini:generateContent", body: { contents: [] } }))
  assert.equal(response.status, 200)
  assert.deepEqual(mintCalls, [`${credentialId}:a@b`])
  assert.equal(upstreamRequests[0]?.url, "https://us-east1-aiplatform.googleapis.com/v1/projects/p/locations/us-east1/publishers/google/models/gemini:generateContent")
  assert.equal(upstreamRequests[0]?.headers.get("authorization"), "Bearer ya29.sa")
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "ok")

  const broken = createTestServer({
    provider: { provider_id: "google-vertex", provider_config: { npm: "@ai-sdk/google-vertex" }, settings: { project: "p", location: "us-east1" } },
    credential: { kind: "gcp_service_account", secret: JSON.stringify({ client_email: "a@b", private_key: "k", token_uri: "https://oauth2.googleapis.com/token" }) },
    mintGcpAccessToken: async () => ({ kind: "error", message: "token endpoint returned 500" }),
  })
  const brokenResponse = await broken.app.fetch(gatewayRequest({ path: "/models/gemini:generateContent", body: { contents: [] } }))
  assert.equal(brokenResponse.status, 502)
  assert.equal((await readError(brokenResponse)).code, "provider_token_mint_failed")
  assert.equal(broken.upstreamRequests.length, 0)
})

test("bedrock: aws_keys request is SigV4-signed after the body rewrite, host from the credential region, stream usage from event-stream metadata", async () => {
  const now = new Date("2026-09-03T12:00:00Z")
  const { app, upstreamRequests, logRows } = createTestServer({
    provider: { provider_id: "amazon-bedrock", provider_config: { npm: "@ai-sdk/amazon-bedrock" }, settings: { region: "us-east-1" } },
    credential: { kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok", region: "eu-west-1" }) },
    now,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of bedrockStreamFrames) controller.enqueue(frame)
        controller.close()
      },
    }), { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "aws-1" } }),
  })
  const response = await app.fetch(gatewayRequest({
    path: "/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse-stream",
    body: { messages: [{ role: "user", content: [{ text: "hi" }] }] },
    headers: { "x-api-key": "leak" },
  }))
  assert.equal(response.status, 200)
  await response.text()

  const upstream = upstreamRequests[0]
  assert.ok(upstream)
  assert.equal(upstream.url, "https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse-stream")
  assert.equal(upstream.headers.get("x-amz-date"), "20260903T120000Z")
  assert.equal(upstream.headers.get("x-amz-security-token"), "tok")
  assert.equal(upstream.headers.get("x-api-key"), null)
  const authorization = upstream.headers.get("authorization") ?? ""
  assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260903\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-request-id, Signature=[0-9a-f]{64}$/)
  // Re-sign the exact forwarded request locally and compare: proves the
  // signature covers the final (rewritten) body and the region host.
  const { signAwsRequest } = await import("../src/credentials/aws-sigv4.js")
  const check = new Headers()
  for (const name of ["content-type", "x-openwork-request-id"]) check.set(name, upstream.headers.get(name) ?? "")
  signAwsRequest({
    method: "POST",
    url: new URL(upstream.url),
    headers: check,
    body: upstream.body,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" },
    region: "eu-west-1",
    service: "bedrock",
    now,
  })
  assert.equal(check.get("authorization"), authorization)

  const row = await waitForRows(logRows)
  assert.equal(row.protocol, "bedrock_converse")
  assert.equal(row.upstream_host, "bedrock-runtime.eu-west-1.amazonaws.com")
  assert.equal(row.requested_model, "anthropic.claude-3-5-sonnet-20241022-v2:0")
  assert.equal(row.stream, true)
  assert.equal(row.usage_source, "stream")
  assert.equal(row.input_tokens, 12)
  assert.equal(row.output_tokens, 7)
  assert.equal(row.total_tokens, 19)
  assert.equal(row.cache_read_tokens, 4)
  assert.equal(row.cache_write_tokens, 2)
})

test("bedrock: non-stream converse JSON usage; settings.region host; missing region → 502 provider_misconfigured", async () => {
  const ok = createTestServer({
    provider: { provider_id: "amazon-bedrock", provider_config: { npm: "@ai-sdk/amazon-bedrock" }, settings: { region: "us-west-2" } },
    credential: { kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "a", secretAccessKey: "b" }) },
    fetch: async () => Response.json({ output: {}, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }),
  })
  const response = await ok.app.fetch(gatewayRequest({ path: "/model/claude/converse", body: { messages: [] } }))
  assert.equal(response.status, 200)
  assert.equal(ok.upstreamRequests[0]?.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/claude/converse")
  assert.equal(ok.upstreamRequests[0]?.headers.get("x-amz-security-token"), null)
  assert.ok(ok.upstreamRequests[0]?.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=a/"))
  const row = await waitForRows(ok.logRows)
  assert.equal(row.usage_source, "json")
  assert.equal(row.total_tokens, 7)
  assert.equal(row.stream, false)

  const missing = createTestServer({
    provider: { provider_id: "amazon-bedrock", provider_config: { npm: "@ai-sdk/amazon-bedrock" }, settings: {} },
    credential: { kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "a", secretAccessKey: "b" }) },
  })
  const missingResponse = await missing.app.fetch(gatewayRequest({ path: "/model/claude/converse", body: {} }))
  assert.equal(missingResponse.status, 502)
  assert.equal((await readError(missingResponse)).code, "provider_misconfigured")
  assert.equal(missing.upstreamRequests.length, 0)
  const missingRow = await waitForRows(missing.logRows)
  assert.equal(missingRow.error_code, "provider_misconfigured")
  assert.equal(missingRow.inference_provider_credential_id, credentialId)
})

test("aws_keys on a non-bedrock provider → 502 provider_misconfigured", async () => {
  const { app, upstreamRequests } = createTestServer({
    credential: { kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "a", secretAccessKey: "b", region: "us-east-1" }) },
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 502)
  assert.equal((await readError(response)).code, "provider_misconfigured")
  assert.equal(upstreamRequests.length, 0)
})

test("logs upstream_unreachable when fetch throws", async () => {
  const { app, logRows } = createTestServer({
    fetch: async () => {
      throw new Error("ECONNREFUSED")
    },
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 502)
  assert.equal((await readError(response)).code, "upstream_unreachable")
  assert.ok(response.headers.get("x-openwork-request-id"))
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "upstream_unreachable")
})

test("relays upstream errors as-is with our request id and logs upstream_error", async () => {
  const { app, logRows } = createTestServer({
    fetch: async () => Response.json({ error: { message: "bad key" } }, { status: 401, headers: { "x-request-id": "up_401" } }),
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x" } }))
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-openwork-auth-required"), null)
  assert.ok(response.headers.get("x-openwork-request-id"))
  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "upstream_error")
  assert.equal(row.status, 401)
  assert.equal(row.upstream_request_id, "up_401")
})

test("logs client_aborted when the client cancels mid-stream", async () => {
  let upstreamCancelled = false
  const encoder = new TextEncoder()
  const { app, logRows } = createTestServer({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"1","choices":[{"delta":{"content":"partial"}}]}\n\n'))
      },
      cancel() {
        upstreamCancelled = true
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  })
  const response = await app.fetch(gatewayRequest({ path: "/chat/completions", body: { model: "x", stream: true } }))
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(first.done, false)
  await reader.cancel()

  const row = await waitForRows(logRows)
  assert.equal(row.outcome, "client_aborted")
  assert.equal(row.usage_source, "missing")
  assert.ok(row.first_byte_at)
  assert.equal(upstreamCancelled, true)
})

test("streams non-JSON bodies unchanged and reports missing usage when the stream has none", async () => {
  const { app, upstreamRequests, logRows } = createTestServer({
    fetch: async () => sseResponse(['data: {"id":"1","choices":[{"delta":{"content":"x"}}]}\n\n', "data: [DONE]\n\n"]),
  })
  const response = await app.fetch(gatewayRequest({
    path: "/chat/completions",
    method: "POST",
    headers: { "content-type": "text/plain" },
    rawBody: "raw text",
  }))
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(upstreamRequests[0]?.body, "raw text")
  assert.equal(upstreamRequests[0]?.headers.get("content-type"), "text/plain")
  const row = await waitForRows(logRows)
  assert.equal(row.usage_source, "missing")
  assert.equal(row.requested_model, null)
})
