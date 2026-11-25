// A request never fails because it asked a model for more output than the model allows:
// the cap is lowered to the known limit, and a cap the provider still refuses is retried once.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { GatewayAccessRow } from "../src/provider-access.js"
import type { GatewayCredential, GatewayProvider } from "../src/provider-credentials.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes, gatewayPathPrefix } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("@openwork-ee/gateway-catalog")
const { createLearnedOutputLimits, fitOutputCap, modelOutputLimit, rejectedOutputCap, relaxOutputCap, requestedOutputCap } = await import("@openwork-ee/gateway-protocols")

const OPENAI_REFUSAL = { error: { message: "max_tokens is too large: 32000. This model supports at most 16384 completion tokens, whereas you provided 32000.", type: "invalid_request_error", param: "max_tokens", code: "invalid_value" } }
const ANTHROPIC_REFUSAL = { type: "error", error: { type: "invalid_request_error", message: "max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-haiku-20241022" } }
const CONTEXT_REFUSAL = { object: "error", message: "'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 8192 tokens and your request has 512 input tokens.", code: 400 }

test("each protocol's cap is read and lowered where it lives", () => {
  const chat = { max_tokens: 32_000, max_completion_tokens: 20_000 }
  assert.equal(requestedOutputCap(chat, "openai_chat"), 32_000)
  assert.equal(fitOutputCap(chat, "openai_chat", 16_384), true)
  assert.deepEqual(chat, { max_tokens: 16_384, max_completion_tokens: 16_384 })

  const responses = { max_output_tokens: 32_000 }
  assert.equal(fitOutputCap(responses, "openai_responses", 4_096), true)
  assert.deepEqual(responses, { max_output_tokens: 4_096 })

  const google = { generationConfig: { maxOutputTokens: 32_000, temperature: 0 } }
  assert.equal(fitOutputCap(google, "google_generate_content", 8_192), true)
  assert.deepEqual(google, { generationConfig: { maxOutputTokens: 8_192, temperature: 0 } })

  const bedrock = { inferenceConfig: { maxTokens: 32_000 } }
  assert.equal(fitOutputCap(bedrock, "bedrock_converse", 4_096), true)
  assert.deepEqual(bedrock, { inferenceConfig: { maxTokens: 4_096 } })
})

test("a cap is never raised, added, or touched without a known limit", () => {
  const small = { max_tokens: 100 }
  assert.equal(fitOutputCap(small, "openai_chat", 16_384), false)
  assert.deepEqual(small, { max_tokens: 100 })
  const none = { messages: [] }
  assert.equal(fitOutputCap(none, "openai_chat", 16_384), false)
  assert.deepEqual(none, { messages: [] })
  const unknown = { max_tokens: 32_000 }
  assert.equal(fitOutputCap(unknown, "openai_chat", null), false)
  assert.equal(fitOutputCap({ max_tokens: 32_000 }, "passthrough", 10), false)
  assert.equal(modelOutputLimit({ limit: { context: 128_000, output: 16_384 } }), 16_384)
  assert.equal(modelOutputLimit({ id: "alias" }), null)
})

test("a provider's refusal of the cap is recognised, with the limit it named", () => {
  assert.deepEqual(rejectedOutputCap(400, JSON.stringify(OPENAI_REFUSAL), 32_000), { limit: 16_384 })
  assert.deepEqual(rejectedOutputCap(400, JSON.stringify(ANTHROPIC_REFUSAL), 32_000), { limit: 8_192 })
  assert.deepEqual(rejectedOutputCap(400, "The maximum tokens you requested exceeds the model limit of 4096.", 32_000), { limit: 4_096 })
  // The room left in a context window depends on the prompt: nothing to remember.
  assert.deepEqual(rejectedOutputCap(400, JSON.stringify(CONTEXT_REFUSAL), 32_000), { limit: null })
  assert.equal(rejectedOutputCap(400, JSON.stringify({ error: { message: "Invalid value for 'temperature'." } }), 32_000), null)
  assert.equal(rejectedOutputCap(429, JSON.stringify(OPENAI_REFUSAL), 32_000), null)
  assert.equal(rejectedOutputCap(500, JSON.stringify(OPENAI_REFUSAL), 32_000), null)
})

test("a refused cap takes the named limit, else is removed where the protocol allows", () => {
  const named = { max_tokens: 32_000 }
  assert.equal(relaxOutputCap(named, "openai_chat", 16_384), true)
  assert.deepEqual(named, { max_tokens: 16_384 })
  const unnamed = { max_tokens: 32_000, max_completion_tokens: 32_000, model: "m" }
  assert.equal(relaxOutputCap(unnamed, "openai_chat", null), true)
  assert.deepEqual(unnamed, { model: "m" })
  // Anthropic Messages requires a cap.
  const anthropic = { max_tokens: 32_000 }
  assert.equal(relaxOutputCap(anthropic, "anthropic_messages", null), false)
  assert.deepEqual(anthropic, { max_tokens: 32_000 })
})

