import assert from "node:assert/strict"
import { test } from "node:test"
import { providerCheckSchema } from "@openwork/types/den/diagnostics"
import { InferenceEgressError } from "@openwork-ee/utils/inference-egress"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-diagnostics-provider-test-key-0000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-diagnostics-provider-test-secret-00"
process.env.DEN_BASE_URL ??= "https://console.example.test"
const {
  buildGatewayProviderTargets,
  buildLegacyProviderTargets,
  evaluateProviderTargets,
  openWorkModelsTarget,
  runProviderProbe,
} = await import("../src/diagnostics/provider-checks.js")
type GatewayProviderInput = Parameters<typeof buildGatewayProviderTargets>[0]["providers"][number]
type GatewayCredentialInput = Parameters<typeof buildGatewayProviderTargets>[0]["credentials"][number]

const SECRET = "sk-diagnostics-fixture-secret-0001"
const NOW = Date.parse("2026-10-20T12:00:00.000Z")
const UPDATED = new Date(NOW - 86_400_000)
const COMPLETION_PATHS = [/\/chat\/completions/, /\/messages/, /\/responses/, /:generateContent/, /:streamGenerateContent/, /\/converse/]

type Reply = { status: number; body?: unknown }
function fakeFetch(route: (url: URL, init: RequestInit | undefined) => Reply | Promise<Reply>) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) })
    const reply = await route(new URL(url), init)
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } })
  }
  return { fetchImpl, calls }
}

let sequence = 0
function provider(input: Partial<GatewayProviderInput> & Pick<GatewayProviderInput, "provider_id" | "provider_config">): GatewayProviderInput {
  sequence += 1
  return { id: `ipr_fixture${sequence}`, name: input.provider_id, model_ids: [], settings: {}, status: "active", updated_at: UPDATED, ...input }
}
function set(providerId: string, mode: "org" | "member" = "org", name = "Default") {
  sequence += 1
  return { id: `gcs_fixture${sequence}`, gateway_provider_id: providerId, name, credential_mode: mode, status: "active" }
}
function orgCredential(providerId: string, setId: string, input: Partial<GatewayCredentialInput> = {}): GatewayCredentialInput {
  return {
    gateway_provider_id: providerId, credential_set_id: setId, subject: "org", org_membership_id: null, kind: "api_key",
    status: "active", expires_at: null, last_error: null, updated_at: UPDATED, secret: SECRET, ...input,
  }
}
function memberCredential(providerId: string, setId: string, memberId: string, input: Partial<GatewayCredentialInput> = {}): GatewayCredentialInput {
  return { ...orgCredential(providerId, setId), subject: memberId, org_membership_id: memberId, kind: "oauth_azure", secret: null, ...input }
}
function models(providerId: string, ids: string[]) {
  return ids.map((model_id) => ({ gateway_provider_id: providerId, model_id }))
}

function assertNoCompletions(calls: ReadonlyArray<{ url: string }>) {
  for (const call of calls) {
    for (const pattern of COMPLETION_PATHS) assert.doesNotMatch(new URL(call.url).pathname, pattern, `never a model request: ${call.url}`)
  }
}

