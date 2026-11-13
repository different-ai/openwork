// Smart Routers on the 3rd party tool endpoints (member AI Gateway API keys):
// Cursor, Claude Code and Codex list the member's routers as openwork/smart-… models, and a request
// naming one runs the Smart Model Router and answers in the tool's own protocol.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { AUTO_ROUTER_RESPONSE_MODEL_HEADER, autoRouterModelId } from "@openwork/types/den/auto-router"
import { isSmartRouterToolName, matchSmartRouter, parseClaudeCodeModelName, parseCursorModelName, smartRouterToolName } from "@openwork/types/den/gateway-cursor"
import type { AutoRouterConfig } from "../src/auto-router/config.js"
import type { AskJev } from "../src/auto-router/jev.js"
import type { GatewayCredential, GatewayProvider } from "../src/gateway.js"
import type { GatewayContext } from "../src/middleware/gateway-auth.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"
import type { GatewayMemberAccessRow } from "../src/provider-access.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("../src/provider-catalog.js")
const { createMemoryReasoningStore } = await import("../src/auto-router/reasoning-store.js")
const { clearAutoTurnChoices } = await import("../src/auto-router/decide.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const gatewayKeyId = createDenTypeId("gatewayApiKey")
const providerId = createDenTypeId("inferenceProvider")
const now = new Date("2026-11-10T12:00:00Z")

const provider: GatewayProvider = {
  id: providerId,
  organization_id: organizationId,
  provider_id: "anthropic",
  provider_config: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"] },
  settings: {},
  status: "active",
}

function accessRow(model: { modelId: string; name: string; context?: number }): GatewayMemberAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  return {
    provider: { id: providerId, provider_id: "anthropic", name: "Anthropic" },
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: {
      id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: model.modelId, name: model.name, created_at: now,
      model_config: { id: model.modelId, name: model.name, tool_call: true, reasoning: false, limit: { context: model.context ?? 200_000, output: 32_000 } },
    },
  }
}

const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-ant-fixture-0000000", expires_at: null, status: "active" }

const ANTHROPIC_STREAM = [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Smart " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const haiku = accessRow({ modelId: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 200_000 })
const sonnet = accessRow({ modelId: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 1_000_000 })
const routerId = createDenTypeId("autoRouter")
const router: AutoRouterConfig = {
  id: routerId,
  name: "Engineering",
  models: [
    { id: "arm_haiku", providerId, modelId: "claude-haiku-5-5", tasks: ["Quick questions"] },
    { id: "arm_sonnet", providerId, modelId: "claude-sonnet-5-5", tasks: ["Coding"] },
  ],
}
/** A router whose only model the member has no access to. */
const unusable: AutoRouterConfig = { id: createDenTypeId("autoRouter"), name: "Research", models: [{ id: "arm_x", providerId, modelId: "claude-opus-5-5", tasks: ["Research"] }] }

/** Jev answers that every prompt is about coding, so Smart picks the router's second model (the fallback is the first). */
const askJev: AskJev = async ({ tasks }) => ({ tasks: new Map(tasks.map((task) => [task.key, task.name === "Coding" ? 1 : 0])), thinking: null, model: "jev-fixture" })

function app(options: { routers?: AutoRouterConfig[]; routingConfigured?: boolean; keySource?: GatewayContext["keySource"] } = {}) {
  clearAutoTurnChoices()
  const sent: Request[] = []
  const routers = options.routers ?? [router, unusable]
  let routerReads = 0
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", options.keySource === "member"
      ? { kind: "gateway", organizationId, orgMembershipId, keySource: "member", gatewayKeyId: createDenTypeId("gatewayKey") }
      : { kind: "gateway", organizationId, orgMembershipId, keySource: "api_key", gatewayKeyId })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  const rows = [haiku, sonnet]
  registerGatewayRoutes(api, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push(request)
      const upstream: unknown = await request.clone().json()
      if (typeof upstream === "object" && upstream !== null && Reflect.get(upstream, "stream") === true) {
        return new Response(ANTHROPIC_STREAM, { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({
        id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: "Smart OK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 },
      })
    },
    insertRequestLog: async () => {},
    updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => null,
    loadGatewayProvider: async () => provider,
    loadGatewayAccess: async () => rows,
    loadMemberGatewayAccess: async () => rows,
    loadProviderCredential: async () => credential,
    catalog: createProviderCatalog({ anthropic: { npm: "@ai-sdk/anthropic", env: [] } }),
    autoRouterReasoning: createMemoryReasoningStore(),
    autoRouterRoutingConfigured: options.routingConfigured ?? true,
    loadMemberAutoRouters: async () => { routerReads++; return routers },
    loadAutoRouterConfig: async ({ routerId: id }) => routers.find((entry) => entry.id === id) ?? null,
    askJev,
    now: () => now,
  })
  const post = (path: string, body: Record<string, unknown>) => api.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { api, sent, post, routerReads: () => routerReads }
}

const smartName = smartRouterToolName({ routerName: router.name, routerId })

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}

