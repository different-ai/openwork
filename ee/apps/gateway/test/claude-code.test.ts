// Claude Code through the AI Gateway (feature gatewayMemberApiKeys): ANTHROPIC_BASE_URL points at
// /api/v1/claude-code, and every model answers as Anthropic Messages under a name a person can set.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { claudeCodeBaseUrl, claudeCodeModelName, parseClaudeCodeModelName } from "@openwork/types/den/gateway-cursor"
import type { GatewayCredential, GatewayProvider } from "../src/gateway.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"
import type { GatewayMemberAccessRow } from "../src/provider-access.js"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("../src/provider-catalog.js")
const { createMemoryReasoningStore } = await import("../src/auto-router/reasoning-store.js")
const { messagesToChat } = await import("../src/claude-code-messages.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const now = new Date("2026-11-10T12:00:00Z")

const anthropicId = createDenTypeId("inferenceProvider")
const deepseekId = createDenTypeId("inferenceProvider")
const providers: Record<string, GatewayProvider> = {
  [anthropicId]: { id: anthropicId, organization_id: organizationId, provider_id: "anthropic", provider_config: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: [] }, settings: {}, status: "active" },
  [deepseekId]: { id: deepseekId, organization_id: organizationId, provider_id: "deepseek", provider_config: { id: "deepseek", name: "DeepSeek", npm: "@ai-sdk/openai-compatible", env: [], api: "https://api.deepseek.com/v1" }, settings: {}, status: "active" },
}

function accessRow(providerId: string, model: { modelId: string; name: string; context?: number }): GatewayMemberAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  const provider = providers[providerId]
  assert.ok(provider)
  return {
    provider: { id: provider.id, provider_id: provider.provider_id, name: String(provider.provider_config.name) },
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: provider.id, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: provider.id, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: provider.id, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: {
      id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: provider.id, model_id: model.modelId, name: model.name, created_at: now,
      model_config: { id: model.modelId, name: model.name, tool_call: true, reasoning: false, limit: { context: model.context ?? 200_000, output: 32_000 } },
    },
  }
}

const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-fixture-0000000000", expires_at: null, status: "active" }

const CHAT_STREAM = [
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":" } }] }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.ts\"}" } }] }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"

function app(rows: GatewayMemberAccessRow[], options: { enabled?: boolean } = {}) {
  const sent: Request[] = []
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "api_key", gatewayKeyId: createDenTypeId("gatewayApiKey") })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  registerGatewayRoutes(api, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push(request)
      const body: unknown = await request.clone().json()
      const stream = typeof body === "object" && body !== null && Reflect.get(body, "stream") === true
      if (request.url.includes("anthropic.com")) {
        return Response.json({ id: "msg_up", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "From Claude" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } })
      }
      if (stream) return new Response(CHAT_STREAM, { headers: { "content-type": "text/event-stream" } })
      return Response.json({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "From DeepSeek", tool_calls: [{ id: "call_9", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })
    },
    insertRequestLog: async () => {},
    updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => null,
    loadGatewayProvider: async ({ inferenceProviderId }) => providers[inferenceProviderId] ?? null,
    loadGatewayAccess: async ({ gatewayProviderId }) => rows.filter((row) => row.provider.id === gatewayProviderId),
    loadMemberGatewayAccess: async () => rows,
    loadProviderCredential: async () => credential,
    catalog: createProviderCatalog({ anthropic: { npm: "@ai-sdk/anthropic", env: [] }, deepseek: { npm: "@ai-sdk/openai-compatible", api: "https://api.deepseek.com/v1", env: [] } }),
    autoRouterReasoning: createMemoryReasoningStore(),
    toolEndpointsEnabled: async () => options.enabled ?? true,
    now: () => now,
  })
  const messages = (body: Record<string, unknown>, headers: Record<string, string> = {}) => api.request("/api/v1/claude-code/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers }, body: JSON.stringify(body),
  })
  return { api, sent, messages }
}

