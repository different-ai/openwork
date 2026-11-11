// The Codex CLI through the AI Gateway (feature gatewayMemberApiKeys): a Codex provider's base_url
// points at /api/v1/codex, and every model answers as the Responses API under a name a person can set.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { codexBaseUrl, cursorModelName } from "@openwork/types/den/gateway-cursor"
import type { GatewayCredential, GatewayProvider } from "../src/gateway.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"
import type { GatewayMemberAccessRow } from "../src/provider-access.js"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("../src/provider-catalog.js")
const { createMemoryReasoningStore } = await import("../src/auto-router/reasoning-store.js")
const { responsesToChat } = await import("../src/cursor-responses.js")

const organizationId = createDenTypeId("organization")
const orgMembershipId = createDenTypeId("member")
const now = new Date("2026-11-10T12:00:00Z")

const openaiId = createDenTypeId("inferenceProvider")
const anthropicId = createDenTypeId("inferenceProvider")
const deepseekId = createDenTypeId("inferenceProvider")
const providers: Record<string, GatewayProvider> = {
  [openaiId]: { id: openaiId, organization_id: organizationId, provider_id: "openai", provider_config: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: [] }, settings: {}, status: "active" },
  [anthropicId]: { id: anthropicId, organization_id: organizationId, provider_id: "anthropic", provider_config: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: [] }, settings: {}, status: "active" },
  [deepseekId]: { id: deepseekId, organization_id: organizationId, provider_id: "deepseek", provider_config: { id: "deepseek", name: "DeepSeek", npm: "@ai-sdk/openai-compatible", env: [], api: "https://api.deepseek.com/v1" }, settings: {}, status: "active" },
}

function accessRow(providerId: string, model: { modelId: string; name: string; reasoning?: string[] }): GatewayMemberAccessRow {
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
      model_config: {
        id: model.modelId, name: model.name, tool_call: true, limit: { context: 400_000, output: 64_000 },
        ...(model.reasoning ? { reasoning: true, reasoning_options: [{ type: "effort", values: model.reasoning }] } : { reasoning: false }),
      },
    },
  }
}

const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-fixture-0000000000", expires_at: null, status: "active" }

const CHAT_STREAM = [
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Pat" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ching" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "apply_patch", arguments: "{\"input\":\"*** Begin Patch" } }] }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\\n*** End Patch\"}" } }] }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } }] }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"

const RESPONSES_STREAM = [
  { type: "response.created", response: { id: "resp_up", object: "response", status: "in_progress", output: [] } },
  { type: "response.completed", response: { id: "resp_up", object: "response", status: "completed", output: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" }, { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "From GPT" }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

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
      if (request.url.includes("api.openai.com")) return new Response(RESPONSES_STREAM, { headers: { "content-type": "text/event-stream" } })
      if (request.url.includes("anthropic.com")) {
        return Response.json({ id: "msg_up", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "From Claude" }, { type: "tool_use", id: "toolu_1", name: "multi_agent_v1__close_agent", input: { id: "a1" } }], stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 2 } })
      }
      if (stream) return new Response(CHAT_STREAM, { headers: { "content-type": "text/event-stream" } })
      return Response.json({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "From DeepSeek" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })
    },
    insertRequestLog: async () => {},
    updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => null,
    loadGatewayProvider: async ({ inferenceProviderId }) => providers[inferenceProviderId] ?? null,
    loadGatewayAccess: async ({ gatewayProviderId }) => rows.filter((row) => row.provider.id === gatewayProviderId),
    loadMemberGatewayAccess: async () => rows,
    loadProviderCredential: async () => credential,
    catalog: createProviderCatalog({
      openai: { npm: "@ai-sdk/openai", env: [] },
      anthropic: { npm: "@ai-sdk/anthropic", env: [] },
      deepseek: { npm: "@ai-sdk/openai-compatible", api: "https://api.deepseek.com/v1", env: [] },
    }),
    autoRouterReasoning: createMemoryReasoningStore(),
    toolEndpointsEnabled: async () => options.enabled ?? true,
    now: () => now,
  })
  const responses = (body: Record<string, unknown>) => api.request("/api/v1/codex/responses", {
    method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body),
  })
  return { api, sent, responses }
}

