// A provider the Gateway cannot reach is answered to the caller in plain words,
// recorded in the request log, and never reported to Sentry as a Gateway error.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { GatewayAccessRow } from "../src/provider-access.js"
import type { GatewayCredential, GatewayProvider } from "../src/provider-credentials.js"
import type { GatewayRequestLogRow } from "../src/request-log.js"
import type { InferenceHandledErrorReport } from "../src/inference-reporting.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes, gatewayPathPrefix } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("@openwork-ee/gateway-catalog")
const { describeUpstreamFetchFailure } = await import("../src/relay.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const gatewayKeyId = createDenTypeId("gatewayKey")
const providerId = createDenTypeId("inferenceProvider")
const now = new Date("2026-11-16T12:00:00Z")

const provider: GatewayProvider = {
  id: providerId,
  organization_id: organizationId,
  provider_id: "openwork-custom",
  provider_config: { id: "openwork-custom", name: "Acme AI", npm: "@ai-sdk/openai-compatible", env: ["OPENWORK_CUSTOM_API_KEY"] },
  settings: { upstreamBaseUrl: "https://api.acme.example/v1" },
  status: "active",
}

function accessRow(): GatewayAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  return {
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: { id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: "acme-large", name: "Acme Large", created_at: now, model_config: { id: "acme-large", name: "Acme Large" } },
  }
}

const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-custom-fixture-0000000", expires_at: null, status: "active" }

function fetchFailed(code: string) {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code }) })
}

test("an unreachable provider is answered in plain words and not reported as a Gateway error", async () => {
  const reported: InferenceHandledErrorReport[] = []
  const logs: GatewayRequestLogRow[] = []
  const row = accessRow()
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  registerGatewayRoutes(api, {
    fetch: async () => { throw fetchFailed("ECONNRESET") },
    insertRequestLog: async (log) => { logs.push(log) },
    updateRequestLog: async (log) => { logs.push(log); return true },
    reporter: { request: () => {}, handledError: (report) => { reported.push(report) } },
    checkUsage: async () => null,
    loadGatewayProvider: async () => provider,
    loadGatewayAccess: async () => [row],
    loadProviderCredential: async () => credential,
    catalog: createProviderCatalog({}),
    now: () => now,
  })

  const response = await api.request(`${gatewayPathPrefix}/${providerId}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "acme-large", messages: [{ role: "user", content: "hi" }] }),
  })

  assert.equal(response.status, 502)
  assert.equal(response.headers.get("x-openwork-request-id"), "owr_fixture")
  const body: unknown = await response.json()
  const error: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "error") : undefined
  assert.ok(typeof error === "object" && error !== null)
  assert.equal(Reflect.get(error, "code"), "upstream_unreachable")
  assert.equal(Reflect.get(error, "message"), "Couldn't reach the model provider at api.acme.example: the connection was dropped. Your work is preserved; try again in a moment.")
  assert.deepEqual(reported, [])
  for (let attempt = 0; attempt < 50 && !logs.some((log) => log.completed_at); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  const finished = logs.find((log) => log.completed_at)
  assert.equal(finished?.outcome, "upstream_unreachable")
  assert.equal(finished?.error_code, "upstream_unreachable")
})

test("fetch failures are described by what happened", () => {
  const target = "the model provider"
  assert.deepEqual(describeUpstreamFetchFailure(fetchFailed("ENOTFOUND"), { clientAborted: false, timedOut: false, target }), {
    outcome: "upstream_unreachable", status: 502, code: "upstream_unreachable", cause: "ENOTFOUND",
    message: "Couldn't reach the model provider: its address could not be found. Your work is preserved; try again in a moment.",
  })
  const unknown = describeUpstreamFetchFailure(new TypeError("fetch failed"), { clientAborted: false, timedOut: false, target })
  assert.equal(unknown.message, "Couldn't reach the model provider. Your work is preserved; try again in a moment.")
  assert.equal(unknown.cause, "TypeError")
  const timeout = describeUpstreamFetchFailure(new DOMException("aborted", "AbortError"), { clientAborted: false, timedOut: true, target })
  assert.equal(timeout.status, 504)
  assert.equal(timeout.code, "upstream_timeout")
  const cancelled = describeUpstreamFetchFailure(new DOMException("aborted", "AbortError"), { clientAborted: true, timedOut: false, target })
  assert.equal(cancelled.outcome, "client_aborted")
  assert.equal(cancelled.code, "request_cancelled")
})
