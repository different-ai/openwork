// Cursor through the AI Gateway (feature gatewayCursorSetup): one OpenAI-compatible base URL that
// serves every model the member can use, under names a person can type into Cursor.
import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { cursorBaseUrl, cursorModelName, cursorModelSlug, matchCursorModel, parseCursorModelName } from "@openwork/types/den/gateway-cursor"
import type { GatewayCredential, GatewayProvider } from "../src/gateway.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"
import type { GatewayAccessRow, GatewayMemberAccessRow } from "../src/provider-access.js"

// env.ts validates at import; nothing here touches a database.
process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:1/fixture"
process.env.DEN_DB_ENCRYPTION_KEY ??= "fixture-encryption-key-0000000000000000"
const { registerGatewayRoutes } = await import("../src/gateway.js")
const { createProviderCatalog } = await import("../src/provider-catalog.js")
const { createMemoryReasoningStore } = await import("../src/auto-router/reasoning-store.js")
const { normalizeCursorChatBody } = await import("../src/cursor.js")

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

function accessRow(model: { modelId: string; name: string; reasoning?: boolean }): GatewayMemberAccessRow {
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  return {
    provider: { id: providerId, provider_id: "anthropic", name: "Anthropic" },
    grant: { id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: groupId, credential_set_id: setId, audience_key: "organization", org_membership_id: null, team_id: null, created_at: now },
    group: { id: groupId, gateway_provider_id: providerId, name: "Default", description: null, status: "active", created_at: now, updated_at: now },
    credentialSet: { id: setId, gateway_provider_id: providerId, created_by_org_membership_id: null, name: "Organization key", credential_mode: "org", oauth_client_id: null, oauth_client_secret: null, oauth_tenant_id: null, aws_sso: null, status: "active", created_at: now, updated_at: now },
    model: {
      id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: providerId, model_id: model.modelId, name: model.name, created_at: now,
      model_config: {
        id: model.modelId, name: model.name, tool_call: true, limit: { context: 200_000, output: 32_000 },
        ...(model.reasoning ? { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] } : { reasoning: false }),
      },
    },
  }
}

const credential: GatewayCredential = { id: createDenTypeId("inferenceProviderCredential"), kind: "api_key", secret: "sk-ant-fixture-0000000", expires_at: null, status: "active" }

const ANTHROPIC_STREAM = [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "O" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "K" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

function app(rows: GatewayMemberAccessRow[], options: { enabled?: boolean } = {}) {
  const sent: Request[] = []
  const api = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
  api.use("*", async (c, next) => {
    c.set("inference", { kind: "gateway", organizationId, orgMembershipId, keySource: "api_key", gatewayKeyId })
    c.set("openworkRequestId", "owr_fixture")
    c.set("organization", { id: organizationId, metadata: null })
    await next()
  })
  const providerRows: GatewayAccessRow[] = rows
  registerGatewayRoutes(api, {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      sent.push(request)
      const upstream: unknown = await request.clone().json()
      if (typeof upstream === "object" && upstream !== null && Reflect.get(upstream, "stream") === true) {
        return new Response(ANTHROPIC_STREAM, { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({
        id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5",
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 },
      })
    },
    insertRequestLog: async () => {},
    updateRequestLog: async () => true,
    reporter: { request: () => {}, handledError: () => {} },
    checkUsage: async () => null,
    loadGatewayProvider: async () => provider,
    loadGatewayAccess: async () => providerRows,
    loadMemberGatewayAccess: async () => rows,
    loadProviderCredential: async () => credential,
    catalog: createProviderCatalog({ anthropic: { npm: "@ai-sdk/anthropic", env: [] } }),
    autoRouterReasoning: createMemoryReasoningStore(),
    cursorEnabled: async () => options.enabled ?? true,
    now: () => now,
  })
  const chat = (model: string, extra: Record<string, unknown> = {}, path = "/api/v1/cursor/chat/completions") => api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  })
  return { api, sent, chat }
}

async function errorCode(response: Response) {
  const body: unknown = await response.json()
  const error: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "error") : null
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : null
}

