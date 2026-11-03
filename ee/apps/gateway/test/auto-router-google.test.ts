import assert from "node:assert/strict"
import { test } from "node:test"
import type { AutoRouteInfo, JsonObject } from "../src/auto-router/chat.js"
import { geminiThinkingConfig, googleTranslator, sanitizeGeminiSchema, SKIP_THOUGHT_SIGNATURE } from "../src/auto-router/google.js"
import type { TranslateRequestInput } from "../src/auto-router/protocol.js"
import type { ReasoningPayload } from "../src/auto-router/reasoning-store.js"

const route: AutoRouteInfo = { provider: "google", model: "gemini-3-pro-preview", thinking: "high", reason: "jev" }

function request(body: JsonObject, overrides: Partial<TranslateRequestInput> = {}): TranslateRequestInput {
  return { body, model: "gwm_alias", upstreamModel: "gemini-3-pro-preview", thinkingLevel: "default", maxOutputTokens: null, reasoning: new Map(), ...overrides }
}

function stream(text: string, splits: number[] = [37]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text)
      let from = 0
      for (const at of splits) { controller.enqueue(bytes.slice(from, at)); from = at }
      controller.enqueue(bytes.slice(from))
      controller.close()
    },
  })
}

async function readAll(body: ReadableStream<Uint8Array>) {
  return new Response(body).text()
}

function dataEvents(text: string) {
  return text.split("\n\n").flatMap((event) => event.startsWith("data: ") ? [event.slice(6)] : [])
}

function parseJson(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text)
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
  return Object.fromEntries(Object.entries(parsed))
}

test("google request: path, system, images, files, and generation config", () => {
  const out = googleTranslator.toUpstream(request({
    model: "auto",
    stream: true,
    max_tokens: 4096,
    temperature: 0.3,
    top_p: 0.9,
    stop: "END",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Use tools." }] },
      { role: "user", content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://example.com/cat.webp?x=1" } },
        { type: "image_url", image_url: { url: "https://example.com/photo" } },
        { type: "file", file: { file_data: "data:application/pdf;base64,JVBE" } },
      ] },
    ],
  }))
  assert.equal(out.rest, "models/gwm_alias:streamGenerateContent")
  assert.equal(out.search, "?alt=sse")
  assert.equal(out.protocol, "google_generate_content")
  assert.deepEqual(out.headers, {})
  assert.equal(out.body.model, undefined)
  assert.equal(out.body.stream, undefined)
  assert.deepEqual(out.body.systemInstruction, { parts: [{ text: "Be brief." }, { text: "Use tools." }] })
  assert.deepEqual(out.body.contents, [{ role: "user", parts: [
    { text: "What is this?" },
    { inlineData: { mimeType: "image/png", data: "AAAA" } },
    { fileData: { mimeType: "image/webp", fileUri: "https://example.com/cat.webp?x=1" } },
    { fileData: { mimeType: "image/jpeg", fileUri: "https://example.com/photo" } },
    { inlineData: { mimeType: "application/pdf", data: "JVBE" } },
  ] }])
  assert.deepEqual(out.body.generationConfig, { maxOutputTokens: 4096, temperature: 0.3, topP: 0.9, stopSequences: ["END"] })

  const plain = googleTranslator.toUpstream(request({ messages: [{ role: "user", content: "hi" }] }, { maxOutputTokens: 65_536 }))
  assert.equal(plain.rest, "models/gwm_alias:generateContent")
  assert.equal(plain.search, "")
  assert.deepEqual(plain.body.generationConfig, { maxOutputTokens: 65_536 })
})