test("each provider kind maps to a read-only listing, key check, or no live check — never a completion", async () => {
  const openai = provider({ provider_id: "openai", provider_config: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] } })
  const anthropic = provider({ provider_id: "anthropic", provider_config: { npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] } })
  const google = provider({ provider_id: "google", provider_config: { npm: "@ai-sdk/google", env: ["GOOGLE_GENERATIVE_AI_API_KEY"] } })
  const azure = provider({ provider_id: "azure", provider_config: { npm: "@ai-sdk/azure", env: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME"] }, settings: { resourceName: "fixture-resource" } })
  const bedrock = provider({ provider_id: "amazon-bedrock", provider_config: { npm: "@ai-sdk/amazon-bedrock", env: ["AWS_ACCESS_KEY_ID"] } })
  const vertex = provider({ provider_id: "google-vertex", provider_config: { npm: "@ai-sdk/google-vertex", env: [] } })
  const foundry = provider({ provider_id: "microsoft-foundry", provider_config: { npm: "@ai-sdk/anthropic", env: [] } })
  const litellmSet = set("pending")
  const litellm = provider({
    provider_id: "litellm",
    provider_config: { npm: "@ai-sdk/openai-compatible", env: ["LITELLM_API_KEY"] },
    settings: {
      upstreamBaseUrl: "https://litellm.example.com",
      litellm: { version: 1, mode: "org", credentialSetId: litellmSet.id, catalog: [], teams: [], groups: {}, members: {}, lastSyncedAt: null, lastSyncError: null },
    },
  })
  litellmSet.gateway_provider_id = litellm.id
  const sets = [openai, anthropic, google, azure, bedrock, vertex, foundry].map((entry) => set(entry.id))
  const memberSet = set(openai.id, "member", "Personal keys")
  const [openaiSet, anthropicSet, googleSet, azureSet, bedrockSet, vertexSet, foundrySet] = sets
  const credentials: GatewayCredentialInput[] = [
    orgCredential(openai.id, openaiSet.id),
    orgCredential(anthropic.id, anthropicSet.id),
    orgCredential(google.id, googleSet.id, { kind: "api_key_map", secret: JSON.stringify({ GOOGLE_GENERATIVE_AI_API_KEY: SECRET }) }),
    orgCredential(azure.id, azureSet.id, { kind: "api_key_map", secret: JSON.stringify({ AZURE_API_KEY: SECRET, AZURE_RESOURCE_NAME: "fixture-resource" }) }),
    orgCredential(bedrock.id, bedrockSet.id, { kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "AKIAFIXTURE0000000000", secretAccessKey: SECRET, region: "us-east-1" }) }),
    orgCredential(vertex.id, vertexSet.id, { kind: "gcp_service_account", secret: JSON.stringify({ client_email: "fixture@example.iam.gserviceaccount.com", private_key: SECRET, token_uri: "https://oauth2.googleapis.com/token" }) }),
    orgCredential(foundry.id, foundrySet.id),
    orgCredential(litellm.id, litellmSet.id),
    memberCredential(openai.id, memberSet.id, "om_member1", { kind: "api_key", expires_at: null }),
    memberCredential(openai.id, memberSet.id, "om_member2", { kind: "oauth_google", expires_at: new Date(NOW - 60_000) }),
    memberCredential(openai.id, memberSet.id, "om_member3", { status: "refresh_failed" }),
    memberCredential(openai.id, memberSet.id, "om_member4", { status: "revoked" }),
  ]
  const targets = buildGatewayProviderTargets({
    providers: [openai, anthropic, google, azure, bedrock, vertex, foundry, litellm],
    sets: [...sets, memberSet, litellmSet],
    credentials,
    models: [
      ...models(openai.id, ["gpt-a", "gpt-b", "gpt-retired"]),
      ...models(anthropic.id, ["claude-fixture"]),
      ...models(google.id, ["gemini-fixture"]),
      ...models(azure.id, ["gpt-4o", "gpt-4.1"]),
      ...models(litellm.id, ["team-model"]),
    ],
    now: NOW,
  })
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.hostname === "api.openai.com" && url.pathname === "/v1/models") return { status: 200, body: { data: [{ id: "gpt-a" }, { id: "gpt-b" }] } }
    if (url.hostname === "api.anthropic.com") return { status: 401, body: { error: { message: `bad key ${SECRET}` } } }
    if (url.hostname === "generativelanguage.googleapis.com") return { status: 200, body: { models: [{ name: "models/gemini-fixture" }] } }
    if (url.hostname === "fixture-resource.openai.azure.com" && url.pathname === "/openai/models") return { status: 200, body: { data: [{ id: "gpt-4o" }] } }
    if (url.hostname === "fixture-resource.openai.azure.com" && url.pathname === "/openai/deployments") return { status: 200, body: { data: [{ id: "fixture-deployment" }] } }
    if (url.hostname === "sts.us-east-1.amazonaws.com") return { status: 200, body: { GetCallerIdentityResponse: { GetCallerIdentityResult: { Arn: "arn:aws:iam::123456789012:user/fixture", Account: "123456789012" } } } }
    if (url.hostname === "litellm.example.com" && url.pathname === "/v1/models") return { status: 200, body: { data: [{ id: "team-model" }, { id: "openai/*" }] } }
    return { status: 500 }
  })
  const results = await evaluateProviderTargets([openWorkModelsTarget(), ...targets], { live: true, deps: { fetchImpl, now: () => NOW } })
  const byName = new Map(results.map((result) => [`${result.check.providerId}${result.check.credentialName ? `:${result.check.credentialName}` : ""}`, result.check]))
  for (const result of results) providerCheckSchema.parse(result.check)

  assert.equal(byName.get("openwork")?.state, "managed")
  assert.equal(byName.get("openwork")?.reason, "managed_by_openwork")

  const openaiCheck = byName.get("openai:Default")
  assert.equal(openaiCheck?.state, "model_missing")
  assert.deepEqual(openaiCheck?.models, { configured: 3, served: 2, missing: ["gpt-retired"] })
  assert.equal(openaiCheck?.httpStatus, 200)
  assert.equal(openaiCheck?.lastSuccessAt, new Date(NOW).toISOString())

  const memberCheck = byName.get("openai:Personal keys")
  assert.equal(memberCheck?.state, "member_credentials")
  assert.equal(memberCheck?.reason, "member_sign_in")
  assert.deepEqual(memberCheck?.members, { connected: 2, needsAttention: 1 }, "OAuth expiry refreshes on use; revoked rows are gone")

  assert.equal(byName.get("anthropic")?.state, "key_rejected")
  assert.equal(byName.get("anthropic")?.reason, "credential_rejected")
  assert.equal(byName.get("anthropic")?.httpStatus, 401)
  assert.equal(byName.get("anthropic")?.lastSuccessAt, null)

  assert.equal(byName.get("google")?.state, "ready", "models/ prefix is stripped before comparing")
  assert.deepEqual(byName.get("google")?.models, { configured: 1, served: 1, missing: [] })

  assert.equal(byName.get("azure")?.state, "ready", "Azure lists deployment names: no model comparison")
  assert.deepEqual(byName.get("azure")?.models.missing, [])

  assert.equal(byName.get("amazon-bedrock")?.state, "ready")
  assert.equal(byName.get("amazon-bedrock")?.reason, "key_accepted")
  assert.equal(byName.get("amazon-bedrock")?.models.served, null)

  for (const id of ["google-vertex", "microsoft-foundry"]) {
    assert.equal(byName.get(id)?.state, "not_checked", id)
    assert.equal(byName.get(id)?.reason, "no_live_check", id)
  }
  assert.equal(byName.get("litellm")?.state, "ready")
  assert.equal(byName.get("litellm")?.models.served, 1, "wildcard routes are not models")

  assertNoCompletions(calls)
  assert.ok(calls.every((call) => call.method === "GET" || call.url.startsWith("https://sts.")), "listings are GETs; only STS GetCallerIdentity posts")
  assert.ok(!calls.some((call) => call.headers.get("authorization")?.includes("member")), "never a member credential")
  assert.equal(calls.find((call) => call.url.startsWith("https://api.anthropic.com"))?.headers.get("anthropic-version"), "2023-06-01")
  assert.equal(calls.find((call) => call.url.startsWith("https://generativelanguage"))?.headers.get("x-goog-api-key"), SECRET)
  assert.ok(!JSON.stringify(results).includes(SECRET), "results never carry credentials or upstream bodies")
  assert.ok(!JSON.stringify(results).includes("api.openai.com"), "results never carry upstream URLs")
})

