import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { autoRouterModelId } from "@openwork/types/den/auto-router"
import { claudeCodeModelName, cursorModelName } from "@openwork/types/den/gateway-cursor"
import { signAwsRequest, signProviderTest } from "@openwork-ee/gateway-upstreams"
import type { GatewayCredential, GatewayProvider } from "../src/provider-credentials.js"
import type { GatewayMemberAccessRow } from "../src/provider-access.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"
import type { ProviderTestDependencies, ProviderTestEnv } from "../src/provider-test.js"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes, gatewayPathPrefix } = await import("../src/gateway.js")
const { registerProviderTestRoute, runProviderTest } = await import("../src/provider-test.js")
const { createProviderCatalog } = await import("@openwork-ee/gateway-catalog")
const { createMemoryReasoningStore, encodeEventStreamFrame, readEventStreamFrames } = await import("@openwork-ee/gateway-protocols")

const now = new Date("2026-11-10T12:00:00Z")
const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const providerId = createDenTypeId("inferenceProvider")
const routerId = createDenTypeId("autoRouter")
const upstreamModel = "fixture.text-model-v1"
const awsKeys = { accessKeyId: "AKIAFIXTURE000000000", secretAccessKey: "fixture-secret-access-key" }
const guardrail = { guardrailIdentifier: "fixtureguardrail", guardrailVersion: "3" }
const catalog = createProviderCatalog({
  "amazon-bedrock": { npm: "@ai-sdk/amazon-bedrock", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
  "amazon-bedrock-mantle": { npm: "@ai-sdk/amazon-bedrock/mantle", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
})
const credential: GatewayCredential = {
  id: createDenTypeId("inferenceProviderCredential"), kind: "aws_keys", secret: JSON.stringify(awsKeys), expires_at: null, status: "active",
}

type Sent = { url: string; headers: Headers; body: string }
type Options = { enabled?: boolean; policyUnavailable?: boolean; settings?: Record<string, unknown>; mantle?: boolean; credential?: GatewayCredential; respond?: (entry: Sent, attempt: number) => Response }

function eventResponse(events: Array<{ type: string; payload: Record<string, unknown> }>) {
  const frames = events.map(({ type, payload }) => encodeEventStreamFrame(new Map([
    [":message-type", "event"], [":event-type", type], [":content-type", "application/json"],
  ]), new TextEncoder().encode(JSON.stringify(payload))))
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        // Split headers and payloads to exercise the real streaming boundary.
        for (let offset = 0; offset < frame.length; offset += 17) controller.enqueue(frame.slice(offset, offset + 17))
      }
      controller.close()
    },
  }), { headers: { "content-type": "application/vnd.amazon.eventstream" } })
}