test("google request: tools, sanitized schemas, and tool choice", () => {
  const out = googleTranslator.toUpstream(request({
    messages: [{ role: "user", content: "Read it" }],
    tools: [
      { type: "function", function: { name: "read", description: "Read a file", parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", default: "a.txt", examples: ["b.txt"], format: "uri" },
          limit: { type: ["integer", "null"], exclusiveMinimum: 0 },
          mode: { const: "fast" },
          options: { $ref: "#/$defs/Options" },
          tags: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
        },
        required: ["path", "missing"],
        $defs: { Options: { type: "object", properties: { deep: { type: "boolean" } } } },
      } } },
      { type: "function", function: { name: "now", parameters: { type: "object", properties: {} } } },
      { type: "web_search" },
    ],
    tool_choice: { type: "function", function: { name: "read" } },
  }))
  assert.deepEqual(out.body.tools, [{ functionDeclarations: [
    { name: "read", description: "Read a file", parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer", nullable: true },
        mode: { type: "string", enum: ["fast"] },
        options: { type: "object", properties: { deep: { type: "boolean" } } },
        tags: { type: "array", items: { type: "string", nullable: true } },
      },
      required: ["path"],
    } },
    { name: "now" },
  ] }])
  assert.deepEqual(out.body.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read"] } })

  const choice = (tool_choice: unknown) => googleTranslator.toUpstream(request({
    messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { a: { type: "string" } } } } }],
    tool_choice,
  })).body.toolConfig
  assert.deepEqual(choice("none"), { functionCallingConfig: { mode: "NONE" } })
  assert.deepEqual(choice("required"), { functionCallingConfig: { mode: "ANY" } })
  assert.deepEqual(choice("auto"), { functionCallingConfig: { mode: "AUTO" } })
})

test("google schema sanitizer survives recursive refs and unions", () => {
  const recursive = sanitizeGeminiSchema({ type: "object", properties: { node: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } } })
  assert.equal(recursive.type, "object")
  assert.deepEqual(sanitizeGeminiSchema({ anyOf: [{ type: "string" }, { type: "number" }] }), { anyOf: [{ type: "string" }, { type: "number" }] })
  assert.deepEqual(sanitizeGeminiSchema({ $ref: "#/nowhere", description: "x" }), { description: "x" })
})

test("google request: tool calls, named tool results, and thought signature replay", () => {
  const reasoning = new Map<string, ReasoningPayload>([["call_a", { kind: "google", blocks: [{ thoughtSignature: "sig-a" }] }]])
  const body: JsonObject = {
    messages: [
      { role: "user", content: "Read both" },
      { role: "assistant", content: "Reading.", tool_calls: [
        { id: "call_a", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } },
        { id: "call_b", type: "function", function: { name: "list", arguments: "" } },
      ] },
      { role: "tool", tool_call_id: "call_a", content: "{\"ok\":true}" },
      { role: "tool", tool_call_id: "call_b", content: [{ type: "text", text: "a b c" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_c", type: "function", function: { name: "read", arguments: "{\"path\":\"c\"}" } }] },
      { role: "tool", tool_call_id: "call_c", content: "not json" },
    ],
  }
  const out = googleTranslator.toUpstream(request(body, { reasoning }))
  assert.deepEqual(out.body.contents, [
    { role: "user", parts: [{ text: "Read both" }] },
    { role: "model", parts: [
      { text: "Reading." },
      { functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "sig-a" },
      { functionCall: { name: "list", args: {} } },
    ] },
    { role: "user", parts: [
      { functionResponse: { name: "read", response: { ok: true } } },
      { functionResponse: { name: "list", response: { content: "a b c" } } },
    ] },
    { role: "model", parts: [{ functionCall: { name: "read", args: { path: "c" } }, thoughtSignature: SKIP_THOUGHT_SIGNATURE }] },
    { role: "user", parts: [{ functionResponse: { name: "read", response: { content: "not json" } } }] },
  ])

  // Gemini 2.5 does not validate signatures: no placeholder.
  const older = googleTranslator.toUpstream(request(body, { upstreamModel: "gemini-2.5-flash" }))
  const contents = Array.isArray(older.body.contents) ? older.body.contents : []
  assert.deepEqual(contents[3], { role: "model", parts: [{ functionCall: { name: "read", args: { path: "c" } } }] })
})

