// Claude prompt caching through Gateway aliases (#7164): the Gateway marks the
// cache breakpoints clients cannot, because a `gwm_…` alias hides that the
// model is Claude.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createGatewayModelAlias } from "@openwork-ee/utils/gateway-routing"
import type { GatewayAccessRow } from "../src/provider-access.js"
import type { GatewayCredential, GatewayProvider } from "../src/provider-credentials.js"
import type { GatewayRequestLogRow } from "../src/request-log.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"
import { applyClaudePromptCache, bedrockCachesModel, isAnthropicModelId } from "../src/prompt-cache.js"
import { parseOpenAiChatJsonUsage } from "../src/usage/openai-chat.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes, gatewayPathPrefix } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("../src/provider-catalog.js")

const EPHEMERAL = { type: "ephemeral" }

function chatRequest() {
  return {
    model: "anthropic/claude-opus-5.5",
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    messages: [
      { role: "system", content: "You are OpenWork." },
      { role: "system", content: "Project instructions." },
      { role: "user", content: "Read the file." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
      { role: "user", content: [{ type: "text", text: "Summarize it." }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
    ],
  }
}

test("Claude upstream ids are recognized; other models are not", () => {
  for (const id of ["anthropic/claude-opus-5.5", "~anthropic/claude-sonnet-latest", "claude-sonnet-4-5", "us.anthropic.claude-opus-4-1-v1:0"]) assert.ok(isAnthropicModelId(id), id)
  for (const id of ["openai/gpt-6.1", "google/gemini-3-pro", "qwen/qwen3-coder", null]) assert.ok(!isAnthropicModelId(id), String(id))
})

test("Chat Completions to Claude: first and last system message and the last two marked messages", () => {
  const json = chatRequest()
  assert.equal(applyClaudePromptCache(json, "openai_chat", json.model), true)
  const [system, project, user, assistant, tool, last] = json.messages
  assert.deepEqual(system?.content, [{ type: "text", text: "You are OpenWork.", cache_control: EPHEMERAL }])
  assert.deepEqual(project?.content, [{ type: "text", text: "Project instructions.", cache_control: EPHEMERAL }])
  assert.equal(user?.content, "Read the file.")
  // An assistant turn with only tool calls has nothing to mark; the tool result before the last turn takes it.
  assert.equal(assistant?.content, null)
  assert.deepEqual(tool?.content, [{ type: "text", text: "file contents", cache_control: EPHEMERAL }])
  assert.deepEqual(last?.content, [{ type: "text", text: "Summarize it." }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }].map((part, index) => index === 0 ? { ...part, cache_control: EPHEMERAL } : part))
  assert.equal(JSON.stringify(json).split("cache_control").length - 1, 4)
})

test("non-Claude models and requests the client already marked are left alone", () => {
  const gpt = { ...chatRequest(), model: "openai/gpt-6.1" }
  const before = JSON.stringify(gpt)
  assert.equal(applyClaudePromptCache(gpt, "openai_chat", gpt.model), false)
  assert.equal(JSON.stringify(gpt), before)

  const marked = { ...chatRequest(), messages: [{ role: "system", content: [{ type: "text", text: "You are OpenWork.", cache_control: EPHEMERAL }] }, ...chatRequest().messages.slice(1)] }
  const markedBefore = JSON.stringify(marked)
  assert.equal(applyClaudePromptCache(marked, "openai_chat", marked.model), false)
  assert.equal(JSON.stringify(marked), markedBefore)

  const automatic = { ...chatRequest(), cache_control: EPHEMERAL }
  assert.equal(applyClaudePromptCache(automatic, "openai_chat", automatic.model), false)
})

test("Anthropic Messages: the last tool, the system prompt and the conversation tail, never a thinking block", () => {
  const json = {
    model: "claude-sonnet-5",
    system: "You are OpenWork.",
    tools: [{ name: "read", input_schema: { type: "object" } }, { name: "write", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "Read it." },
      { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "read", input: {} }, { type: "thinking", thinking: "…", signature: "sig" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "data" }] },
    ],
  }
  assert.equal(applyClaudePromptCache(json, "anthropic_messages", json.model), true)
  assert.deepEqual(json.tools[1], { name: "write", input_schema: { type: "object" }, cache_control: EPHEMERAL })
  assert.equal(Object.hasOwn(json.tools[0] ?? {}, "cache_control"), false)
  assert.deepEqual(json.system, [{ type: "text", text: "You are OpenWork.", cache_control: EPHEMERAL }])
  const assistant = json.messages[1]?.content
  assert.ok(Array.isArray(assistant))
  assert.deepEqual(assistant[1], { type: "tool_use", id: "toolu_1", name: "read", input: {}, cache_control: EPHEMERAL })
  assert.equal(Object.hasOwn(assistant[2] ?? {}, "cache_control"), false)
  assert.deepEqual(json.messages[2]?.content, [{ type: "tool_result", tool_use_id: "toolu_1", content: "data", cache_control: EPHEMERAL }])
  assert.equal(json.messages[0]?.content, "Read it.")
})