const name = (row: GatewayMemberAccessRow) => {
  assert.ok(row.model)
  return cursorModelName({ name: row.model.name, modelId: row.model.id })
}

async function json(response: Response | Request): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  assert.ok(typeof body === "object" && body !== null && !Array.isArray(body))
  return Object.fromEntries(Object.entries(body))
}

/** Tools as Codex sends them: functions, a namespace of functions, a custom tool and a hosted one. */
const CODEX_TOOLS = [
  { type: "function", name: "exec_command", description: "Run a command", strict: false, parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  { type: "namespace", name: "multi_agent_v1", description: "Sub-agents", tools: [{ type: "function", name: "close_agent", description: "Close an agent", strict: false, parameters: { type: "object", properties: { id: { type: "string" } } } }] },
  { type: "custom", name: "apply_patch", description: "Edit files", format: { type: "grammar", syntax: "lark", definition: "start: begin_patch hunk+ end_patch" } },
  { type: "web_search", external_web_access: false },
]

test("the Codex base URL", () => {
  assert.equal(codexBaseUrl("https://gateway.example/api/v1/"), "https://gateway.example/api/v1/codex")
})

test("the model list is Codex's own catalog shape, with instructions, reasoning levels and context", async () => {
  const gpt = accessRow(openaiId, { modelId: "gpt-5-mini", name: "GPT-5 Mini", reasoning: ["minimal", "low", "medium", "high"] })
  const haiku = accessRow(anthropicId, { modelId: "claude-haiku-4-5", name: "Claude Haiku 4.5" })
  const { api } = app([haiku, gpt])
  const body = await json(await api.request("/api/v1/codex/models?client_version=0.167.1"))
  assert.ok(Array.isArray(body.models))
  const [first, second] = body.models
  assert.equal(Reflect.get(first, "slug"), name(haiku))
  assert.equal(Reflect.get(first, "display_name"), "Claude Haiku 4.5")
  assert.deepEqual(Reflect.get(first, "supported_reasoning_levels"), [])
  assert.equal(Reflect.get(second, "slug"), name(gpt))
  assert.deepEqual(Reflect.get(second, "supported_reasoning_levels").map((level: unknown) => Reflect.get(Object(level), "effort")), ["minimal", "low", "medium", "high"])
  assert.equal(Reflect.get(second, "default_reasoning_level"), "medium")
  // Codex's apply_patch as a custom tool only where OpenAI takes custom tools; others edit through the shell.
  assert.equal(Reflect.get(second, "apply_patch_tool_type"), "freeform")
  assert.equal(Reflect.get(first, "apply_patch_tool_type"), null)
  // Ahead of Codex's own OpenAI models in /model.
  assert.ok(Number(Reflect.get(first, "priority")) < 0)
  for (const model of body.models) {
    // Fields Codex requires to decode a catalog entry.
    for (const field of ["slug", "display_name", "supported_reasoning_levels", "shell_type", "visibility", "supported_in_api", "priority", "support_verbosity", "truncation_policy", "experimental_supported_tools", "base_instructions"]) {
      assert.ok(Reflect.has(model, field), `${field} is in the catalog`)
    }
    assert.match(String(Reflect.get(model, "base_instructions")), /^You are a coding agent running in the Codex CLI/)
    assert.equal(Reflect.get(model, "context_window"), 400_000)
    assert.equal(Reflect.get(model, "visibility"), "list")
  }
})

test("an OpenAI model gets Codex's request as it is: tools, encrypted reasoning and the stream untouched", async () => {
  const gpt = accessRow(openaiId, { modelId: "gpt-5-mini", name: "GPT-5 Mini", reasoning: ["low", "medium", "high"] })
  const { sent, responses } = app([gpt])
  const request = {
    model: name(gpt), stream: true, store: false, instructions: "", tools: CODEX_TOOLS, tool_choice: "auto", parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"], prompt_cache_key: "thread-1",
    client_metadata: { session_id: "s1", "x-codex-turn-metadata": "{}" },
    input: [
      { type: "message", id: "msg_1", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
      { type: "reasoning", id: "rs_0", summary: [], encrypted_content: "enc-0" },
      { type: "message", id: "msg_2", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_p", output: "Done" },
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "x" } },
    ],
  }
  const response = await responses(request)
  assert.equal(response.status, 200)
  assert.equal(sent[0]?.url, "https://api.openai.com/v1/responses")
  const upstream = await json(sent[0] ?? new Response("{}"))
  assert.equal(upstream.model, "gpt-5-mini")
  // Client tools as they are (a namespace included); the hosted web search can't go through the Gateway.
  assert.deepEqual(upstream.tools, CODEX_TOOLS.slice(0, 3))
  // The conversation inline: ids that name nothing stored, hosted calls and Codex's telemetry dropped.
  assert.deepEqual(upstream.input, [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
    { type: "reasoning", id: "rs_0", summary: [], encrypted_content: "enc-0" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "call_p", output: "Done" },
  ])
  assert.equal(upstream.client_metadata, undefined)
  assert.equal(upstream.prompt_cache_key, "thread-1")
  assert.deepEqual(upstream.reasoning, request.reasoning)
  assert.deepEqual(upstream.include, request.include)
  const text = await response.text()
  assert.match(text, /event: response.completed/)
  assert.match(text, /"encrypted_content":"enc"/)
})

test("a level in the name sets the effort; a model without reasoning loses the reasoning options", async () => {
  const gpt = accessRow(openaiId, { modelId: "gpt-5-mini", name: "GPT-5 Mini", reasoning: ["low", "medium", "high"] })
  const plain = accessRow(openaiId, { modelId: "gpt-4.1", name: "GPT-4.1" })
  const { sent, responses } = app([gpt, plain])
  const input = [{ type: "message", role: "user", content: "hi" }]
  await responses({ model: `${name(gpt)}:low`, stream: true, reasoning: { effort: "high", summary: "auto" }, input })
  assert.deepEqual(Reflect.get(await json(sent[0] ?? new Response("{}")), "reasoning"), { effort: "low", summary: "auto" })
  await responses({ model: name(plain), stream: true, reasoning: { effort: "medium" }, include: ["reasoning.encrypted_content"], max_output_tokens: 1, input })
  const upstream = await json(sent[1] ?? new Response("{}"))
  assert.equal(upstream.reasoning, undefined)
  assert.deepEqual(upstream.include, [])
  assert.equal(upstream.max_output_tokens, 16)
})

test("a Claude model answers as Responses: namespaced and custom tools translated both ways", async () => {
  const haiku = accessRow(anthropicId, { modelId: "claude-haiku-4-5", name: "Claude Haiku 4.5" })
  const { sent, responses } = app([haiku])
  const response = await responses({
    model: name(haiku), stream: false, store: false, tools: CODEX_TOOLS, max_output_tokens: 4,
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
      { type: "reasoning", id: "rs_0", summary: [{ type: "summary_text", text: "thinking" }] },
      { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_p", output: "Done" },
      { type: "function_call", call_id: "call_a", namespace: "multi_agent_v1", name: "close_agent", arguments: "{\"id\":\"a0\"}" },
      { type: "function_call_output", call_id: "call_a", output: "closed" },
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "x" } },
    ],
  })
  assert.equal(response.status, 200)
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages")
  const upstream = await json(sent[0] ?? new Response("{}"))
  assert.equal(upstream.model, "claude-haiku-4-5")
  assert.ok(typeof upstream.max_tokens === "number" && upstream.max_tokens >= 16)
  const tools = Array.isArray(upstream.tools) ? upstream.tools.map((tool: unknown) => Reflect.get(Object(tool), "name")) : []
  assert.deepEqual(tools, ["exec_command", "multi_agent_v1__close_agent", "apply_patch"])
  const messages = JSON.stringify(upstream.messages)
  assert.match(messages, /"name":"apply_patch","input":\{"input":"\*\*\* Begin Patch\\n\*\*\* End Patch"\}/)
  assert.match(messages, /"name":"multi_agent_v1__close_agent"/)
  const body = await json(response)
  assert.equal(body.object, "response")
  assert.equal(body.model, name(haiku))
  assert.deepEqual(Array.isArray(body.output) ? body.output.map((item: unknown) => [Reflect.get(Object(item), "type"), Reflect.get(Object(item), "namespace"), Reflect.get(Object(item), "name")]) : null, [
    ["message", undefined, undefined],
    ["function_call", "multi_agent_v1", "close_agent"],
  ])
})