async function json(response: Response) {
  return record(await response.json())
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value))
  return value
}

async function upstreamModel(request: Request | undefined) {
  assert.ok(request)
  return record(await request.clone().json()).model
}

test("a Smart Router's tool name is its picker name as a slug plus the end of its id", () => {
  assert.equal(smartRouterToolName({ routerName: "Engineering", routerId: "aur_01k9zzzzzzzzzzzzzzzzzzx7q2" }), "openwork/smart-engineering-x7q2")
  assert.equal(smartRouterToolName({ routerName: "  ", routerId: "aur_01k9zzzzzzzzzzzzzzzzzzx7q2" }), "openwork/smart-router-x7q2")
  const parsed = parseCursorModelName("openwork/smart-engineering-x7q2:high")
  assert.ok(parsed && isSmartRouterToolName(parsed))
  const fromClaude = parseClaudeCodeModelName("openwork/smart-engineering-x7q2[1m]")
  assert.ok(fromClaude && isSmartRouterToolName(fromClaude))
  const plain = parseCursorModelName("openwork/claude-opus-5.5-k3f9")
  assert.ok(plain && !isSmartRouterToolName(plain))
  const engineering = { id: "aur_aaaaaaaaaaaaaaaaaaaaaax7q2", name: "Engineering" }
  const design = { id: "aur_bbbbbbbbbbbbbbbbbbbbbbx7q2", name: "Design" }
  const support = { id: "aur_cccccccccccccccccccccck3f9", name: "Support" }
  // The id ending decides; the name only breaks a tie, so a renamed router keeps working.
  assert.deepEqual(matchSmartRouter(parsed, [engineering, design, support]), { kind: "found", model: engineering })
  const renamed = parseCursorModelName("openwork/smart-old-name-k3f9")
  assert.ok(renamed)
  assert.deepEqual(matchSmartRouter(renamed, [engineering, design, support]), { kind: "found", model: support })
  const tie = parseCursorModelName("openwork/smart-other-x7q2")
  assert.ok(tie)
  assert.deepEqual(matchSmartRouter(tie, [engineering, design]), { kind: "ambiguous" })
})

test("every tool's model list ends with the member's usable Smart Routers, in one router read", async () => {
  const { api, routerReads } = app()
  const cursor = list((await json(await api.request("/api/v1/cursor/models"))).data).map(record)
  assert.deepEqual(cursor.map((entry) => entry.id).slice(-1), [smartName])
  assert.equal(cursor.at(-1)?.name, "Smart: Engineering")
  assert.deepEqual(record(cursor.at(-1)?.openwork).thinking_levels, ["default"])
  assert.equal(cursor.length, 3, "the router without usable models is left out")

  const claude = list((await json(await api.request("/api/v1/claude-code/v1/models"))).data).map(record)
  assert.deepEqual(claude.at(-1), { type: "model", id: smartName, display_name: "Smart: Engineering", created_at: new Date(0).toISOString() })
  assert.equal(claude.length, 3)

  const codex = list((await json(await api.request("/api/v1/codex/models"))).models).map(record)
  const entry = codex.at(-1)
  assert.equal(entry?.slug, smartName)
  assert.equal(entry?.display_name, "Smart: Engineering")
  assert.deepEqual(entry?.supported_reasoning_levels, [])
  assert.equal(entry?.default_reasoning_level, null)
  assert.equal(entry?.apply_patch_tool_type, null)
  assert.equal(entry?.context_window, 200_000, "the smallest context window of its models")
  assert.equal(codex.length, 3)

  const general = list((await json(await api.request("/api/v1/models"))).data).map(record)
  const smart = general.at(-1)
  assert.equal(smart?.id, autoRouterModelId(routerId))
  assert.equal(smart?.name, "Smart: Engineering")
  assert.deepEqual(smart?.openwork, { provider_id: "openwork-auto", provider_name: "OpenWork", upstream_model_id: autoRouterModelId(routerId), smart_router: true })
  assert.equal(general.length, 3)
  assert.equal(routerReads(), 4, "one router read per list request")
})

test("no Smart Routers are listed while Smart is off, unconfigured, or for none that apply", async () => {
  for (const options of [{ routers: [] }, { routingConfigured: false }]) {
    const { api, routerReads } = app(options)
    for (const path of ["/api/v1/cursor/models", "/api/v1/claude-code/v1/models", "/api/v1/models"]) {
      const ids = list((await json(await api.request(path))).data).map((entry) => record(entry).id)
      assert.deepEqual(ids.filter((id) => typeof id === "string" && id.includes("smart")), [], path)
    }
    const slugs = list((await json(await api.request("/api/v1/codex/models"))).models).map((entry) => record(entry).slug)
    assert.equal(slugs.length, 2)
    if (options.routingConfigured === false) assert.equal(routerReads(), 0, "no router read without a routing key")
  }
})

test("the general model list keeps Smart Routers to API keys; desktop keys learn them from Den", async () => {
  const { api } = app({ keySource: "member" })
  const ids = list((await json(await api.request("/api/v1/models"))).data).map((entry) => record(entry).id)
  assert.equal(ids.length, 2)
})