test("a Cursor name is the model's name as a slug plus the end of its id", () => {
  assert.equal(cursorModelSlug("Claude Opus 5.5"), "claude-opus-5.5")
  assert.equal(cursorModelSlug("  GPT-5 (preview) "), "gpt-5-preview")
  assert.equal(cursorModelSlug("***"), "model")
  assert.equal(cursorModelName({ name: "Claude Opus 5.5", modelId: "ipm_01k9zzzzzzzzzzzzzzzzzzk3f9" }), "openwork/claude-opus-5.5-k3f9")
  assert.equal(cursorModelName({ name: "Claude Opus 5.5", modelId: "ipm_01k9zzzzzzzzzzzzzzzzzzk3f9", thinking: "high" }), "openwork/claude-opus-5.5-k3f9:high")
  assert.equal(cursorModelName({ name: "Claude Opus 5.5", modelId: "ipm_01k9zzzzzzzzzzzzzzzzzzk3f9", thinking: "default" }), "openwork/claude-opus-5.5-k3f9")
  assert.equal(cursorBaseUrl("https://gateway.example/api/v1/"), "https://gateway.example/api/v1/cursor")
})

test("a typed name is read forgivingly; anything else is refused", () => {
  assert.deepEqual(parseCursorModelName("openwork/claude-opus-5.5-k3f9"), { slug: "claude-opus-5.5", idSuffix: "k3f9", thinking: "default" })
  assert.deepEqual(parseCursorModelName("  OpenWork/Claude-Opus-5.5-K3F9:High "), { slug: "claude-opus-5.5", idSuffix: "k3f9", thinking: "high" })
  assert.deepEqual(parseCursorModelName("claude-opus-5.5-k3f9"), { slug: "claude-opus-5.5", idSuffix: "k3f9", thinking: "default" })
  for (const value of ["gpt-4o", "openwork/claude", "openwork/claude-opus-5.5-k3f9:turbo", "openwork/-k3f9", "", 42, null]) {
    assert.equal(parseCursorModelName(value), null, String(value))
  }
})

test("the id ending picks the model; the name only breaks a tie", () => {
  const opus = { name: "Claude Opus 5.5", modelId: "ipm_aaaaaaaaaaaaaaaaaaaaaak3f9" }
  const haiku = { name: "Claude Haiku 5.5", modelId: "ipm_bbbbbbbbbbbbbbbbbbbbbbk3f9" }
  const sonnet = { name: "Claude Sonnet 5.5", modelId: "ipm_cccccccccccccccccccccc7xq2" }
  const parse = (value: string) => {
    const parsed = parseCursorModelName(value)
    assert.ok(parsed)
    return parsed
  }
  // A renamed model keeps working: its ending is unique.
  assert.deepEqual(matchCursorModel(parse("openwork/old-name-7xq2"), [opus, haiku, sonnet]), { kind: "found", model: sonnet })
  assert.deepEqual(matchCursorModel(parse("openwork/claude-haiku-5.5-k3f9"), [opus, haiku, sonnet]), { kind: "found", model: haiku })
  assert.deepEqual(matchCursorModel(parse("openwork/something-else-k3f9"), [opus, haiku, sonnet]), { kind: "ambiguous" })
  assert.deepEqual(matchCursorModel(parse("openwork/claude-opus-5.5-zzzz"), [opus, haiku, sonnet]), { kind: "none" })
})

test("Cursor's flat tools become Chat Completions tools", () => {
  const body = normalizeCursorChatBody({
    tools: [
      { type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" } },
      { type: "function", function: { name: "already_nested" } },
    ],
    tool_choice: { type: "function", name: "read_file" },
  })
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } },
    { type: "function", function: { name: "already_nested" } },
  ])
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "read_file" } })
})

test("the model list carries Cursor names, one per model", async () => {
  const opus = accessRow({ modelId: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true })
  // The same model through a second group and credential set is still one entry.
  const again = { ...accessRow({ modelId: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true }), model: opus.model }
  const { api } = app([opus, again, accessRow({ modelId: "claude-haiku-5-5", name: "Claude Haiku 5.5" })])
  const response = await api.request("/api/v1/cursor/models")
  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  const data: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "data") : null
  assert.ok(Array.isArray(data))
  assert.deepEqual(data.map((entry: unknown) => typeof entry === "object" && entry !== null ? Reflect.get(entry, "name") : null), ["Claude Haiku 5.5", "Claude Opus 5.5"])
  const listed: unknown = data[1]
  assert.ok(typeof listed === "object" && listed !== null && opus.model)
  assert.equal(Reflect.get(listed, "id"), cursorModelName({ name: "Claude Opus 5.5", modelId: opus.model.id }))
  assert.deepEqual(Reflect.get(Reflect.get(listed, "openwork") ?? {}, "thinking_levels"), ["default", "low", "medium", "high"])
})