test("stored facts decide rows without any network, and live: false never fetches", async () => {
  const openai = provider({ provider_id: "openai", provider_config: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] } })
  const missing = set(openai.id, "org", "Missing")
  const failed = set(openai.id, "org", "Failed refresh")
  const expired = set(openai.id, "org", "Expired")
  const fine = set(openai.id, "org", "Fine")
  const templated = provider({ provider_id: "openai-compatible", provider_config: { npm: "@ai-sdk/openai-compatible", env: ["API_KEY"], api: "https://${HOST}/v1" } })
  const templatedSet = set(templated.id)
  const targets = buildGatewayProviderTargets({
    providers: [openai, templated, provider({ provider_id: "openai", provider_config: {}, status: "disabled" })],
    sets: [missing, failed, expired, fine, templatedSet],
    credentials: [
      orgCredential(openai.id, failed.id, { status: "refresh_failed" }),
      orgCredential(openai.id, expired.id, { expires_at: new Date(NOW - 1) }),
      orgCredential(openai.id, fine.id),
      orgCredential(templated.id, templatedSet.id),
    ],
    models: [],
    now: NOW,
  })
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }))
  const results = await evaluateProviderTargets(targets, { live: false, deps: { fetchImpl, now: () => NOW } })
  assert.equal(calls.length, 0)
  const state = (name: string) => results.find((result) => result.check.credentialName === name)?.check
  assert.deepEqual([state("Missing")?.state, state("Missing")?.reason], ["misconfigured", "credential_missing"])
  assert.deepEqual([state("Failed refresh")?.state, state("Failed refresh")?.reason], ["key_rejected", "credential_rejected"])
  assert.deepEqual([state("Expired")?.state, state("Expired")?.reason], ["key_rejected", "credential_expired"])
  assert.deepEqual([state("Fine")?.state, state("Fine")?.reason, state("Fine")?.checkedAt], ["not_checked", "not_checked_yet", null])
  assert.equal(results.find((result) => result.check.providerId === "openai-compatible")?.check.state, "misconfigured", "unresolved templates are a configuration error")
  assert.equal(results.length, 5, "disabled providers have no row")
  assert.ok(results.filter((result) => result.probed).every((result) => result.check.credentialName === "Fine"))
})