function successfulResponse(stream: boolean) {
  if (stream) return eventResponse([
    { type: "messageStart", payload: { role: "assistant" } },
    { type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { text: "OK" } } },
    { type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
    { type: "messageStop", payload: { stopReason: "end_turn" } },
    { type: "metadata", payload: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
  ])
  return Response.json({ output: { message: { role: "assistant", content: [{ text: "OK" }] } }, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
}

function accessRow(mantle: boolean): GatewayMemberAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  return {
    provider: { id: providerId, provider_id: mantle ? "amazon-bedrock-mantle" : "amazon-bedrock", name: "Amazon Bedrock", litellmKeySource: null },
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: {
      id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: upstreamModel, name: "Fixture Model", created_at: now,
      model_config: { id: upstreamModel, name: "Fixture Model", tool_call: true, reasoning: false, limit: { context: 200_000, output: 32_000 } },
    },
  }
}

function app(options: Options = {}) {
  const sent: Sent[] = []
  const featureReads: string[] = []
  let credentialReads = 0
  const row = accessRow(options.mantle ?? false)
  assert.ok(row.model)
  const provider: GatewayProvider = {
    id: providerId, organization_id: organizationId, provider_id: row.provider.provider_id,
    provider_config: { id: row.provider.provider_id, name: "Amazon Bedrock", npm: options.mantle ? "@ai-sdk/amazon-bedrock/mantle" : "@ai-sdk/amazon-bedrock", env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
    settings: { region: "us-west-2", ...(options.settings ?? guardrail) }, status: "active",
  }
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "api_key", gatewayKeyId: createDenTypeId("gatewayApiKey") })
    c.set("openworkRequestId", "owr_guardrail_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  const router = { id: routerId, name: "Fixture Router", models: [{ id: "arm_fixture", providerId, modelId: upstreamModel, tasks: ["Writing"] }] }
  registerGatewayRoutes(api, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const entry = { url: request.url, headers: request.headers, body: await request.text() }
      sent.push(entry)
      return options.respond?.(entry, sent.length) ?? successfulResponse(request.url.endsWith("stream"))
    },
    insertRequestLog: async () => {}, updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} }, checkUsage: async () => null,
    loadGatewayProvider: async () => provider, loadGatewayAccess: async () => [row], loadMemberGatewayAccess: async () => [row],
    loadProviderCredential: async () => { credentialReads++; return options.credential ?? credential },
    bedrockGuardrailsEnabled: async (id) => { featureReads.push(id); if (options.policyUnavailable) throw new Error("fixture policy outage"); return options.enabled ?? true },
    catalog, now: () => now, autoRouterReasoning: createMemoryReasoningStore(), autoRouterRoutingConfigured: true,
    loadAutoRouterConfig: async () => router, loadMemberAutoRouters: async () => [router], askJev: async () => null,
  })
  const modelName = cursorModelName({ name: row.model.name, modelId: row.model.id })
  const claudeName = claudeCodeModelName({ name: row.model.name, modelId: row.model.id, contextWindow: 200_000 })
  const post = (path: string, body: Record<string, unknown> | string, headers: Record<string, string> = {}) => api.request(path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return { sent, featureReads, credentialReads: () => credentialReads, post, modelName, claudeName }
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}

async function assertSigned(entry: Sent | undefined) {
  assert.ok(entry)
  const headers = new Headers(entry.headers)
  const actual = headers.get("authorization")
  assert.match(actual ?? "", /^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE000000000\/20261110\/us-west-2\/bedrock\//)
  signAwsRequest({ method: "POST", url: new URL(entry.url), headers, body: entry.body, credentials: awsKeys, region: "us-west-2", service: "bedrock", now })
  assert.equal(actual, headers.get("authorization"), "the exact dispatched body and guardrail headers must be signed")
  return entry
}

const operations = ["converse", "converse-stream", "invoke", "invoke-with-response-stream"]
for (const operation of operations) {
  test(`Bedrock ${operation} applies policy before bearer API-key authentication`, async () => {
    const harness = app({ credential: { ...credential, kind: "api_key", secret: "fixture-bedrock-bearer-key" } })
    const response = await harness.post(nativePath(operation), nativeBody(operation))
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
    const entry = harness.sent[0]
    assert.ok(entry)
    assert.equal(entry.headers.get("authorization"), "Bearer fixture-bedrock-bearer-key")
    if (operation.startsWith("converse")) assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, guardrail)
    else {
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailidentifier"), guardrail.guardrailIdentifier)
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailversion"), guardrail.guardrailVersion)
    }
  })
}
function nativeBody(operation: string) {
  return operation.startsWith("converse")
    ? { messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 16 } }
    : { anthropic_version: "bedrock-2023-05-31", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
}
const nativePath = (operation: string) => `${gatewayPathPrefix}/${providerId}/model/${upstreamModel}/${operation}`