test("a chat request by Cursor name reaches the model's own API and answers as Chat Completions", async () => {
  const row = accessRow({ modelId: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true })
  assert.ok(row.model)
  const { sent, chat } = app([row])
  const response = await chat(cursorModelName({ name: row.model.name, modelId: row.model.id }), {
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } }],
  })
  assert.equal(response.status, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages")
  assert.equal(sent[0]?.headers.get("x-api-key"), "sk-ant-fixture-0000000")
  const upstream: unknown = await sent[0]?.json()
  assert.ok(typeof upstream === "object" && upstream !== null)
  assert.equal(Reflect.get(upstream, "model"), "claude-opus-5-5")
  const tools: unknown = Reflect.get(upstream, "tools")
  assert.ok(Array.isArray(tools))
  assert.equal(Reflect.get(tools[0] ?? {}, "name"), "read_file")
  const body: unknown = await response.json()
  assert.ok(typeof body === "object" && body !== null)
  assert.equal(Reflect.get(body, "object"), "chat.completion")
  const choices: unknown = Reflect.get(body, "choices")
  assert.ok(Array.isArray(choices))
  assert.equal(Reflect.get(Reflect.get(choices[0] ?? {}, "message") ?? {}, "content"), "OK")
  // Smart Router's own headers stay off Cursor responses.
  assert.equal(response.headers.get("x-openwork-auto-model"), null)
})

test("names that don't resolve are refused before anything is sent upstream", async () => {
  const row = accessRow({ modelId: "claude-haiku-5-5", name: "Claude Haiku 5.5" })
  assert.ok(row.model)
  const { sent, chat } = app([row])
  const name = cursorModelName({ name: row.model.name, modelId: row.model.id })

  const unknown = await chat("gpt-4o")
  assert.equal(unknown.status, 400)
  assert.equal(await errorCode(unknown), "invalid_cursor_model")

  const missing = await chat(`openwork/claude-haiku-5.5-${row.model.id.endsWith("zzzz") ? "yyyy" : "zzzz"}`)
  assert.equal(missing.status, 404)
  assert.equal(await errorCode(missing), "model_not_found")

  const thinking = await chat(`${name}:high`)
  assert.equal(thinking.status, 400)
  assert.equal(await errorCode(thinking), "unsupported_thinking_level")
  assert.equal(sent.length, 0)
})

test("with the feature off the endpoint does not exist", async () => {
  const row = accessRow({ modelId: "claude-haiku-5-5", name: "Claude Haiku 5.5" })
  assert.ok(row.model)
  const { api, sent, chat } = app([row], { enabled: false })
  assert.equal((await api.request("/api/v1/cursor/models")).status, 404)
  assert.equal((await chat(cursorModelName({ name: row.model.name, modelId: row.model.id }))).status, 404)
  assert.equal(sent.length, 0)
})

