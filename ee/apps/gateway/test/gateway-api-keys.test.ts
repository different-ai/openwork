// AI Gateway API keys for 3rd party tools: a member's own key
// authenticates as that member, and its requests are logged against the key that made them.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createGatewayBearerKey } from "@openwork-ee/utils/gateway-bearer-key"
import type { ActiveGatewayKey } from "../src/keys.js"
import type { InferenceAuthEnv } from "../src/middleware/inference-auth.js"
import type { GatewayRequestLogRow } from "../src/request-log.js"
import type { InferenceReporter } from "../src/inference-reporting.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { gatewayAuth, gatewayContextFor } = await import("../src/middleware/gateway-auth.js")
const { createRequestLogRecorder } = await import("../src/request-log.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const apiKey: ActiveGatewayKey = { source: "api_key", id: createDenTypeId("gatewayApiKey"), organization_id: organizationId, org_membership_id: orgMembershipId, lastUsedAt: null }
const memberKey: ActiveGatewayKey = { source: "member", id: createDenTypeId("gatewayKey"), organization_id: organizationId, org_membership_id: orgMembershipId }

function authApp(found: ActiveGatewayKey | null) {
  const app = new Hono<InferenceAuthEnv>()
  app.use("*", gatewayAuth({ findActiveGatewayKey: async () => found }))
  app.get("/whoami", (c) => c.json(c.get("inference")))
  return app
}

test("a member's own API key authenticates as that member, marked as an API key", async () => {
  const response = await authApp(apiKey).request("/whoami", { headers: { "x-api-key": createGatewayBearerKey().value } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { kind: "gateway", organizationId, orgMembershipId, keySource: "api_key", gatewayKeyId: apiKey.id })
})

test("OpenWork's own member key keeps its identity", () => {
  assert.deepEqual(gatewayContextFor(memberKey), { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId: memberKey.id })
})

test("a key the lookup refuses (revoked, or member keys turned off) is a 401", async () => {
  const response = await authApp(null).request("/whoami", { headers: { authorization: `Bearer ${createGatewayBearerKey().value}` } })
  assert.equal(response.status, 401)
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_api_key")
})

const reporter: InferenceReporter = { request: () => undefined, handledError: () => undefined }

async function loggedRow(key: ActiveGatewayKey): Promise<GatewayRequestLogRow> {
  const rows: GatewayRequestLogRow[] = []
  const recorder = createRequestLogRecorder({ insertRequestLog: async (row) => { rows.push(row) }, reporter })
  recorder.start({
    identity: gatewayContextFor(key),
    openworkRequestId: "req_fixture",
    route: "org_provider",
    protocol: "openai_chat",
    upstreamProviderId: "openai",
    upstreamHost: "api.openai.com",
    upstreamPath: "/v1/chat/completions",
    method: "POST",
    requestedModel: null,
    upstreamModel: null,
    stream: false,
  })
  await recorder.whenStarted?.()
  const [row] = rows
  assert.ok(row)
  return row
}

test("requests made with an API key are logged against that key, not OpenWork's member key", async () => {
  const row = await loggedRow(apiKey)
  assert.equal(row.gateway_api_key_id, apiKey.id)
  assert.equal(row.gateway_key_id, null)
  assert.equal(row.org_membership_id, orgMembershipId)

  const member = await loggedRow(memberKey)
  assert.equal(member.gateway_key_id, memberKey.id)
  assert.equal(member.gateway_api_key_id, null)
})