test("failures map to fixed states: 404, network, timeout and refused egress", async () => {
  const spec = { kind: "openai" as const, baseUrl: "https://llm.example.com/v1", apiKey: SECRET }
  const refusal = { state: "misconfigured" as const, reason: "configuration_error" as const }
  const notFound = await runProviderProbe(spec, refusal, { fetchImpl: fakeFetch(() => ({ status: 404 })).fetchImpl })
  assert.deepEqual([notFound.state, notFound.reason, notFound.httpStatus], ["misconfigured", "endpoint_not_found", 404])
  const unavailable = await runProviderProbe({ ...spec, kind: "anthropic" }, refusal, { fetchImpl: fakeFetch(() => ({ status: 503 })).fetchImpl })
  assert.deepEqual([unavailable.state, unavailable.reason, unavailable.httpStatus], ["unreachable", "unexpected_response", 503])
  const googleKey = await runProviderProbe({ ...spec, kind: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, refusal, { fetchImpl: fakeFetch(() => ({ status: 400 })).fetchImpl })
  assert.deepEqual([googleKey.state, googleKey.reason], ["key_rejected", "credential_rejected"], "Google answers a bad key with 400")
  const network = await runProviderProbe(spec, refusal, { fetchImpl: async () => { throw new TypeError("fetch failed") } })
  assert.deepEqual([network.state, network.reason, network.httpStatus], ["unreachable", "network_error", null])
  const refused = await runProviderProbe(spec, refusal, { fetchImpl: async () => { throw new InferenceEgressError() } })
  assert.deepEqual([refused.state, refused.reason], ["misconfigured", "configuration_error"])
  const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
  })
  for (const kind of ["openai", "litellm", "anthropic"] as const) {
    const timedOut = await runProviderProbe({ ...spec, kind }, refusal, { fetchImpl: hanging, timeoutMs: 30 })
    assert.deepEqual([timedOut.state, timedOut.reason], ["unreachable", "timeout"], kind)
  }
  const sts = await runProviderProbe({ kind: "aws_sts", region: "us-east-1", credentials: { accessKeyId: "AKIAFIXTURE0000000000", secretAccessKey: SECRET } }, refusal, { fetchImpl: fakeFetch(() => ({ status: 403 })).fetchImpl })
  assert.deepEqual([sts.state, sts.reason, sts.httpStatus], ["key_rejected", "credential_rejected", 403])
})

