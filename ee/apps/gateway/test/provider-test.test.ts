import assert from "node:assert/strict"
import { test } from "node:test"
import { createProviderCatalog } from "../src/provider-catalog.js"
import { Hono } from "hono"
import { signProviderTest } from "@openwork-ee/utils/provider-test-signature"
import { registerProviderTestRoute, runProviderTest } from "../src/provider-test.js"
import type { ProviderTestDependencies, ProviderTestEnv } from "../src/provider-test.js"

const catalog = createProviderCatalog({
  "google-vertex": { npm: "@ai-sdk/google-vertex", env: [] },
  "google-vertex-anthropic": { npm: "@ai-sdk/google-vertex/anthropic", env: [] },
  anthropic: { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
  openai: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] },
  "amazon-bedrock": { npm: "@ai-sdk/amazon-bedrock", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
})

type Sent = { url: string; headers: Headers; body: unknown }

function dependencies(respond: (sent: Sent) => Response, sent: Sent[] = []): ProviderTestDependencies {
  return {
    catalog,
    signingSecret: "fixture-shared-secret-0000000000000000",
    now: () => new Date("2026-10-27T12:00:00Z"),
    mintGcpAccessToken: async () => ({ kind: "error", message: "unused" }),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const entry = { url: request.url, headers: request.headers, body: JSON.parse(await request.text()) }
      sent.push(entry)
      return respond(entry)
    },
  }
}

test("a working Anthropic key sends one short prompt to the chosen model", async () => {
  const sent: Sent[] = []
  const result = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: {}, credential: { kind: "api_key", secret: "sk-ant-fixture-key-000000" } },
    dependencies(() => Response.json({ content: [{ type: "text", text: "OK" }] }), sent))
  assert.deepEqual(result, { ok: true, model: "claude-sonnet-5", status: 200, code: null, message: null })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages")
  assert.equal(sent[0]?.headers.get("x-api-key"), "sk-ant-fixture-key-000000")
  assert.equal(sent[0]?.headers.get("anthropic-version"), "2023-06-01")
  assert.deepEqual(sent[0]?.body, { model: "claude-sonnet-5", max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] })
})

test("OpenAI is tested through the Responses API with a bearer key", async () => {
  const sent: Sent[] = []
  await runProviderTest({ providerId: "openai", model: "gpt-6-luna", settings: {}, credential: { kind: "api_key", secret: "sk-openai-fixture-0000" } },
    dependencies(() => Response.json({ output: [] }), sent))
  assert.equal(sent[0]?.url, "https://api.openai.com/v1/responses")
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer sk-openai-fixture-0000")
})

test("a rejected key fails with a plain message and never echoes the key", async () => {
  const secret = "sk-ant-fixture-key-000000"
  const result = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: {}, credential: { kind: "api_key", secret } },
    dependencies(() => Response.json({ error: { message: `invalid x-api-key ${secret}` } }, { status: 401 })))
  assert.equal(result.ok, false)
  assert.equal(result.code, "provider_authentication_failed")
  assert.equal(result.status, 401)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test("a missing model includes the provider's reason without the key", async () => {
  const secret = "sk-openai-fixture-0000"
  const result = await runProviderTest({ providerId: "openai", model: "gpt-unknown", settings: {}, credential: { kind: "api_key", secret } },
    dependencies(() => Response.json({ error: { message: `The model gpt-unknown does not exist (key ${secret})` } }, { status: 404 })))
  assert.equal(result.code, "model_not_found")
  assert.match(result.message ?? "", /gpt-unknown does not exist/)
  assert.doesNotMatch(result.message ?? "", new RegExp(secret))
})