test("a streamed answer from another provider comes back as Responses events, custom tool calls included", async () => {
  const deepseek = accessRow(deepseekId, { modelId: "deepseek-v4", name: "DeepSeek V4" })
  const { sent, responses } = app([deepseek])
  const response = await responses({ model: name(deepseek), stream: true, tools: CODEX_TOOLS, input: "patch it" })
  assert.equal(response.status, 200)
  assert.equal(sent[0]?.url, "https://api.deepseek.com/v1/chat/completions")
  const text = await response.text()
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
  assert.equal(events[0], "response.created")
  assert.equal(events[events.length - 1], "response.completed")
  assert.ok(events.includes("response.custom_tool_call_input.done"))
  assert.match(text, /"type":"custom_tool_call","id":"[^"]+","call_id":"call_1","name":"apply_patch","input":"\*\*\* Begin Patch\\n\*\*\* End Patch"/)
  assert.match(text, /"type":"function_call","id":"[^"]+","call_id":"call_2","name":"exec_command","arguments":"\{\\"cmd\\":\\"ls\\"\}"/)
  assert.match(text, /"output_tokens":5/)
})

test("Codex's conversation becomes the same chat conversation", () => {
  const chat = responsesToChat({
    model: "x", tools: CODEX_TOOLS, tool_choice: { type: "custom", name: "apply_patch" },
    input: [{ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "patch" }, { type: "custom_tool_call_output", call_id: "c1", output: "ok" }],
  })
  assert.deepEqual(chat.messages, [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "apply_patch", arguments: "{\"input\":\"patch\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ])
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "apply_patch" } })
  const patch = Array.isArray(chat.tools) ? chat.tools.find((tool: unknown) => Reflect.get(Reflect.get(Object(tool), "function") ?? {}, "name") === "apply_patch") : null
  assert.match(String(Reflect.get(Reflect.get(Object(patch), "function") ?? {}, "description")), /lark grammar:\nstart: begin_patch/)
})