for (const operation of operations) {
  test(`Bedrock ${operation} applies the saved guardrail before signing`, async () => {
    const harness = app()
    const original = nativeBody(operation)
    const response = await harness.post(nativePath(operation), original)
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
    assert.equal(harness.sent.length, 1)
    const entry = await assertSigned(harness.sent[0])
    const body = record(JSON.parse(entry.body))
    if (operation.startsWith("converse")) {
      assert.deepEqual(body, { ...original, guardrailConfig: guardrail })
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailidentifier"), null)
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailversion"), null)
    } else {
      assert.deepEqual(body, original)
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailidentifier"), guardrail.guardrailIdentifier)
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailversion"), guardrail.guardrailVersion)
      assert.match(entry.headers.get("authorization") ?? "", /SignedHeaders=[^,]*x-amzn-bedrock-guardrailidentifier;x-amzn-bedrock-guardrailversion/)
    }
    assert.deepEqual(harness.featureReads, [organizationId])
  })

  for (const mode of ["no configuration", "flag off"]) {
    test(`Bedrock ${operation} with ${mode} preserves the exact request bytes`, async () => {
      const harness = app(mode === "no configuration" ? { settings: {} } : { enabled: false })
      const original = `${JSON.stringify(nativeBody(operation), null, 2)}\n`
      const response = await harness.post(nativePath(operation), original)
      assert.equal(response.status, 200)
      await response.text()
      const entry = await assertSigned(harness.sent[0])
      assert.equal(entry.body, original)
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailidentifier"), null)
      assert.equal(entry.headers.get("x-amzn-bedrock-guardrailversion"), null)
      if (mode === "no configuration") assert.deepEqual(harness.featureReads, [])
    })
  }
}

type Translation = "Auto" | "Cursor" | "Claude Code" | "Codex"
const translations: Translation[] = ["Auto", "Cursor", "Claude Code", "Codex"]
function translatedRequest(harness: ReturnType<typeof app>, client: Translation, stream = false, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  if (client === "Claude Code") return harness.post("/api/v1/claude-code/v1/messages", {
    model: harness.claudeName, max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream, ...extra,
  }, headers)
  if (client === "Codex") return harness.post("/api/v1/codex/responses", {
    model: harness.modelName, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], max_output_tokens: 16, stream, ...extra,
  }, headers)
  return harness.post(client === "Auto" ? "/api/v1/chat/completions" : "/api/v1/cursor/chat/completions", {
    model: client === "Auto" ? autoRouterModelId(routerId) : harness.modelName,
    messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream, ...extra,
  }, headers)
}

for (const client of translations) {
  for (const stream of [false, true]) {
    test(`${client} translated ${stream ? "streaming" : "nonstreaming"} requests cannot bypass the Bedrock guardrail`, async () => {
      const harness = app()
      const response = await translatedRequest(harness, client, stream)
      assert.equal(response.status, 200, await response.clone().text())
      await response.text()
      assert.equal(harness.sent.length, 1)
      const entry = await assertSigned(harness.sent[0])
      assert.equal(new URL(entry.url).pathname, `/model/${upstreamModel}/${stream ? "converse-stream" : "converse"}`)
      assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, guardrail)
      assert.deepEqual(harness.featureReads, [organizationId])
    })
  }
}

for (const client of translations) {
  for (const stream of [false, true]) {
    test(`${client} ${stream ? "streaming" : "nonstreaming"} no-policy and flag-off requests have identical bytes and authentication`, async () => {
      const baseline = app({ settings: {} })
      const disabled = app({ enabled: false })
      await (await translatedRequest(baseline, client, stream)).text()
      await (await translatedRequest(disabled, client, stream)).text()
      const unconfigured = await assertSigned(baseline.sent[0])
      const flagOff = await assertSigned(disabled.sent[0])
      assert.equal(flagOff.body, unconfigured.body)
      assert.equal(flagOff.url, unconfigured.url)
      assert.deepEqual([...flagOff.headers], [...unconfigured.headers])
      assert.equal(record(JSON.parse(unconfigured.body)).guardrailConfig, undefined)
      assert.equal(unconfigured.headers.get("x-amzn-bedrock-guardrailidentifier"), null)
      assert.equal(unconfigured.headers.get("x-amzn-bedrock-guardrailversion"), null)
      assert.deepEqual(baseline.featureReads, [])
    })
  }
}

test("tool schemas and inputs named guardrailIdentifier are data, not client policy controls", async () => {
  const harness = app()
  const response = await translatedRequest(harness, "Cursor", false, {
    tools: [{ type: "function", function: { name: "inspect_policy", parameters: { type: "object", properties: { guardrailIdentifier: { type: "string" } } } } }],
  })
  assert.equal(response.status, 200, await response.clone().text())
  await response.text()
  const entry = await assertSigned(harness.sent[0])
  assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, guardrail)
  assert.match(entry.body, /inspect_policy/)
})

