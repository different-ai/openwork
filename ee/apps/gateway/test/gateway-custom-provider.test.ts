// Forwarding for custom OpenAI-compatible providers:
// the saved address is the only upstream, it is re-checked on every request,
// and usage is priced from the saved model's cost when it has one.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { GatewayAccessRow } from "../src/provider-access.js"
import type { GatewayCredential, GatewayProvider } from "../src/provider-credentials.js"
import type { GatewayRequestLogRow } from "../src/request-log.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes, gatewayPathPrefix } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("../src/provider-catalog.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const gatewayKeyId = createDenTypeId("gatewayKey")
const providerId = createDenTypeId("inferenceProvider")
const now = new Date("2026-11-05T12:00:00Z")

function provider(settings: Record<string, unknown>): GatewayProvider {
  return {
    id: providerId,
    organization_id: organizationId,
    provider_id: "openwork-custom",
    provider_config: { id: "openwork-custom", name: "Acme AI", npm: "@ai-sdk/openai-compatible", env: ["OPENWORK_CUSTOM_API_KEY"], api: "https://catalog-api.example/v1" },
    settings,
    status: "active",
  }
}

function accessRow(cost: Record<string, number> | null): GatewayAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  return {
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: {
      id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: "acme-large", name: "Acme Large", created_at: now,
      model_config: { id: "acme-large", name: "Acme Large", tool_call: true, limit: { context: 128_000, output: 8_192 }, ...(cost ? { cost } : {}) },
    },
  }
}

const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-custom-fixture-0000000", expires_at: null, status: "active" }

type Harness = { sent: Request[]; logs: GatewayRequestLogRow[]; priced: (boolean | undefined)[] }

function app(settings: Record<string, unknown>, cost: Record<string, number> | null = null) {
  const harness: Harness = { sent: [], logs: [], priced: [] }
  const row = accessRow(cost)
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  registerGatewayRoutes(api, {
    fetch: async (input, init) => {
      harness.sent.push(new Request(input, init))
      return Response.json({ id: "chatcmpl-1", object: "chat.completion", model: "acme-large", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } })
    },
    insertRequestLog: async (log) => { harness.logs.push(log) },
    updateRequestLog: async (log) => { harness.logs.push(log); return true },
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async (input) => { harness.priced.push(input.priced); return null },
    loadGatewayProvider: async () => provider(settings),
    loadGatewayAccess: async () => [row],
    loadProviderCredential: async () => credential,
    // A models.dev entry under the reserved id must not give custom rows an address.
    catalog: createProviderCatalog({ "openwork-custom": { npm: "@ai-sdk/openai-compatible", api: "https://models-dev.example/v1", env: [] } }),
    now: () => now,
  })
  const send = () => api.request(`${gatewayPathPrefix}/${providerId}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "acme-large", messages: [{ role: "user", content: "hi" }] }),
  })
  return { harness, send }
}

async function settled(harness: Harness) {
  for (let attempt = 0; attempt < 50 && !harness.logs.some((log) => log.status !== undefined && log.status !== null); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  return harness.logs.find((log) => log.status !== undefined && log.status !== null)
}

test("a custom provider forwards to its saved address with its own key", async () => {
  const { harness, send } = app({ upstreamBaseUrl: "https://api.acme.example/v1" })
  const response = await send()
  assert.equal(response.status, 200)
  assert.equal(harness.sent.length, 1)
  assert.equal(harness.sent[0]?.url, "https://api.acme.example/v1/chat/completions")
  assert.equal(harness.sent[0]?.headers.get("authorization"), "Bearer sk-custom-fixture-0000000")
  const body: unknown = await harness.sent[0]?.json()
  assert.ok(typeof body === "object" && body !== null && Reflect.get(body, "model") === "acme-large")
})

test("a custom provider without a saved address never falls back to a catalog or config address", async () => {
  const { harness, send } = app({})
  const response = await send()
  assert.equal(response.status, 502)
  assert.equal(harness.sent.length, 0)
})

test("a custom provider's saved address is re-checked on every request", async () => {
  for (const upstreamBaseUrl of ["http://api.acme.example/v1", "https://127.0.0.1/v1", "https://10.0.0.5/v1", "https://localhost/v1"]) {
    const { harness, send } = app({ upstreamBaseUrl })
    const response = await send()
    assert.equal(response.status, 502, upstreamBaseUrl)
    assert.equal(harness.sent.length, 0, upstreamBaseUrl)
  }
  const previous = process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
  process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = "http://127.0.0.1:4100"
  try {
    const { harness, send } = app({ upstreamBaseUrl: "http://127.0.0.1:4100/v1" })
    assert.equal((await send()).status, 200)
    assert.equal(harness.sent[0]?.url, "http://127.0.0.1:4100/v1/chat/completions")
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
    else process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = previous
  }
})

test("custom model usage is priced from the saved model's cost", async () => {
  const { harness, send } = app({ upstreamBaseUrl: "https://api.acme.example/v1" }, { input: 2, output: 8 })
  await (await send()).text()
  const log = await settled(harness)
  assert.deepEqual(harness.priced, [true])
  // 1000 input tokens at $2/M + 500 output tokens at $8/M = $0.006.
  assert.equal(log?.cost_micro_usd, 6000)
  assert.equal(log?.input_tokens, 1000)
})

test("custom model usage without a cost is recorded unpriced", async () => {
  const { harness, send } = app({ upstreamBaseUrl: "https://api.acme.example/v1" })
  await (await send()).text()
  const log = await settled(harness)
  assert.deepEqual(harness.priced, [false])
  assert.equal(log?.cost_micro_usd, null)
  assert.equal(log?.input_tokens, 1000)
})