test("google request: thinking config by model generation", () => {
  const config = (upstreamModel: string, thinkingLevel: TranslateRequestInput["thinkingLevel"]) => {
    const generation = googleTranslator.toUpstream(request({ messages: [{ role: "user", content: "x" }] }, { upstreamModel, thinkingLevel })).body.generationConfig
    return typeof generation === "object" && generation !== null ? Reflect.get(generation, "thinkingConfig") : undefined
  }
  assert.equal(config("gemini-3-flash-preview", "default"), undefined)
  assert.deepEqual(config("gemini-3-flash-preview", "none"), { includeThoughts: true, thinkingLevel: "minimal" })
  assert.deepEqual(config("gemini-3-flash-preview", "medium"), { includeThoughts: true, thinkingLevel: "medium" })
  assert.deepEqual(config("gemini-3-pro-preview", "max"), { includeThoughts: true, thinkingLevel: "high" })
  assert.deepEqual(config("gemini-3-pro-preview", "minimal"), { includeThoughts: true, thinkingLevel: "low" })
  assert.deepEqual(config("gemini-2.5-flash", "none"), { thinkingBudget: 0 })
  assert.deepEqual(config("gemini-2.5-flash", "low"), { includeThoughts: true, thinkingBudget: 1024 })
  assert.deepEqual(config("gemini-2.5-pro", "high"), { includeThoughts: true, thinkingBudget: 24_576 })
  assert.deepEqual(config("gemini-2.5-pro", "xhigh"), { includeThoughts: true, thinkingBudget: -1 })
  assert.deepEqual(config("gemini-2.5-pro", "none"), { includeThoughts: true, thinkingBudget: 128 })
  assert.equal(geminiThinkingConfig("gemini-2.0-flash", "high"), null)
})