test("Bedrock Converse gets cache points only on Claude models Bedrock caches", () => {
  const converse = () => ({
    system: [{ text: "You are OpenWork." }],
    toolConfig: { tools: [{ toolSpec: { name: "read", inputSchema: { json: {} } } }] },
    messages: [{ role: "user", content: [{ text: "Hi" }] }, { role: "assistant", content: [{ text: "Hello" }] }, { role: "user", content: [{ text: "Go" }] }],
  })
  const json = converse()
  assert.equal(applyClaudePromptCache(json, "bedrock_converse", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"), true)
  assert.deepEqual(json.system.at(-1), { cachePoint: { type: "default" } })
  assert.deepEqual(json.toolConfig.tools.at(-1), { cachePoint: { type: "default" } })
  assert.deepEqual(json.messages.map((message) => message.content.length), [1, 2, 2])

  const old = converse()
  assert.equal(applyClaudePromptCache(old, "bedrock_converse", "anthropic.claude-3-haiku-20240307-v1:0"), false)
  assert.ok(bedrockCachesModel("anthropic.claude-3-7-sonnet-20250219-v1:0"))
  assert.ok(!bedrockCachesModel("anthropic.claude-3-5-sonnet-20240620-v1:0"))
})

test("cache writes are read from OpenRouter and LiteLLM usage", () => {
  assert.equal(parseOpenAiChatJsonUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 90 } } }).cacheWriteTokens, 90)
  assert.equal(parseOpenAiChatJsonUsage({ usage: { prompt_tokens: 100, completion_tokens: 5, cache_creation_input_tokens: 80 } }).cacheWriteTokens, 80)
})

// End to end: an OpenRouter grant called through its Gateway alias.
const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const gatewayKeyId = createDenTypeId("gatewayKey")
const providerId = createDenTypeId("inferenceProvider")
const now = new Date("2026-11-11T12:00:00Z")

function openRouterApp(upstreamModel: string) {
  const sent: Request[] = []
  const logs: GatewayRequestLogRow[] = []
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  const modelId = createDenTypeId("inferenceProviderModel")
  const row: GatewayAccessRow = {
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: { id: modelId, gateway_provider_id: providerId, model_id: upstreamModel, name: upstreamModel, created_at: now, model_config: { id: upstreamModel, name: upstreamModel } },
  }
  const provider: GatewayProvider = {
    id: providerId, organization_id: organizationId, provider_id: "openrouter",
    provider_config: { id: "openrouter", name: "OpenRouter", npm: "@openrouter/ai-sdk-provider", env: ["OPENROUTER_API_KEY"], api: "https://openrouter.ai/api/v1" },
    settings: {}, status: "active",
  }
  const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-or-fixture-0000000000", expires_at: null, status: "active" }
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
      return Response.json({ id: "gen-1", object: "chat.completion", model: upstreamModel, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } })
    },
    insertRequestLog: async (log) => { logs.push(log) },
    updateRequestLog: async (log) => { logs.push(log); return true },
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => null,
    loadGatewayProvider: async () => provider,
    loadGatewayAccess: async () => [row],
    loadProviderCredential: async () => credential,
    catalog: createProviderCatalog({ openrouter: { npm: "@openrouter/ai-sdk-provider", api: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"] } }),
    now: () => now,
  })
  const alias = createGatewayModelAlias({ modelGroupId: groupId, credentialSetId: setId, gatewayProviderModelId: modelId })
  const send = () => api.request(`${gatewayPathPrefix}/${providerId}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: alias, messages: [{ role: "system", content: "You are OpenWork." }, { role: "user", content: "hi" }] }),
  })
  return { sent, send }
}

test("a Claude model called through its Gateway alias reaches OpenRouter with cache breakpoints", async () => {
  const { sent, send } = openRouterApp("anthropic/claude-opus-5.5")
  assert.equal((await send()).status, 200)
  const body: unknown = await sent[0]?.json()
  assert.deepEqual(body, {
    model: "anthropic/claude-opus-5.5",
    messages: [
      { role: "system", content: [{ type: "text", text: "You are OpenWork.", cache_control: EPHEMERAL }] },
      { role: "user", content: [{ type: "text", text: "hi", cache_control: EPHEMERAL }] },
    ],
  })
})

test("a non-Claude model called through its Gateway alias is forwarded unmarked", async () => {
  const { sent, send } = openRouterApp("openai/gpt-6.1")
  assert.equal((await send()).status, 200)
  const body: unknown = await sent[0]?.json()
  assert.ok(!JSON.stringify(body).includes("cache_control"))
})