const name = (row: GatewayMemberAccessRow) => {
  assert.ok(row.model)
  return claudeCodeModelName({ name: row.model.name, modelId: row.model.id, contextWindow: Number(Reflect.get(Reflect.get(row.model.model_config, "limit") ?? {}, "context")) })
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  assert.ok(typeof body === "object" && body !== null && !Array.isArray(body))
  return Object.fromEntries(Object.entries(body))
}

test("names for Claude Code: no thinking level, and [1m] on 1M token models", () => {
  assert.equal(claudeCodeModelName({ name: "Claude Opus 5.5", modelId: "ipm_aaaaaaaaaaaaaaaaaaaaaak3f9", contextWindow: 1_000_000 }), "openwork/claude-opus-5.5-k3f9[1m]")
  assert.equal(claudeCodeModelName({ name: "Claude Haiku 5.5", modelId: "ipm_aaaaaaaaaaaaaaaaaaaaaa7xq2", contextWindow: 200_000 }), "openwork/claude-haiku-5.5-7xq2")
  assert.deepEqual(parseClaudeCodeModelName("openwork/claude-opus-5.5-k3f9[1m]"), { slug: "claude-opus-5.5", idSuffix: "k3f9", thinking: "default" })
  assert.equal(claudeCodeBaseUrl("https://gateway.example/api/v1"), "https://gateway.example/api/v1/claude-code")
})

test("the model list is in Anthropic's shape, for Claude Code's model picker", async () => {
  const opus = accessRow(anthropicId, { modelId: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1_000_000 })
  const { api } = app([opus, accessRow(deepseekId, { modelId: "deepseek-v4", name: "DeepSeek V4" })])
  const body = await json(await api.request("/api/v1/claude-code/v1/models"))
  const data = body.data
  assert.ok(Array.isArray(data))
  assert.deepEqual(data.map((entry: unknown) => typeof entry === "object" && entry !== null ? [Reflect.get(entry, "type"), Reflect.get(entry, "display_name")] : null), [["model", "Claude Opus 5.5"], ["model", "DeepSeek V4"]])
  assert.equal(Reflect.get(data[0] ?? {}, "id"), name(opus))
  assert.equal(body.has_more, false)
})

test("a Claude model gets Claude Code's request as it is: thinking, betas and the answer untouched", async () => {
  const opus = accessRow(anthropicId, { modelId: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1_000_000 })
  const { sent, messages } = app([opus])
  const request = {
    model: name(opus), max_tokens: 1024, stream: false,
    thinking: { type: "adaptive" }, output_config: { effort: "high" },
    system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  }
  const response = await messages(request, { "anthropic-beta": "context-1m-2025-08-07" })
  assert.equal(response.status, 200)
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages")
  assert.equal(sent[0]?.headers.get("anthropic-beta"), "context-1m-2025-08-07")
  const upstream = await json(sent[0] ?? new Response("{}"))
  assert.equal(upstream.model, "claude-opus-5-5")
  assert.deepEqual(upstream.thinking, request.thinking)
  assert.deepEqual(upstream.system, request.system)
  const body = await json(response)
  assert.equal(body.type, "message")
  assert.deepEqual(body.content, [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "From Claude" }])
})