test("Bedrock keys are signed for the region and AWS error bodies are never read", async () => {
  const sent: Sent[] = []
  const secret = JSON.stringify({ accessKeyId: "AKIAFIXTURE000000000", secretAccessKey: "fixture-secret-access-key" })
  const result = await runProviderTest({ providerId: "amazon-bedrock", model: "anthropic.claude-sonnet-5", settings: { region: "us-west-2" }, credential: { kind: "aws_keys", secret } },
    dependencies(() => Response.json({ message: "signature mismatch: x-amz-security-token=leak" }, { status: 403 }), sent))
  assert.equal(sent[0]?.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-5/converse")
  assert.match(sent[0]?.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE000000000\/20261027\/us-west-2\/bedrock\//)
  assert.equal(result.code, "provider_permission_denied")
  assert.doesNotMatch(JSON.stringify(result), /leak/)
})

test("an unreachable provider and an unknown provider fail without calling out", async () => {
  const unreachable = await runProviderTest({ providerId: "openai", model: "gpt-6-luna", settings: {}, credential: { kind: "api_key", secret: "sk-openai-fixture-0000" } },
    { ...dependencies(() => new Response(null)), fetch: async () => { throw new TypeError("fetch failed") } })
  assert.equal(unreachable.code, "upstream_unreachable")
  const sent: Sent[] = []
  const unknown = await runProviderTest({ providerId: "not-a-provider", model: "x", settings: {}, credential: { kind: "api_key", secret: "sk-fixture-000000" } }, dependencies(() => new Response(null), sent))
  assert.equal(unknown.code, "unsupported_provider")
  assert.equal(sent.length, 0)
})

test("a custom provider address is only tested when the operator allowlisted it", async () => {
  const credential = { kind: "api_key" as const, secret: "sk-ant-fixture-key-000000" }
  const sent: Sent[] = []
  const refused = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: { upstreamBaseUrl: "https://attacker.example/v1" }, credential }, dependencies(() => Response.json({}), sent))
  assert.equal(refused.code, "invalid_settings")
  assert.equal(sent.length, 0)
  const previous = process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
  process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = "http://127.0.0.1:4100"
  try {
    const allowed = await runProviderTest({ providerId: "anthropic", model: "claude-sonnet-5", settings: { upstreamBaseUrl: "http://127.0.0.1:4100/v1" }, credential }, dependencies(() => Response.json({}), sent))
    assert.equal(allowed.ok, true)
    assert.equal(sent[0]?.url, "http://127.0.0.1:4100/v1/messages")
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
    else process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = previous
  }
})

function routeApp(deps: ProviderTestDependencies) {
  const app = new Hono<ProviderTestEnv>()
  app.use("*", async (c, next) => {
    const identity: ProviderTestEnv["Variables"]["inference"] = { kind: "gateway", organizationId: "org_fixture", orgMembershipId: "om_fixture", gatewayKeyId: "gky_fixture" }
    c.set("inference", identity)
    await next()
  })
  registerProviderTestRoute(app, deps)
  return app
}

test("the gateway serves a test only when Den signed this exact request for this member", async () => {
  const sent: Sent[] = []
  const deps = dependencies(() => Response.json({}), sent)
  const app = routeApp(deps)
  const body = JSON.stringify({ providerId: "anthropic", model: "claude-sonnet-5", settings: {}, credential: { kind: "api_key", secret: "sk-ant-fixture-key-000000" } })
  const now = deps.now().getTime()
  const post = (signature: string | null, payload = body) => app.request("/api/v1/provider-tests", { method: "POST", body: payload, headers: signature ? { "x-openwork-provider-test-signature": signature } : {} })
  assert.equal((await post(null)).status, 403)
  assert.equal((await post(signProviderTest("fixture-shared-secret-0000000000000000", { organizationId: "org_fixture", memberId: "someone_else", body }, now))).status, 403)
  const swapped = body.replace("claude-sonnet-5", "claude-opus-5")
  assert.equal((await post(signProviderTest("fixture-shared-secret-0000000000000000", { organizationId: "org_fixture", memberId: "om_fixture", body }, now), swapped)).status, 403)
  assert.equal((await post(signProviderTest("fixture-shared-secret-0000000000000000", { organizationId: "org_fixture", memberId: "om_fixture", body }, now - 120_000))).status, 403)
  assert.equal(sent.length, 0)
  const signed = await post(signProviderTest("fixture-shared-secret-0000000000000000", { organizationId: "org_fixture", memberId: "om_fixture", body }, now))
  assert.equal(signed.status, 200)
  assert.equal(sent.length, 1)
})