const clientResources: Record<string, unknown>[] = [
  { guardrailConfig: { guardrailIdentifier: "callerpolicy", guardrailVersion: "DRAFT" } },
  { guardrailIdentifier: "callerpolicy" },
  { guardrailVersion: "DRAFT" },
  { "amazon-bedrock-guardrailConfig": { tagSuffix: "caller" } },
  { messages: [{ role: "user", content: [{ guardContent: { text: { text: "hi" } } }] }] },
]
for (const client of translations) {
  for (const extra of clientResources) {
    test(`${client} rejects caller-selected ${Object.keys(extra)[0]} before translation can strip it`, async () => {
      const harness = app()
      const response = await translatedRequest(harness, client, false, extra)
      assert.equal(response.status, 400, await response.clone().text())
      assert.equal(harness.sent.length, 0)
      assert.equal(harness.credentialReads(), 0)
    })
  }
  for (const name of ["X-Amzn-Bedrock-GuardrailIdentifier", "x-amzn-bedrock-guardrailversion", "X-Amzn-Bedrock-Trace"]) {
    test(`${client} rejects caller-selected ${name} headers`, async () => {
      const harness = app()
      const response = await translatedRequest(harness, client, false, {}, { [name]: "callerpolicy" })
      assert.equal(response.status, 400)
      assert.equal(harness.sent.length, 0)
      assert.equal(harness.credentialReads(), 0)
    })
  }
}

for (const operation of operations) {
  test(`native ${operation} rejects caller guardrail controls before credentials or dispatch`, async () => {
    for (const extra of clientResources) {
      const harness = app()
      const response = await harness.post(nativePath(operation), { ...nativeBody(operation), ...extra })
      assert.equal(response.status, 400)
      assert.equal(harness.sent.length, 0)
      assert.equal(harness.credentialReads(), 0)
    }
  })
}

for (const settings of [
  { guardrailIdentifier: "fixtureguardrail" },
  { guardrailVersion: "3" },
  { guardrailIdentifier: "", guardrailVersion: "3" },
]) {
  test(`an enabled invalid saved guardrail fails closed: ${JSON.stringify(settings)}`, async () => {
    const harness = app({ settings })
    const response = await harness.post(nativePath("converse"), nativeBody("converse"))
    assert.equal(response.status, 400)
    assert.equal(harness.sent.length, 0)
  })
}

test("an unavailable organization policy fails closed instead of sending an unguarded request", async () => {
  const harness = app({ policyUnavailable: true })
  const response = await harness.post(nativePath("converse"), nativeBody("converse"))
  assert.equal(response.status, 503)
  assert.equal(harness.sent.length, 0)
  assert.match(await response.text(), /guardrail policy could not be verified/)
})

test("Bedrock Mantle with an enabled saved guardrail fails without calling upstream", async () => {
  const harness = app({ mantle: true })
  const response = await harness.post(`${gatewayPathPrefix}/${providerId}/chat/completions`, { model: upstreamModel, messages: [{ role: "user", content: "hi" }] })
  assert.equal(response.status, 400)
  assert.equal(harness.sent.length, 0)
  assert.match(await response.text(), /guardrail/i)
})

const signingSecret = "fixture-shared-secret-0000000000000000"
function testDependencies(sent: Sent[], enabled = true): ProviderTestDependencies {
  return {
    catalog, signingSecret, now: () => now, mintGcpAccessToken: async () => ({ kind: "error", message: "unused" }),
    bedrockGuardrailsEnabled: async (id) => { assert.equal(id, organizationId); return enabled },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push({ url: request.url, headers: request.headers, body: await request.text() })
      return Response.json({ output: { message: { content: [{ text: "OK" }] } }, stopReason: "end_turn" })
    },
  }
}
function providerTestRequest(settings: Record<string, string> = guardrail, mantle = false) {
  const testCredential: { kind: "aws_keys"; secret: string } = { kind: "aws_keys", secret: credential.secret }
  return { providerId: mantle ? "amazon-bedrock-mantle" : "amazon-bedrock", model: upstreamModel, settings: { region: "us-west-2", ...settings }, credential: testCredential }
}