test("unknown names, stored responses on translated models and unknown routes get OpenAI errors", async () => {
  const haiku = accessRow(anthropicId, { modelId: "claude-haiku-4-5", name: "Claude Haiku 4.5" })
  const { api, sent, responses } = app([haiku])
  const missing = await responses({ model: "openwork/gpt-9-zzzz", input: "hi" })
  assert.equal(missing.status, 404)
  assert.equal(Reflect.get(Object((await json(missing)).error), "code"), "model_not_found")
  const stored = await responses({ model: name(haiku), previous_response_id: "resp_1", input: "hi" })
  assert.equal(stored.status, 400)
  assert.equal(Reflect.get(Object((await json(stored)).error), "code"), "previous_response_not_supported")
  // Codex's own model ids resolve by catalog id.
  assert.equal((await responses({ model: "claude-haiku-4-5", input: "hi" })).status, 200)
  assert.equal((await api.request("/api/v1/codex/chat/completions", { method: "POST", body: "{}" })).status, 404)
  assert.equal(sent.length, 1)
})

test("with member API keys off the endpoint does not exist", async () => {
  const gpt = accessRow(openaiId, { modelId: "gpt-5-mini", name: "GPT-5 Mini" })
  const { api, sent, responses } = app([gpt], { enabled: false })
  assert.equal((await api.request("/api/v1/codex/models")).status, 404)
  assert.equal((await responses({ model: name(gpt), input: "hi" })).status, 404)
  assert.equal(sent.length, 0)
})