for (const location of ["eu", "us"]) {
  for (const providerId of ["google-vertex", "google-vertex-anthropic"]) {
    test(`${providerId} tests service-account credentials through the ${location} multi-region endpoint`, async () => {
      const sent: Sent[] = []
      const anthropic = providerId === "google-vertex-anthropic"
      const publisher = anthropic ? "anthropic" : "google"
      const model = anthropic ? "claude-opus-5-5" : "gemini-4-argon"
      const result = await runProviderTest({
        providerId, model, settings: { project: "example-project", location },
        credential: { kind: "gcp_service_account", secret: JSON.stringify({
          client_email: "inference@example-project.iam.gserviceaccount.com",
          private_key: "fixture-private-key", token_uri: "https://oauth2.googleapis.com/token",
        }) },
      }, {
        ...dependencies(() => Response.json({}), sent),
        mintGcpAccessToken: async () => ({ kind: "token", accessToken: "fixture-google-access-token" }),
      })
      assert.equal(result.ok, true)
      assert.equal(sent.length, 1)
      assert.equal(sent[0]?.url, `https://aiplatform.${location}.rep.googleapis.com/v1/projects/example-project/locations/${location}/publishers/${publisher}/models/${model}:${anthropic ? "rawPredict" : "generateContent"}`)
      assert.equal(sent[0]?.headers.get("authorization"), "Bearer fixture-google-access-token")
      assert.deepEqual(sent[0]?.body, anthropic
        ? { max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }], anthropic_version: "vertex-2023-10-16" }
        : { contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }], generationConfig: { maxOutputTokens: 16 } })
    })
  }
}

// --- Custom OpenAI-compatible providers (feature gatewayCustomProviders) ---

const customModel = {
  id: "acme-large", attachment: false, reasoning: false, tool_call: true, structured_output: true, temperature: true,
  modalities: { input: ["text" as const], output: ["text" as const] }, limit: { context: 128_000, output: 8_192 },
}
const customKey = { kind: "api_key" as const, secret: "sk-custom-fixture-0000000" }

function customDependencies(respond: (sent: Sent) => Response, sent: Sent[] = [], addresses = [{ address: "93.184.216.34", family: 4 }]): ProviderTestDependencies {
  return { ...dependencies(respond, sent), resolveHost: async () => addresses }
}

async function withAllowedOrigins<T>(value: string, run: () => Promise<T>) {
  const previous = process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
  process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = value
  try { return await run() } finally {
    if (previous === undefined) delete process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
    else process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = previous
  }
}

test("a custom provider is tested at its public HTTPS address through chat completions", async () => {
  const sent: Sent[] = []
  const result = await runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl: "https://api.acme.example/v1/chat/completions/" }, credential: customKey, customModel },
    customDependencies(() => Response.json({ choices: [] }), sent))
  assert.deepEqual(result, { ok: true, model: "acme-large", status: 200, code: null, message: null })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, "https://api.acme.example/v1/chat/completions")
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer sk-custom-fixture-0000000")
  assert.deepEqual(sent[0]?.body, {
    model: "acme-large", max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }],
    tools: [{ type: "function", function: { name: "noop", description: "Does nothing. Do not call it.", parameters: { type: "object", properties: {} } } }],
  })
})

test("a custom provider never reaches a private, loopback or plain-HTTP address unless the operator allowed it", async () => {
  for (const upstreamBaseUrl of ["http://127.0.0.1:4100/v1", "https://127.0.0.1/v1", "https://10.0.0.5/v1", "https://localhost/v1", "http://api.acme.example/v1", "https://[::1]/v1"]) {
    const sent: Sent[] = []
    const result = await runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl }, credential: customKey }, customDependencies(() => Response.json({}), sent))
    assert.equal(result.code, "address_not_allowed", upstreamBaseUrl)
    assert.match(result.message ?? "", /public HTTPS/)
    assert.equal(sent.length, 0)
  }
  const sent: Sent[] = []
  const internal = await runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl: "https://llm.internal.example/v1" }, credential: customKey },
    customDependencies(() => Response.json({}), sent, [{ address: "10.1.2.3", family: 4 }]))
  assert.equal(internal.code, "address_not_allowed")
  const missing = await runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl: "https://nowhere.example/v1" }, credential: customKey },
    { ...customDependencies(() => Response.json({}), sent), resolveHost: async () => { throw new Error("ENOTFOUND") } })
  assert.equal(missing.code, "upstream_unreachable")
  const noAddress = await runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: {}, credential: customKey }, customDependencies(() => Response.json({}), sent))
  assert.equal(noAddress.code, "invalid_settings")
  assert.equal(sent.length, 0)
})

test("an operator-allowlisted origin can host a custom provider", async () => {
  const sent: Sent[] = []
  const result = await withAllowedOrigins("http://127.0.0.1:4100", () =>
    runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl: "http://127.0.0.1:4100/v1" }, credential: customKey }, customDependencies(() => Response.json({}), sent)))
  assert.equal(result.ok, true)
  assert.equal(sent[0]?.url, "http://127.0.0.1:4100/v1/chat/completions")
})