test("a learned limit expires and the oldest leave first", () => {
  const learned = createLearnedOutputLimits({ capacity: 2, ttlMs: 1000 })
  learned.learn("a", 100, 0)
  learned.learn("b", 200, 0)
  learned.learn("c", 300, 0)
  assert.equal(learned.get("a", 1), null)
  assert.equal(learned.get("b", 1), 200)
  assert.equal(learned.get("c", 999), 300)
  assert.equal(learned.get("c", 1000), null)
})

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const providerId = createDenTypeId("inferenceProvider")
const now = new Date("2026-11-18T12:00:00Z")

const provider: GatewayProvider = {
  id: providerId, organization_id: organizationId, provider_id: "openwork-custom", status: "active",
  provider_config: { id: "openwork-custom", name: "Acme AI", npm: "@ai-sdk/openai-compatible", env: ["OPENWORK_CUSTOM_API_KEY"] },
  settings: { upstreamBaseUrl: "https://api.acme.example/v1" },
}
const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-custom-fixture-0000000", expires_at: null, status: "active" }

function accessRow(limit: { context: number; output: number } | null): GatewayAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  return {
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: { id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: "acme-large", name: "Acme Large", created_at: now,
      model_config: { id: "acme-large", name: "Acme Large", ...(limit ? { limit } : {}) } },
  }
}

const OK = { id: "chatcmpl-1", object: "chat.completion", model: "acme-large", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }

/** A provider that refuses any cap above `realLimit` the way `refusal` words it. */
function app(input: { savedLimit: number | null; realLimit: number; refusal: unknown }) {
  const sent: Array<Record<string, unknown>> = []
  const row = accessRow(input.savedLimit === null ? null : { context: 128_000, output: input.savedLimit })
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId: createDenTypeId("gatewayKey") })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  registerGatewayRoutes(api, {
    fetch: async (target, init) => {
      const body: unknown = await new Request(target, init).json()
      assert.ok(typeof body === "object" && body !== null)
      sent.push({ ...body })
      const cap = Reflect.get(body, "max_tokens")
      return typeof cap === "number" && cap > input.realLimit ? Response.json(input.refusal, { status: 400 }) : Response.json(OK)
    },
    insertRequestLog: async () => {},
    updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => null,
    loadGatewayProvider: async () => provider,
    loadGatewayAccess: async () => [row],
    loadProviderCredential: async () => credential,
    catalog: createProviderCatalog({}),
    now: () => now,
  })
  const send = (maxTokens: number | null) => api.request(`${gatewayPathPrefix}/${providerId}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "acme-large", messages: [{ role: "user", content: "hi" }], ...(maxTokens === null ? {} : { max_tokens: maxTokens }) }),
  })
  return { sent, send }
}

test("a cap above the model's saved limit is lowered before the provider sees it", async () => {
  const { sent, send } = app({ savedLimit: 16_384, realLimit: 16_384, refusal: OPENAI_REFUSAL })
  assert.equal((await send(32_000)).status, 200)
  assert.deepEqual(sent.map((body) => body.max_tokens), [16_384])
})

test("a smaller cap, or none, is forwarded as sent", async () => {
  const { sent, send } = app({ savedLimit: 16_384, realLimit: 16_384, refusal: OPENAI_REFUSAL })
  assert.equal((await send(500)).status, 200)
  assert.equal((await send(null)).status, 200)
  assert.deepEqual(sent.map((body) => body.max_tokens), [500, undefined])
})

test("a model with no saved limit recovers from the provider's refusal and remembers the limit", async () => {
  const { sent, send } = app({ savedLimit: null, realLimit: 16_384, refusal: OPENAI_REFUSAL })
  const first = await send(32_000)
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), OK)
  assert.deepEqual(sent.map((body) => body.max_tokens), [32_000, 16_384])
  // The next request is right the first time.
  assert.equal((await send(32_000)).status, 200)
  assert.deepEqual(sent.map((body) => body.max_tokens), [32_000, 16_384, 16_384])
})

test("a saved limit that is too high is corrected by the provider's answer", async () => {
  const { sent, send } = app({ savedLimit: 16_384, realLimit: 8_192, refusal: ANTHROPIC_REFUSAL })
  assert.equal((await send(32_000)).status, 200)
  assert.deepEqual(sent.map((body) => body.max_tokens), [16_384, 8_192])
})

test("a refusal that names no limit is retried without a cap", async () => {
  const { sent, send } = app({ savedLimit: null, realLimit: 7_000, refusal: CONTEXT_REFUSAL })
  assert.equal((await send(32_000)).status, 200)
  assert.deepEqual(sent.map((body) => body.max_tokens), [32_000, undefined])
})

test("any other refusal reaches the caller unchanged, with no second attempt", async () => {
  const refusal = { error: { message: "Invalid value for 'temperature'.", type: "invalid_request_error" } }
  const { sent, send } = app({ savedLimit: null, realLimit: 0, refusal })
  const response = await send(32_000)
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), refusal)
  assert.equal(sent.length, 1)
})