test("the administrator's signed provider test applies and signs the saved guardrail", async () => {
  const sent: Sent[] = []
  const api = new Hono<ProviderTestEnv>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId: createDenTypeId("gatewayKey") })
    await next()
  })
  registerProviderTestRoute(api, testDependencies(sent))
  const body = JSON.stringify(providerTestRequest())
  const signature = signProviderTest(signingSecret, { organizationId, memberId: orgMembershipId, body }, now.getTime())
  const response = await api.request("/api/v1/provider-tests", { method: "POST", body, headers: { "x-openwork-provider-test-signature": signature } })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(record(await response.json()).ok, true)
  assert.equal(sent.length, 1)
  const entry = await assertSigned(sent[0])
  assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, guardrail)
})

for (const enabled of [false, true]) {
  test(`direct administrator test respects guardrailsEnabled=${enabled}`, async () => {
    const sent: Sent[] = []
    const result = await runProviderTest(providerTestRequest(), testDependencies(sent), enabled)
    assert.equal(result.ok, true)
    const entry = await assertSigned(sent[0])
    assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, enabled ? guardrail : undefined)
  })
}

test("administrator no-policy and flag-off tests dispatch identical request bytes and headers", async () => {
  const baseline: Sent[] = []
  const disabled: Sent[] = []
  assert.equal((await runProviderTest(providerTestRequest({}), testDependencies(baseline), true)).ok, true)
  assert.equal((await runProviderTest(providerTestRequest(), testDependencies(disabled), false)).ok, true)
  const first = await assertSigned(baseline[0])
  const second = await assertSigned(disabled[0])
  assert.equal(first.body, second.body)
  assert.equal(first.url, second.url)
  assert.deepEqual([...first.headers], [...second.headers])
  assert.equal(record(JSON.parse(first.body)).guardrailConfig, undefined)
})

test("the administrator API-key test carries the guardrail with bearer authentication", async () => {
  const sent: Sent[] = []
  const testCredential: { kind: "api_key"; secret: string } = { kind: "api_key", secret: "fixture-bedrock-bearer-key" }
  const result = await runProviderTest({ ...providerTestRequest(), credential: testCredential }, testDependencies(sent), true)
  assert.equal(result.ok, true)
  const entry = sent[0]
  assert.ok(entry)
  assert.equal(entry.headers.get("authorization"), "Bearer fixture-bedrock-bearer-key")
  assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, guardrail)
})

test("the connection test reports guardrail intervention instead of a misleading pass", async () => {
  const sent: Sent[] = []
  const dependencies = testDependencies(sent)
  const result = await runProviderTest(providerTestRequest(), {
    ...dependencies,
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push({ url: request.url, headers: request.headers, body: await request.text() })
      return blockedConverse(false, "prompt")
    },
  }, true)
  assert.equal(result.ok, false)
  assert.equal(result.code, "bedrock_guardrail_intervened")
  assert.equal(result.message, blockedMessage)
  const entry = await assertSigned(sent[0])
  assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, guardrail)
})

test("administrator testing a guarded Mantle provider fails without dispatch", async () => {
  const sent: Sent[] = []
  const result = await runProviderTest(providerTestRequest(guardrail, true), testDependencies(sent), true)
  assert.equal(result.ok, false)
  assert.match(result.message ?? "", /guardrail/i)
  assert.equal(sent.length, 0)
})

for (const stream of [false, true]) {
  test(`Bedrock ${stream ? "streaming" : "nonstreaming"} output-cap retries preserve guardrails and re-sign the final body`, async () => {
    const harness = app({
      respond: (_entry, attempt) => attempt === 1
        ? Response.json({ message: "The maximum tokens you requested exceeds the model limit of 8." }, { status: 400 })
        : successfulResponse(stream),
    })
    const response = await harness.post(nativePath(stream ? "converse-stream" : "converse"), nativeBody("converse"))
    assert.equal(response.status, 200, await response.clone().text())
    await response.text()
    assert.equal(harness.sent.length, 2)
    for (const entry of harness.sent) {
      await assertSigned(entry)
      assert.deepEqual(record(JSON.parse(entry.body)).guardrailConfig, guardrail)
    }
    assert.deepEqual(harness.sent.map((entry) => record(record(JSON.parse(entry.body)).inferenceConfig).maxTokens), [16, 8])
    assert.notEqual(harness.sent[0]?.headers.get("authorization"), harness.sent[1]?.headers.get("authorization"))
    assert.deepEqual(harness.featureReads, [organizationId])
  })
}