test("catalog providers still refuse a public address the operator didn't allow", async () => {
  const sent: Sent[] = []
  const refused = await runProviderTest({ providerId: "openai", model: "gpt-6-luna", settings: { upstreamBaseUrl: "https://api.acme.example/v1" }, credential: { kind: "api_key", secret: "sk-openai-fixture-0000" } },
    customDependencies(() => Response.json({}), sent))
  assert.equal(refused.code, "invalid_settings")
  const withModel = await runProviderTest({ providerId: "openai", model: "acme-large", settings: {}, credential: { kind: "api_key", secret: "sk-openai-fixture-0000" }, customModel },
    customDependencies(() => Response.json({}), sent))
  assert.equal(withModel.code, "invalid_request")
  assert.equal(sent.length, 0)
})

test("custom provider failures name the cause so Den can send the admin to the right step", async () => {
  const run = (respond: () => Response, model = "acme-large") => runProviderTest({ providerId: "openwork-custom", model, settings: { upstreamBaseUrl: "https://api.acme.example/v1" }, credential: customKey, customModel: { ...customModel, id: model } },
    customDependencies(respond))
  assert.equal((await run(() => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }))).code, "provider_authentication_failed")
  assert.equal((await run(() => Response.json({ error: { message: "Forbidden" } }, { status: 403 }))).code, "provider_permission_denied")
  assert.equal((await run(() => Response.json({ error: { message: "The model `acme-large` does not exist" } }, { status: 404 }))).code, "model_not_found")
  assert.equal((await run(() => Response.json({ error: { message: "model acme-large not found" } }, { status: 400 }))).code, "model_not_found")
  assert.equal((await run(() => new Response("<html>Not Found</html>", { status: 404 }))).code, "endpoint_not_found")
  const tools = await run(() => Response.json({ error: { message: "Unsupported parameter: 'tools' is not supported with this model." } }, { status: 400 }))
  assert.equal(tools.code, "unsupported_parameter")
  assert.equal(tools.status, 400)
  assert.equal((await run(() => Response.json({ error: { message: "Insufficient balance" } }, { status: 402 }))).code, "insufficient_credit")
  assert.equal((await run(() => Response.json({ error: { message: "slow down" } }, { status: 429 }))).code, "rate_limited")
  assert.equal((await run(() => Response.json({}, { status: 503 }))).code, "upstream_error")
  const unreachable = await runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl: "https://api.acme.example/v1" }, credential: customKey },
    { ...customDependencies(() => new Response(null)), fetch: async () => { throw new TypeError("fetch failed") } })
  assert.equal(unreachable.code, "upstream_unreachable")
  const mismatched = await runProviderTest({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl: "https://api.acme.example/v1" }, credential: customKey, customModel: { ...customModel, id: "other" } },
    customDependencies(() => Response.json({})))
  assert.equal(mismatched.code, "invalid_request")
})

test("a custom reasoning model that refuses max_tokens is retried once with max_completion_tokens", async () => {
  const sent: Sent[] = []
  const result = await runProviderTest({ providerId: "openwork-custom", model: "acme-think", settings: { upstreamBaseUrl: "https://api.acme.example/v1" }, credential: customKey },
    customDependencies((entry) => isRecordWith(entry.body, "max_tokens")
      ? Response.json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, { status: 400 })
      : Response.json({ choices: [] }), sent))
  assert.equal(result.ok, true)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1]?.body, { model: "acme-think", messages: [{ role: "user", content: "Reply with the single word OK." }], max_completion_tokens: 16 })
})

function isRecordWith(value: unknown, key: string) {
  return typeof value === "object" && value !== null && key in value
}

test("the signed route accepts a custom provider test with its model settings", async () => {
  const sent: Sent[] = []
  const deps = customDependencies(() => Response.json({}), sent)
  const app = routeApp(deps)
  const body = JSON.stringify({ providerId: "openwork-custom", model: "acme-large", settings: { upstreamBaseUrl: "https://api.acme.example/v1" }, credential: customKey, customModel })
  const signature = signProviderTest("fixture-shared-secret-0000000000000000", { organizationId: "org_fixture", memberId: "om_fixture", body }, deps.now().getTime())
  const response = await app.request("/api/v1/provider-tests", { method: "POST", body, headers: { "x-openwork-provider-test-signature": signature } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, model: "acme-large", status: 200, code: null, message: null })
  assert.equal(sent[0]?.url, "https://api.acme.example/v1/chat/completions")
})
