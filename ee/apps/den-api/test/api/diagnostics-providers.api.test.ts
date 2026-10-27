import assert from "node:assert/strict"
import { after, test } from "node:test"
import { orgDiagnosticsSchema, type OrgDiagnostics } from "@openwork/types/den/diagnostics"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, startFakeHttpServer, summary, type Session } from "./harness.js"

const ORG_SECRET = "sk-diagnostics-org-fixture-secret-0001"
const MEMBER_SECRET = "sk-diagnostics-member-fixture-secret-0002"
const upstreamRequests: Array<{ method: string; path: string; authorization: string }> = []
const upstream = await startFakeHttpServer((request, _body, response) => {
  upstreamRequests.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization ?? "" })
  if (request.method === "GET" && request.url === "/v1/models" && request.headers.authorization === `Bearer ${ORG_SECRET}`) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-served" }] }))
    return
  }
  response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `upstream-body-marker ${request.headers.authorization}` } }))
})
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "https://gateway.example.test", GATEWAY_PUBLIC_BASE_URL: "https://gateway.example.test",
  // The operator approves this private upstream for inference egress, as a self-hosted deployment would.
  GATEWAY_EGRESS_ALLOWED_ORIGINS: upstream.url,
} })
after(async () => { await den.close(); await upstream.close() })
const { db } = await import("../../src/db.js")
const { GatewayCredentialSetTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderTable } = await import("@openwork-ee/den-db/schema")

/** ARRANGE ONLY: a Gateway provider with one credential set, as the provider screens would save it. */
async function arrangeProvider(input: { orgId: string; creatorMemberId: string; name: string; mode: "org" | "member"; credentials: Array<{ subject: string; memberId: string | null; secret: string; status?: "active" | "refresh_failed" }>; models: string[] }) {
  const organizationId = normalizeDenTypeId("organization", input.orgId)
  const creator = normalizeDenTypeId("member", input.creatorMemberId)
  const providerId = createDenTypeId("inferenceProvider")
  const setId = createDenTypeId("gatewayCredentialSet")
  await db.insert(GatewayProviderTable).values({
    id: providerId, organization_id: organizationId, created_by_org_membership_id: creator, provider_id: "openai-compatible", name: input.name,
    model_ids: [], pinned_model_ids: [], provider_config: { npm: "@ai-sdk/openai-compatible", env: ["OPENAI_COMPATIBLE_API_KEY"], api: `${upstream.url}/v1` },
    settings: {}, credential_mode: input.mode, status: "active",
  })
  await db.insert(GatewayCredentialSetTable).values({ id: setId, gateway_provider_id: providerId, created_by_org_membership_id: creator, name: "Default", credential_mode: input.mode, status: "active" })
  for (const credential of input.credentials) {
    await db.insert(GatewayProviderCredentialTable).values({
      id: createDenTypeId("inferenceProviderCredential"), gateway_provider_id: providerId, credential_set_id: setId, organization_id: organizationId,
      subject: credential.subject, org_membership_id: credential.memberId ? normalizeDenTypeId("member", credential.memberId) : null,
      kind: "api_key", secret: credential.secret, status: credential.status ?? "active",
    })
  }
  for (const model of input.models) {
    await db.insert(GatewayProviderModelTable).values({ id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: model, name: model, model_config: {} })
  }
  return providerId
}

async function read(person: Session, orgId: string, path = "/v1/org/diagnostics") {
  return den.as(person, orgId)("GET", path)
}

test("real MySQL: providers use stored facts at once, then one background listing with the organization key — never a completion or a member key", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Provider Diagnostics Owner"), "Provider diagnostics org")
  const member = await den.newMember(owner, orgId, "Provider Diagnostics Member")
  const listed = await arrangeProvider({ orgId, creatorMemberId: owner.memberId, name: "Fixture listing", mode: "org", credentials: [{ subject: "org", memberId: null, secret: ORG_SECRET }], models: ["fixture-served", "fixture-retired"] })
  await arrangeProvider({ orgId, creatorMemberId: owner.memberId, name: "Fixture refused", mode: "org", credentials: [{ subject: "org", memberId: null, secret: ORG_SECRET, status: "refresh_failed" }], models: [] })
  await arrangeProvider({ orgId, creatorMemberId: owner.memberId, name: "Fixture personal", mode: "member", credentials: [{ subject: member.memberId, memberId: member.memberId, secret: MEMBER_SECRET }], models: [] })

  const first = await read(owner, orgId)
  assert.equal(first.status, 200, summary(first))
  const initial = orgDiagnosticsSchema.parse(first.body)
  assert.equal(initial.providers.access, "granted")
  if (initial.providers.access !== "granted") return
  const byName = (body: OrgDiagnostics) => new Map(body.providers.access === "granted" ? body.providers.items.map((item) => [item.name, item]) : [])
  assert.deepEqual([byName(initial).get("Fixture listing")?.state, byName(initial).get("Fixture listing")?.reason], ["not_checked", "not_checked_yet"])
  assert.deepEqual([byName(initial).get("Fixture refused")?.state, byName(initial).get("Fixture refused")?.reason], ["key_rejected", "credential_rejected"], "stored facts need no network")
  assert.deepEqual(byName(initial).get("Fixture personal")?.members, { connected: 1, needsAttention: 0 })
  assert.equal(initial.checking, true, "the first read starts a background check and does not wait for it")
  assert.ok(initial.attention.some((item) => item.code === "provider_key_rejected" && item.subject === "Fixture refused"))
  assert.equal((await read(owner, orgId, "/v1/org/diagnostics?strict=1")).status, 503)

  let settled: OrgDiagnostics | null = null
  for (let attempt = 0; attempt < 100 && !settled; attempt++) {
    const body = orgDiagnosticsSchema.parse((await read(owner, orgId)).body)
    if (!body.checking) settled = body
    else await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(settled, "background check finished")
  const checked = byName(settled).get("Fixture listing")
  assert.deepEqual([checked?.state, checked?.reason, checked?.httpStatus], ["model_missing", "models_listed", 200])
  assert.deepEqual(checked?.models, { configured: 2, served: 1, missing: ["fixture-retired"] })
  assert.equal(checked?.id.startsWith(listed), true)
  assert.ok(checked?.lastSuccessAt)
  const warning = settled.attention.find((item) => item.code === "provider_model_missing")
  assert.deepEqual([warning?.severity, warning?.count, warning?.detail], ["warning", 1, "fixture-retired"])

  assert.deepEqual(upstreamRequests, [{ method: "GET", path: "/v1/models", authorization: `Bearer ${ORG_SECRET}` }], "one listing, one organization key, nothing else")
  const text = JSON.stringify(settled)
  for (const secret of [ORG_SECRET, MEMBER_SECRET, upstream.url, "upstream-body-marker"]) assert.ok(!text.includes(secret), `never returned: ${secret}`)

  const limited = await den.as(owner, orgId)("POST", "/v1/org/diagnostics/check")
  assert.equal(limited.status, 429, summary(limited))
  assert.equal(upstreamRequests.length, 1, "a rate-limited check never reaches the provider")

  const plain = orgDiagnosticsSchema.parse((await read(member, orgId)).body)
  assert.deepEqual(plain.providers, { access: "locked", permission: "gateway_providers.view" })
  assert.equal(plain.attention.length, 0)
  assert.equal((await read(member, orgId, "/v1/org/diagnostics?strict=1")).status, 200, "strict reflects only what the caller can see")
})