test("model comparison skips empty listings and per-person LiteLLM keeps member state", async () => {
  const litellmSet = set("pending", "member")
  const litellm = provider({
    provider_id: "litellm",
    provider_config: { npm: "@ai-sdk/openai-compatible", env: ["LITELLM_API_KEY"] },
    settings: {
      upstreamBaseUrl: "https://litellm.example.com/v1",
      litellm: { version: 1, mode: "member", credentialSetId: litellmSet.id, catalog: [], teams: [], groups: {}, members: {}, lastSyncedAt: null, lastSyncError: "LiteLLM returned HTTP 500." },
    },
  })
  litellmSet.gateway_provider_id = litellm.id
  const targets = buildGatewayProviderTargets({
    providers: [litellm],
    sets: [litellmSet],
    credentials: [
      orgCredential(litellm.id, litellmSet.id, { subject: "litellm_admin" }),
      memberCredential(litellm.id, litellmSet.id, "om_member1", { kind: "api_key" }),
      memberCredential(litellm.id, litellmSet.id, "om_member2", { kind: "api_key", expires_at: new Date(NOW - 1) }),
    ],
    models: models(litellm.id, ["a", "b"]),
    now: NOW,
  })
  const stored = await evaluateProviderTargets(targets, { live: false, deps: { fetchImpl: fakeFetch(() => ({ status: 500 })).fetchImpl, now: () => NOW } })
  assert.deepEqual([stored[0].check.state, stored[0].check.reason], ["misconfigured", "sync_error"])
  assert.deepEqual(stored[0].check.members, { connected: 1, needsAttention: 1 })
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [] } }))
  const live = await evaluateProviderTargets(targets, { live: true, deps: { fetchImpl, now: () => NOW } })
  assert.deepEqual([live[0].check.state, live[0].check.reason], ["member_credentials", "member_sign_in"])
  assert.equal(calls.length, 1, "only the organization-held admin key is used")
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${SECRET}`)
})

test("legacy providers: custom shared keys are listed, per-person providers are never probed", async () => {
  const targets = buildLegacyProviderTargets({
    providers: [
      { id: "lpr_custom", source: "custom", providerId: "fixture-gateway", name: "Fixture gateway", providerConfig: { api: "https://llm.example.com/v1" }, credentialMode: "shared", apiKey: SECRET, updatedAt: UPDATED },
      { id: "lpr_private", source: "custom", providerId: "fixture-private", name: "Private gateway", providerConfig: { api: "http://10.0.0.5/v1" }, credentialMode: "shared", apiKey: SECRET, updatedAt: UPDATED },
      { id: "lpr_people", source: "models_dev", providerId: "anthropic", name: "Anthropic", providerConfig: {}, credentialMode: "per_member", apiKey: null, updatedAt: UPDATED },
      { id: "lpr_openwork", source: "openwork", providerId: "openwork", name: "OpenWork", providerConfig: {}, credentialMode: "shared", apiKey: null, updatedAt: UPDATED },
    ],
    memberCredentials: [
      { llmProviderId: "lpr_people", orgMembershipId: "om_a", state: "active" },
      { llmProviderId: "lpr_people", orgMembershipId: "om_b", state: "error" },
      { llmProviderId: "lpr_people", orgMembershipId: "om_c", state: "blocked" },
    ],
    models: [{ llmProviderId: "lpr_custom", modelId: "fixture-model" }],
  })
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: [{ id: "fixture-model" }] } }))
  const results = await evaluateProviderTargets(targets, { live: true, deps: { fetchImpl, now: () => NOW } })
  assert.deepEqual(results.map((result) => [result.check.id, result.check.state]), [
    ["lpr_custom", "ready"],
    ["lpr_private", "not_checked"],
    ["lpr_people", "member_credentials"],
  ])
  assert.equal(results[1].check.reason, "no_live_check", "Den does not probe endpoints only the desktop reaches")
  assert.deepEqual(results[2].check.members, { connected: 1, needsAttention: 1 })
  assert.deepEqual(calls.map((call) => call.url), ["https://llm.example.com/v1/models"])
})