test("Cursor Chat Completions by Smart name runs Smart, ignoring a level in the name", async () => {
  const { post, sent } = app()
  const response = await post("/api/v1/cursor/chat/completions", { model: `${smartName}:high`, messages: [{ role: "user", content: "quick question: what is 2+2?" }] })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_HEADER), "claude-sonnet-5-5")
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages")
  assert.equal(await upstreamModel(sent[0]), "claude-sonnet-5-5")
  const body = await json(response)
  assert.equal(body.object, "chat.completion")
  assert.equal(record(record(list(body.choices)[0]).message).content, "Smart OK")
})

test("Cursor Responses by Smart name answers as a Responses object", async () => {
  const { post } = app()
  const response = await post("/api/v1/cursor/responses", { model: smartName, input: "quick question" })
  assert.equal(response.status, 200)
  const body = await json(response)
  assert.equal(body.object, "response")
  assert.equal(body.model, smartName)
  assert.equal(body.openwork_route, undefined)
  const message = list(body.output).map(record).find((item) => item.type === "message")
  assert.equal(record(list(message?.content)[0]).text, "Smart OK")
})

test("Claude Code Messages by Smart name answers as Messages, JSON and stream", async () => {
  const { post, sent } = app()
  const response = await post("/api/v1/claude-code/v1/messages", { model: `${smartName}[1m]`, max_tokens: 100, messages: [{ role: "user", content: "quick question" }] })
  assert.equal(response.status, 200)
  assert.equal(await upstreamModel(sent[0]), "claude-sonnet-5-5")
  const body = await json(response)
  assert.equal(body.type, "message")
  assert.equal(body.model, `${smartName}[1m]`)
  assert.deepEqual(body.content, [{ type: "text", text: "Smart OK" }])
  assert.equal(body.openwork_route, undefined)

  const streamed = await post("/api/v1/claude-code/v1/messages", { model: smartName, max_tokens: 100, stream: true, messages: [{ role: "user", content: "quick question" }] })
  assert.equal(streamed.status, 200)
  assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/)
  const text = await streamed.text()
  assert.match(text, /event: message_start/)
  assert.match(text, /"text_delta","text":"Smart "/)
  assert.match(text, /event: message_stop/)
  assert.doesNotMatch(text, /openwork_route/)
})

test("Codex Responses by Smart name streams Responses events", async () => {
  const { post, sent } = app()
  const response = await post("/api/v1/codex/responses", {
    model: smartName,
    stream: true,
    reasoning: { effort: "high" },
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "quick question" }] }],
    tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }, { type: "web_search" }],
  })
  assert.equal(response.status, 200)
  assert.equal(await upstreamModel(sent[0]), "claude-sonnet-5-5")
  const upstream = record(await sent[0]?.clone().json())
  assert.deepEqual(list(upstream.tools).map((tool) => record(tool).name), ["shell"], "hosted tools are dropped, like a translated model")
  const text = await response.text()
  assert.match(text, /event: response.created/)
  assert.match(text, /"delta":"Smart "/)
  assert.match(text, /event: response.completed/)
  assert.doesNotMatch(text, /openwork_route/)
})

test("an unavailable Smart Router answers with Smart's message in each endpoint's error shape", async () => {
  const gone = app({ routers: [] })
  const cursor = await gone.post("/api/v1/cursor/chat/completions", { model: smartName, messages: [{ role: "user", content: "hi" }] })
  assert.equal(cursor.status, 404)
  assert.equal(record((await json(cursor)).error).code, "auto_router_unavailable")
  const codex = await gone.post("/api/v1/codex/responses", { model: smartName, input: "hi" })
  assert.equal(record((await json(codex)).error).code, "auto_router_unavailable")
  const claude = await gone.post("/api/v1/claude-code/v1/messages", { model: smartName, max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
  assert.equal(claude.status, 404)
  const claudeBody = await json(claude)
  assert.equal(claudeBody.type, "error")
  assert.deepEqual(record(claudeBody.error).type, "not_found_error")
  assert.match(String(record(claudeBody.error).message), /isn't available to you anymore/)

  const unconfigured = app({ routingConfigured: false })
  const off = await unconfigured.post("/api/v1/claude-code/v1/messages", { model: smartName, max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
  assert.match(String(record((await json(off)).error).message), /missing its routing key/)
  const direct = await unconfigured.post("/api/v1/cursor/chat/completions", { model: autoRouterModelId(routerId), messages: [{ role: "user", content: "hi" }] })
  assert.equal(record((await json(direct)).error).code, "auto_router_not_configured")
})

test("ordinary model names never read Smart Routers", async () => {
  const { post, routerReads } = app()
  assert.ok(haiku.model)
  const response = await post("/api/v1/cursor/chat/completions", { model: `openwork/claude-haiku-5.5-${haiku.model.id.slice(-4)}`, messages: [{ role: "user", content: "hi" }] })
  assert.equal(response.status, 200)
  assert.equal(routerReads(), 0)
})