test("google stream: thoughts, text, function calls with remembered signature, usage, [DONE]", async () => {
  const remembered: Array<{ ids: string[]; payload: ReasoningPayload }> = []
  const events = [
    ": keepalive",
    `data: ${JSON.stringify({ responseId: "resp_1", candidates: [{ content: { role: "model", parts: [{ text: "Thinking it over", thought: true }] } }] })}`,
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Let me check." }] } }] })}`,
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [
      { functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "sig-1" },
      { functionCall: { name: "list", args: {} } },
    ] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 40, totalTokenCount: 150 } })}`,
  ]
  const text = events.join("\r\n\r\n") + "\r\n\r\n"
  const out = await readAll(googleTranslator.streamToChat(stream(text, [5, 60, 61, 200]), { route, stream: true, remember: (ids, payload) => remembered.push({ ids, payload }) }))
  assert.ok(out.startsWith(": keepalive\n\n"))
  const data = dataEvents(out)
  assert.equal(data.at(-1), "[DONE]")
  const chunks = data.slice(0, -1).map(parseJson)
  const deltas = chunks.map((chunk) => {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const first: unknown = choices[0]
    return typeof first === "object" && first !== null ? Reflect.get(first, "delta") : undefined
  })
  assert.equal(chunks[0]?.id, "resp_1")
  assert.equal(chunks[0]?.model, "gemini-3-pro-preview")
  assert.deepEqual(chunks[0]?.openwork_route, route)
  assert.deepEqual(deltas[0], { role: "assistant", content: "" })
  assert.deepEqual(deltas[1], { reasoning_content: "Thinking it over" })
  assert.deepEqual(deltas[2], { content: "Let me check." })
  const firstCall = parseJson(JSON.stringify(deltas[3]))
  const secondCall = parseJson(JSON.stringify(deltas[4]))
  const callOf = (delta: JsonObject) => {
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    return parseJson(JSON.stringify(calls[0]))
  }
  const a = callOf(firstCall)
  const b = callOf(secondCall)
  assert.equal(a.index, 0)
  assert.equal(b.index, 1)
  assert.match(String(a.id), /^call_[A-Za-z0-9_]{1,59}$/)
  assert.notEqual(a.id, b.id)
  assert.deepEqual(a.function, { name: "read", arguments: "{\"path\":\"a\"}" })
  assert.deepEqual(b.function, { name: "list", arguments: "{}" })
  assert.deepEqual(remembered, [{ ids: [String(a.id)], payload: { kind: "google", blocks: [{ thoughtSignature: "sig-1" }] } }])

  const final = chunks.at(-2)
  assert.deepEqual(final?.choices, [{ index: 0, delta: {}, finish_reason: "tool_calls" }])
  assert.deepEqual(chunks.at(-1)?.usage, {
    prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 30 },
  })
  assert.deepEqual(chunks.at(-1)?.choices, [])

  // The remembered signature replays on the next request.
  const reasoning = new Map(remembered.flatMap(({ ids, payload }) => ids.map((id): [string, ReasoningPayload] => [id, payload])))
  const next = googleTranslator.toUpstream(request({ messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [{ id: a.id, type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
    { role: "tool", tool_call_id: a.id, content: "done" },
  ] }, { reasoning }))
  const contents = Array.isArray(next.body.contents) ? next.body.contents : []
  assert.deepEqual(contents[1], { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "sig-1" }] })
})

test("google stream: max tokens, safety, and errors", async () => {
  const run = async (events: JsonObject[]) => dataEvents(await readAll(googleTranslator.streamToChat(
    stream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
    { route, stream: true, remember: () => {} },
  )))
  const reasonOf = (data: string[]) => {
    const chunk = parseJson(data.at(-3) ?? "{}")
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const first: unknown = choices[0]
    return typeof first === "object" && first !== null ? Reflect.get(first, "finish_reason") : undefined
  }
  assert.equal(reasonOf(await run([{ candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "MAX_TOKENS" }] }])), "length")
  assert.equal(reasonOf(await run([{ candidates: [{ finishReason: "SAFETY" }] }])), "content_filter")
  assert.equal(reasonOf(await run([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }])), "stop")

  const failed = await run([
    { candidates: [{ content: { parts: [{ text: "a" }] } }] },
    { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } },
  ])
  assert.deepEqual(parseJson(failed.at(-1) ?? "{}"), { error: { message: "The model is overloaded.", type: "unavailable", code: "UNAVAILABLE" } })
  assert.ok(!failed.includes("[DONE]"))
})

test("google json: text, reasoning, tool calls, usage", () => {
  const remembered: Array<{ ids: string[]; payload: ReasoningPayload }> = []
  const out = googleTranslator.jsonToChat({
    responseId: "resp_2",
    candidates: [{ content: { role: "model", parts: [
      { text: "Hmm.", thought: true },
      { text: "Here you go." },
      { functionCall: { name: "read", args: { path: "x" } }, thoughtSignature: "sig-2" },
    ] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 22 },
  }, { route, stream: false, remember: (ids, payload) => remembered.push({ ids, payload }) })
  assert.equal(out.id, "resp_2")
  assert.equal(out.object, "chat.completion")
  assert.equal(out.model, "gemini-3-pro-preview")
  assert.deepEqual(out.openwork_route, route)
  const choices = Array.isArray(out.choices) ? out.choices : []
  const choice = parseJson(JSON.stringify(choices[0]))
  assert.equal(choice.finish_reason, "tool_calls")
  const message = parseJson(JSON.stringify(choice.message))
  assert.equal(message.content, "Here you go.")
  assert.equal(message.reasoning_content, "Hmm.")
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => parseJson(JSON.stringify(call))) : []
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.function, { name: "read", arguments: "{\"path\":\"x\"}" })
  assert.deepEqual(remembered, [{ ids: [String(calls[0]?.id)], payload: { kind: "google", blocks: [{ thoughtSignature: "sig-2" }] } }])
  assert.deepEqual(out.usage, {
    prompt_tokens: 10, completion_tokens: 12, total_tokens: 22,
    prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 7 },
  })

  const blocked = googleTranslator.jsonToChat({ promptFeedback: { blockReason: "SAFETY" } }, { route, stream: false, remember: () => {} })
  assert.deepEqual(blocked.choices, [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "content_filter" }])
})

test("google errors become chat errors", () => {
  assert.deepEqual(
    googleTranslator.errorToChat({ error: { code: 400, message: "Invalid JSON payload.", status: "INVALID_ARGUMENT" } }, 400),
    { error: { message: "Invalid JSON payload.", type: "invalid_argument", code: "INVALID_ARGUMENT" } },
  )
  assert.deepEqual(
    googleTranslator.errorToChat([{ error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } }], 429),
    { error: { message: "Quota exceeded.", type: "resource_exhausted", code: "RESOURCE_EXHAUSTED" } },
  )
  assert.deepEqual(googleTranslator.errorToChat(null, 502), { error: { message: "The provider failed with HTTP 502.", type: "api_error", code: null } })
  assert.deepEqual(googleTranslator.errorToChat({ error: { code: 500 } }, 500), { error: { message: "The provider rejected this request.", type: "api_error", code: "500" } })
})