test("another provider's model answers Claude Code as Messages, tool use included", async () => {
  const deepseek = accessRow(deepseekId, { modelId: "deepseek-v4", name: "DeepSeek V4" })
  const { sent, messages } = app([deepseek])
  const response = await messages({
    model: name(deepseek), max_tokens: 512,
    system: "Be brief.",
    tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }],
  })
  assert.equal(response.status, 200)
  assert.equal(sent[0]?.url, "https://api.deepseek.com/v1/chat/completions")
  const upstream = await json(sent[0] ?? new Response("{}"))
  assert.equal(upstream.model, "deepseek-v4")
  assert.deepEqual(upstream.messages, [{ role: "system", content: "Be brief." }, { role: "user", content: "list files" }])
  assert.equal(Reflect.get(Reflect.get(Array.isArray(upstream.tools) ? upstream.tools[0] : {}, "function") ?? {}, "name"), "Bash")
  const body = await json(response)
  assert.equal(body.type, "message")
  assert.equal(body.model, name(deepseek))
  assert.equal(body.stop_reason, "tool_use")
  assert.deepEqual(body.content, [{ type: "text", text: "From DeepSeek" }, { type: "tool_use", id: "call_9", name: "Bash", input: { command: "ls" } }])
})

test("a streamed answer from another provider comes back as Messages events", async () => {
  const deepseek = accessRow(deepseekId, { modelId: "deepseek-v4", name: "DeepSeek V4" })
  const { messages } = app([deepseek])
  const response = await messages({ model: name(deepseek), max_tokens: 512, stream: true, messages: [{ role: "user", content: "hi" }] })
  assert.equal(response.status, 200)
  const text = await response.text()
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(events, [
    "message_start",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ])
  assert.match(text, /"type":"tool_use","id":"call_1","name":"Read"/)
  assert.match(text, /"stop_reason":"tool_use"/)
  assert.match(text, /"output_tokens":5/)
})

test("a Claude Code conversation with tool results becomes the same chat conversation", () => {
  const chat = messagesToChat({
    model: "x", system: [{ type: "text", text: "System" }],
    messages: [
      { role: "user", content: "Read a.ts" },
      { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "s" }, { type: "text", text: "Reading" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "contents" }] }, { type: "text", text: "now fix it" }] },
    ],
    tool_choice: { type: "any" },
  })
  assert.deepEqual(chat.messages, [
    { role: "system", content: "System" },
    { role: "user", content: "Read a.ts" },
    { role: "assistant", content: "Reading", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"a.ts\"}" } }] },
    { role: "tool", tool_call_id: "toolu_1", content: "contents" },
    { role: "user", content: "now fix it" },
  ])
  assert.equal(chat.tool_choice, "required")
  // Claude Code's model check asks for one token; translated providers get at least 16.
  assert.equal(messagesToChat({ model: "x", max_tokens: 1, messages: [] }).max_tokens, 16)
  assert.equal(messagesToChat({ model: "x", max_tokens: 4096, messages: [] }).max_tokens, 4096)
})

test("Claude Code's own model ids resolve by catalog id; unknown names get an Anthropic error", async () => {
  const opus = accessRow(anthropicId, { modelId: "claude-opus-5-5", name: "Claude Opus 5.5" })
  const { sent, messages, api } = app([opus])
  assert.equal((await messages({ model: "claude-opus-5-5[1m]", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })).status, 200)
  const missing = await messages({ model: "claude-sonnet-9", max_tokens: 10, messages: [{ role: "user", content: "hi" }] })
  assert.equal(missing.status, 404)
  const error = await json(missing)
  assert.equal(error.type, "error")
  assert.equal(Reflect.get(Object(error.error), "type"), "not_found_error")
  assert.equal(sent.length, 1)
  const count = await json(await api.request("/api/v1/claude-code/v1/messages/count_tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name(opus), messages: [{ role: "user", content: "hello there" }] }) }))
  assert.ok(typeof count.input_tokens === "number" && count.input_tokens > 0)
})

test("with member API keys off the endpoint does not exist", async () => {
  const opus = accessRow(anthropicId, { modelId: "claude-opus-5-5", name: "Claude Opus 5.5" })
  const { api, sent, messages } = app([opus], { enabled: false })
  assert.equal((await api.request("/api/v1/claude-code/v1/models")).status, 404)
  assert.equal((await messages({ model: name(opus), max_tokens: 10, messages: [{ role: "user", content: "hi" }] })).status, 404)
  assert.equal(sent.length, 0)
})