function blockedConverse(stream: boolean, phase: "prompt" | "response") {
  if (stream) return eventResponse([
    { type: "messageStart", payload: { role: "assistant" } },
    ...(phase === "response" ? [
      { type: "contentBlockStart", payload: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "fixture_tool", name: "fixture_tool" } } } },
      { type: "contentBlockDelta", payload: { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } } },
      { type: "contentBlockStop", payload: { contentBlockIndex: 0 } },
    ] : []),
    { type: "messageStop", payload: { stopReason: "guardrail_intervened" } },
    { type: "metadata", payload: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
  ])
  return Response.json({
    output: { message: { role: "assistant", content: phase === "response" ? [{ toolUse: { toolUseId: "fixture_tool", name: "fixture_tool", input: {} } }] : [{ text: "" }] } },
    stopReason: "guardrail_intervened", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  })
}

async function eventPayloads(response: Response) {
  const payloads: unknown[] = []
  const rest = readEventStreamFrames(new Uint8Array(await response.arrayBuffer()), (frame) => {
    payloads.push(JSON.parse(new TextDecoder().decode(frame.payload)))
  })
  assert.ok(rest)
  assert.equal(rest.length, 0)
  return payloads
}

const blockedMessage = "Your organization’s guardrail blocked this prompt or response. Contact your administrator if you need help."
const phases: Array<"prompt" | "response"> = ["prompt", "response"]
for (const phase of phases) {
  for (const stream of [false, true]) {
    test(`native Converse ${stream ? "streaming" : "nonstreaming"} blocked ${phase} shows an actionable organization-policy message`, async () => {
      const harness = app({ respond: () => blockedConverse(stream, phase) })
      const response = await harness.post(nativePath(stream ? "converse-stream" : "converse"), nativeBody("converse"))
      assert.equal(response.status, 200)
      const text = stream ? JSON.stringify(await eventPayloads(response)) : await response.text()
      assert.ok(text.includes(blockedMessage), text)
      assert.doesNotMatch(text, /fixture_tool/)
    })

    for (const client of translations) {
      test(`${client} ${stream ? "streaming" : "nonstreaming"} blocked ${phase} keeps the organization-policy message across response translation`, async () => {
        const harness = app({ respond: () => blockedConverse(stream, phase) })
        const response = await translatedRequest(harness, client, stream)
        assert.equal(response.status, 200)
        const text = await response.text()
        assert.ok(text.includes(blockedMessage), text)
        assert.doesNotMatch(text, /fixture_tool/)
      })
    }
  }
}

for (const stream of [false, true]) {
  test(`native InvokeModel ${stream ? "streaming" : "nonstreaming"} intervention is not mistaken for a successful answer`, async () => {
    const harness = app({ respond: () => stream
      ? eventResponse([{ type: "chunk", payload: { bytes: Buffer.from(JSON.stringify({ "amazon-bedrock-guardrailAction": "INTERVENED", completion: "fixture_blocked_output" })).toString("base64") } }])
      : Response.json({ "amazon-bedrock-guardrailAction": "INTERVENED", completion: "fixture_blocked_output" }),
    })
    const response = await harness.post(nativePath(stream ? "invoke-with-response-stream" : "invoke"), nativeBody("invoke"))
    assert.equal(response.status, stream ? 200 : 403)
    const text = stream ? JSON.stringify(await eventPayloads(response)) : await response.text()
    assert.ok(text.includes(blockedMessage), text)
    assert.doesNotMatch(text, /fixture_blocked_output/)
  })
}

for (const stream of [false, true]) {
  test(`flag-off ${stream ? "streaming" : "nonstreaming"} responses retain their previous provider representation`, async () => {
    const harness = app({ enabled: false, respond: () => blockedConverse(stream, "prompt") })
    const response = await harness.post(nativePath(stream ? "converse-stream" : "converse"), nativeBody("converse"))
    assert.equal(response.status, 200)
    const text = stream ? JSON.stringify(await eventPayloads(response)) : await response.text()
    assert.match(text, /guardrail_intervened/)
    assert.ok(!text.includes(blockedMessage), text)
  })
}
