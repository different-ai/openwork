// A Microsoft Foundry provider reaches its own resource host. A saved address
// override is used only on that host or on an origin the operator allowlisted,
// so a member's Entra ID token and the organization's Foundry key go nowhere else.
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
const { createProviderCatalog } = await import("../src/provider-catalog.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const gatewayKeyId = createDenTypeId("gatewayKey")
const providerId = createDenTypeId("inferenceProvider")
const now = new Date("2026-11-13T12:00:00Z")
const model = "claude-sonnet-4-5"
const resourceHost = "https://acme-foundry.services.ai.azure.com"

type Mode = "member" | "org"

const credentials: Record<Mode, GatewayCredential> = {
  member: {
    id: createDenTypeId("inferenceProviderCredential"), kind: "oauth_azure", status: "active",
    expires_at: new Date(now.getTime() + 60 * 60 * 1000),
    secret: JSON.stringify({ accessToken: "entra-member-token-fixture" }),
  },
  org: { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "foundry-org-key-fixture", expires_at: null, status: "active" },
}

function accessRow(mode: Mode): GatewayAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  return {
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: mode === "member" ? "Member sign-in" : "Organization key", credential_mode: mode, oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: {
      id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: model, name: "Claude Sonnet 4.5", created_at: now,
      model_config: { id: model, name: "Claude Sonnet 4.5", tool_call: true, limit: { context: 200_000, output: 8_192 } },
    },
  }
}

function app(settings: Record<string, unknown>, mode: Mode) {
  const sent: Request[] = []
  const row = accessRow(mode)
  const provider: GatewayProvider = {
    id: providerId, organization_id: organizationId, provider_id: "microsoft-foundry", status: "active", settings,
    provider_config: { id: "microsoft-foundry", name: "Microsoft Foundry (Claude)", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_FOUNDRY_API_KEY"] },
  }
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  registerGatewayRoutes(api, {
    fetch: async (input, init) => {
      sent.push(new Request(input, init))
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } })
    },
    insertRequestLog: async () => {},
    updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => null,
    loadGatewayProvider: async () => provider,
    loadGatewayAccess: async () => [row],
    loadProviderCredential: async () => credentials[mode],
    catalog: createProviderCatalog({ "microsoft-foundry": { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_FOUNDRY_API_KEY"] } }),
    now: () => now,
  })
  const send = () => api.request(`${gatewayPathPrefix}/${providerId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  })
  return { sent, send }
}

async function withAllowedOrigins<T>(origins: string, run: () => Promise<T>) {
  const previous = process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
  process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = origins
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
    else process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = previous
  }
}

test("a member's Entra ID token goes to the provider's own Foundry resource", async () => {
  const { sent, send } = app({ resourceName: "acme-foundry" }, "member")
  assert.equal((await send()).status, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, `${resourceHost}/anthropic/v1/messages`)
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer entra-member-token-fixture")
})

for (const mode of ["member", "org"] as const) {
  test(`a Foundry address override on another host is refused before any ${mode} credential is sent`, async () => {
    for (const upstreamBaseUrl of ["https://foundry-proxy.example/anthropic/v1", "https://acme-foundry.services.ai.azure.com.example/anthropic/v1", "https://other-resource.services.ai.azure.com/anthropic/v1"]) {
      const { sent, send } = app({ resourceName: "acme-foundry", upstreamBaseUrl }, mode)
      const response = await send()
      assert.equal(response.status, 502, upstreamBaseUrl)
      assert.equal(sent.length, 0, upstreamBaseUrl)
      assert.doesNotMatch(await response.text(), /entra-member-token-fixture|foundry-org-key-fixture/)
    }
  })
}

test("a Foundry address override on the resource's own host is used", async () => {
  const { sent, send } = app({ resourceName: "Acme-Foundry", upstreamBaseUrl: `${resourceHost}/anthropic/v1` }, "member")
  assert.equal((await send()).status, 200)
  assert.equal(sent[0]?.url, `${resourceHost}/anthropic/v1/messages`)
  assert.equal(sent[0]?.headers.get("authorization"), "Bearer entra-member-token-fixture")
})

test("a Foundry address override on an operator-allowlisted origin is used", async () => {
  await withAllowedOrigins("https://foundry-proxy.example", async () => {
    const member = app({ resourceName: "acme-foundry", upstreamBaseUrl: "https://foundry-proxy.example/anthropic/v1" }, "member")
    assert.equal((await member.send()).status, 200)
    assert.equal(member.sent[0]?.url, "https://foundry-proxy.example/anthropic/v1/messages")
    const org = app({ resourceName: "acme-foundry", upstreamBaseUrl: "https://foundry-proxy.example/anthropic/v1" }, "org")
    assert.equal((await org.send()).status, 200)
    assert.equal(org.sent[0]?.headers.get("api-key"), "foundry-org-key-fixture")
  })
})