test("the Responses API reaches the same model, and answers as a Responses object", async () => {
  const row = accessRow({ modelId: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true })
  assert.ok(row.model)
  const { api, sent } = app([row])
  const name = cursorModelName({ name: row.model.name, modelId: row.model.id })
  const response = await api.request("/api/v1/cursor/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: name,
      instructions: "Be brief.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: {} } }],
      reasoning: { effort: "high" },
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(sent[0]?.url, "https://api.anthropic.com/v1/messages")
  const upstream: unknown = await sent[0]?.json()
  assert.ok(typeof upstream === "object" && upstream !== null)
  assert.deepEqual(Reflect.get(upstream, "system"), [{ type: "text", text: "Be brief." }])
  // reasoning.effort is used when the name has no level.
  assert.deepEqual(Reflect.get(upstream, "output_config"), { effort: "high" })
  const body: unknown = await response.json()
  assert.ok(typeof body === "object" && body !== null)
  assert.equal(Reflect.get(body, "object"), "response")
  assert.equal(Reflect.get(body, "status"), "completed")
  assert.equal(Reflect.get(body, "model"), name)
  const output: unknown = Reflect.get(body, "output")
  assert.ok(Array.isArray(output))
  assert.deepEqual(output.map((item: unknown) => typeof item === "object" && item !== null ? Reflect.get(item, "type") : null), ["message"])
  assert.equal(Reflect.get(Reflect.get(output[0] ?? {}, "content")?.[0] ?? {}, "text"), "OK")
})

test("a streamed Responses request gets Responses events, text and tool call included", async () => {
  const row = accessRow({ modelId: "claude-opus-5-5", name: "Claude Opus 5.5" })
  assert.ok(row.model)
  const { api } = app([row])
  const response = await api.request("/api/v1/cursor/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cursorModelName({ name: row.model.name, modelId: row.model.id }), input: "hi", stream: true }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
  const text = await response.text()
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
  assert.equal(events[0], "response.created")
  assert.ok(events.includes("response.output_text.delta"))
  assert.ok(events.includes("response.function_call_arguments.delta"))
  assert.equal(events[events.length - 1], "response.completed")
  const completed = text.split("\n\n").find((block) => block.startsWith("event: response.completed"))
  const data: unknown = JSON.parse(completed?.split("data: ")[1] ?? "null")
  const output: unknown = typeof data === "object" && data !== null ? Reflect.get(Reflect.get(data, "response") ?? {}, "output") : null
  assert.ok(Array.isArray(output))
  assert.deepEqual(output.map((item: unknown) => typeof item === "object" && item !== null ? Reflect.get(item, "type") : null), ["message", "function_call"])
  assert.equal(Reflect.get(output[0]?.content?.[0] ?? {}, "text"), "OK")
  assert.equal(Reflect.get(output[1] ?? {}, "call_id"), "toolu_1")
  assert.equal(Reflect.get(output[1] ?? {}, "arguments"), "{\"path\":\"a.ts\"}")
})

test("a Responses conversation with tool calls becomes the same chat conversation", async () => {
  const { responsesToChat } = await import("../src/cursor-responses.js")
  const chat = responsesToChat({
    model: "openwork/x-abcd",
    instructions: "System prompt",
    input: [
      { role: "developer", content: "Extra rules" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Read a.ts" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] },
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
      { type: "function_call", call_id: "call_2", name: "read_file", arguments: "{\"path\":\"b.ts\"}" },
      { type: "function_call_output", call_id: "call_1", output: "contents a" },
      { type: "function_call_output", call_id: "call_2", output: "contents b" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
    ],
    max_output_tokens: 100,
    stream: true,
  })
  assert.deepEqual(chat.messages, [
    { role: "system", content: "System prompt" },
    { role: "system", content: "Extra rules" },
    { role: "user", content: [{ type: "text", text: "Read a.ts" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
    { role: "assistant", content: null, tool_calls: [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { id: "call_2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.ts\"}" } },
    ] },
    { role: "tool", tool_call_id: "call_1", content: "contents a" },
    { role: "tool", tool_call_id: "call_2", content: "contents b" },
    { role: "assistant", content: "Done" },
  ])
  assert.equal(chat.max_tokens, 100)
  assert.equal(chat.stream, true)
})

test("other paths under /api/v1/cursor are 404", async () => {
  const { api, sent } = app([accessRow({ modelId: "claude-haiku-5-5", name: "Claude Haiku 5.5" })])
  for (const path of ["/api/v1/cursor/completions", "/api/v1/cursor/embeddings"]) {
    const response = await api.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    assert.equal(response.status, 404, path)
  }
  assert.equal(sent.length, 0)
})

test("only Gateway keys reach /cursor; the OpenWork Models key store is never consulted", async () => {
  const { registerProxyRoutes } = await import("../src/proxy.js")
  let modelsLookups = 0
  let gatewayLookups = 0
  const app = new Hono()
  registerProxyRoutes(app, {
    findActiveGatewayKey: async () => { gatewayLookups += 1; return null },
    findActiveInferenceKey: async () => { modelsLookups += 1; return null },
    assertOrganizationManagedModelsAllowed: async () => {},
    getOpenRouterProviderKey: async () => null,
    ensureUsableBuckets: async () => ({ ok: true, admittedAt: now }),
    fetch: async () => new Response(null, { status: 500 }),
    loadOrganization: async () => null,
    insertRequestLog: async () => {},
  })
  for (const path of ["/api/v1/cursor/models", "/api/v1/cursor/completions"]) {
    const response = await app.request(path, { method: path.endsWith("models") ? "GET" : "POST", headers: { authorization: "Bearer ow_inf_not_a_gateway_key" } })
    assert.equal(response.status, 401, path)
  }
  assert.equal(modelsLookups, 0)
  assert.equal(gatewayLookups, 0)
})
