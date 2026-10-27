import assert from "node:assert/strict"
import { test } from "node:test"
import { bedrockTranslator, converseErrorToChat, converseJsonToChat, toConverseBody } from "../src/auto-router/bedrock.js"
import type { AutoRouteInfo, JsonObject } from "../src/auto-router/chat.js"
import type { ReasoningPayload } from "../src/auto-router/reasoning-store.js"
import type { TranslateRequestInput } from "../src/auto-router/protocol.js"

const route: AutoRouteInfo = { provider: "bedrock", model: "anthropic.claude-opus-5", thinking: "high", reason: "jev" }

function request(body: JsonObject, overrides: Partial<TranslateRequestInput> = {}): TranslateRequestInput {
  return {
    body,
    model: "gwm_alias/1",
    upstreamModel: "us.anthropic.claude-opus-5-v1:0",
    thinkingLevel: "default",
    maxOutputTokens: null,
    reasoning: new Map(),
    ...overrides,
  }
}

// --- AWS event-stream encoder (string headers only, as Bedrock sends) ---
const textEncoder = new TextEncoder()

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const headerBytes: number[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = textEncoder.encode(name)
    const valueBytes = textEncoder.encode(value)
    headerBytes.push(nameBytes.length, ...nameBytes, 7, (valueBytes.length >> 8) & 0xff, valueBytes.length & 0xff, ...valueBytes)
  }
  const body = textEncoder.encode(JSON.stringify(payload))
  const total = 12 + headerBytes.length + body.length + 4
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerBytes.length)
  view.setUint32(8, crc32(out.subarray(0, 8)))
  out.set(headerBytes, 12)
  out.set(body, 12 + headerBytes.length)
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)))
  return out
}

function event(type: string, payload: unknown) {
  return frame({ ":event-type": type, ":content-type": "application/json", ":message-type": "event" }, payload)
}

function bytesStream(frames: Uint8Array[], splitEvery: number) {
  const all = new Uint8Array(frames.reduce((sum, item) => sum + item.length, 0))
  let offset = 0
  for (const item of frames) { all.set(item, offset); offset += item.length }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < all.length; index += splitEvery) controller.enqueue(all.slice(index, index + splitEvery))
      controller.close()
    },
  })
}

async function readSse(body: ReadableStream<Uint8Array>) {
  const text = await new Response(body).text()
  const events = text.split("\n\n").filter(Boolean).map((block) => block.replace(/^data: /, ""))
  return { text, events, json: events.filter((data) => data !== "[DONE]").map((data): JsonObject => JSON.parse(data)) }
}

function deltas(json: JsonObject[]) {
  return json.flatMap((item) => {
    const choices = Array.isArray(item.choices) ? item.choices : []
    const first: unknown = choices[0]
    return first && typeof first === "object" && "delta" in first ? [first.delta] : []
  })
}

test("toUpstream puts the alias in the path and picks converse-stream for streams", () => {
  const streamed = bedrockTranslator.toUpstream(request({ stream: true, messages: [{ role: "user", content: "hi" }] }))
  assert.equal(streamed.rest, "model/gwm_alias%2F1/converse-stream")
  assert.equal(streamed.protocol, "bedrock_converse")
  assert.equal(streamed.search, "")
  assert.deepEqual(streamed.headers, {})
  assert.equal(streamed.body.model, undefined)
  assert.equal(streamed.body.stream, undefined)
  const plain = bedrockTranslator.toUpstream(request({ messages: [{ role: "user", content: "hi" }] }))
  assert.equal(plain.rest, "model/gwm_alias%2F1/converse")
})

test("messages, tools, tool results and images translate to Converse", () => {
  const body = toConverseBody({
    max_tokens: 1000,
    temperature: 1.5,
    top_p: 0.9,
    stop: "END",
    tool_choice: "required",
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Use tools." }] },
      { role: "user", content: [
        { type: "text", text: "Look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        { type: "file", file: { file_data: "data:application/pdf;base64,JVBE" } },
      ] },
      { role: "user", content: "again" },
      { role: "assistant", content: "Reading.", tool_calls: [{ id: "tool_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }] },
      { role: "tool", tool_call_id: "tool_1", content: "{\"ok\":true}" },
      { role: "tool", tool_call_id: "tool_2", content: "plain text" },
    ],
  }, { upstreamModel: "amazon.nova-pro-v1:0", thinkingLevel: "high", maxOutputTokens: null })

  assert.deepEqual(body.system, [{ text: "Be brief." }, { text: "Use tools." }])
  assert.deepEqual(body.messages, [
    { role: "user", content: [
      { text: "Look" },
      { image: { format: "png", source: { bytes: "AAAA" } } },
      { text: "[Image omitted: https://example.com/cat.png]" },
      { document: { format: "pdf", name: "document", source: { bytes: "JVBE" } } },
      { text: "again" },
    ] },
    { role: "assistant", content: [{ text: "Reading." }, { toolUse: { toolUseId: "tool_1", name: "read", input: { path: "a.txt" } } }] },
    { role: "user", content: [
      { toolResult: { toolUseId: "tool_1", content: [{ json: { ok: true } }] } },
      { toolResult: { toolUseId: "tool_2", content: [{ text: "plain text" }] } },
    ] },
  ])
  assert.deepEqual(body.toolConfig, {
    tools: [{ toolSpec: { name: "read", description: "Read a file", inputSchema: { json: { type: "object", properties: { path: { type: "string" } } } } } }],
    toolChoice: { any: {} },
  })
  // Non-Claude: no thinking fields, sampling kept as sent.
  assert.equal(body.additionalModelRequestFields, undefined)
  assert.deepEqual(body.inferenceConfig, { maxTokens: 1000, temperature: 1.5, topP: 0.9, stopSequences: ["END"] })
})

test("tool_choice maps to Converse and none omits tools", () => {
  const tools = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
  const messages = [{ role: "user", content: "hi" }]
  const named = toConverseBody({ messages, tools, tool_choice: { type: "function", function: { name: "read" } } }, { upstreamModel: "amazon.nova", thinkingLevel: "default", maxOutputTokens: 500 })
  assert.deepEqual(named.toolConfig, { tools: [{ toolSpec: { name: "read", inputSchema: { json: { type: "object" } } } }], toolChoice: { tool: { name: "read" } } })
  assert.deepEqual(named.inferenceConfig, { maxTokens: 500 })
  const auto = toConverseBody({ messages, tools }, { upstreamModel: "amazon.nova", thinkingLevel: "default", maxOutputTokens: null })
  assert.deepEqual(Reflect.get(auto.toolConfig ?? {}, "toolChoice"), { auto: {} })
  assert.equal(auto.inferenceConfig, undefined)
  const none = toConverseBody({ messages, tools, tool_choice: "none" }, { upstreamModel: "amazon.nova", thinkingLevel: "default", maxOutputTokens: null })
  assert.equal(none.toolConfig, undefined)
})

test("Claude 4.6+ thinking uses adaptive effort and drops sampling", () => {
  const messages = [{ role: "user", content: "hi" }]
  const high = toConverseBody({ messages, temperature: 0.5, top_p: 0.9 }, { upstreamModel: "us.anthropic.claude-opus-5-v1:0", thinkingLevel: "high", maxOutputTokens: 64000 })
  assert.deepEqual(high.additionalModelRequestFields, { thinking: { type: "adaptive" }, output_config: { effort: "high" } })
  assert.deepEqual(high.inferenceConfig, { maxTokens: 64000 })
  const none = toConverseBody({ messages, temperature: 0.5 }, { upstreamModel: "anthropic.claude-sonnet-4-6", thinkingLevel: "none", maxOutputTokens: null })
  assert.deepEqual(none.additionalModelRequestFields, { thinking: { type: "disabled" } })
  assert.deepEqual(none.inferenceConfig, { temperature: 0.5 })
  const fallback = toConverseBody({ messages }, { upstreamModel: "anthropic.claude-opus-5", thinkingLevel: "default", maxOutputTokens: null })
  assert.equal(fallback.additionalModelRequestFields, undefined)
  const older = toConverseBody({ messages }, { upstreamModel: "anthropic.claude-3-7-sonnet-20250219-v1:0", thinkingLevel: "high", maxOutputTokens: null })
  assert.equal(older.additionalModelRequestFields, undefined)
  const nonClaude = toConverseBody({ messages }, { upstreamModel: "meta.llama4-maverick-17b-instruct-v1:0", thinkingLevel: "high", maxOutputTokens: null })
  assert.equal(nonClaude.additionalModelRequestFields, undefined)
})

test("remembered reasoning is replayed before the tool use; missing reasoning turns thinking off", () => {
  const messages = [
    { role: "user", content: "read it" },
    { role: "assistant", content: null, tool_calls: [{ id: "tool_1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "tool_1", content: "done" },
  ]
  const blocks = [{ reasoningContent: { reasoningText: { text: "think", signature: "sig" } } }]
  const reasoning = new Map<string, ReasoningPayload>([["tool_1", { kind: "bedrock", blocks }]])
  const replayed = toConverseBody({ messages }, { upstreamModel: "anthropic.claude-opus-5", thinkingLevel: "high", maxOutputTokens: null, reasoning })
  const list = Array.isArray(replayed.messages) ? replayed.messages : []
  assert.deepEqual(list[1], { role: "assistant", content: [...blocks, { toolUse: { toolUseId: "tool_1", name: "read", input: {} } }] })
  assert.deepEqual(replayed.additionalModelRequestFields, { thinking: { type: "adaptive" }, output_config: { effort: "high" } })

  const otherKind = new Map<string, ReasoningPayload>([["tool_1", { kind: "anthropic", blocks: [{ type: "thinking" }] }]])
  const missing = toConverseBody({ messages }, { upstreamModel: "anthropic.claude-opus-5", thinkingLevel: "high", maxOutputTokens: null, reasoning: otherKind })
  const missingList = Array.isArray(missing.messages) ? missing.messages : []
  assert.deepEqual(missingList[1], { role: "assistant", content: [{ toolUse: { toolUseId: "tool_1", name: "read", input: {} } }] })
  assert.deepEqual(missing.additionalModelRequestFields, { thinking: { type: "disabled" } })
})

test("the event stream becomes chat SSE, even with frames split across chunks", async () => {
  const frames = [
    event("messageStart", { role: "assistant", p: "abc" }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Let me " } } }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "think." } } }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "SIG" } } }),
    event("contentBlockStop", { contentBlockIndex: 0 }),
    event("contentBlockDelta", { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: "UkVE" } } }),
    event("contentBlockDelta", { contentBlockIndex: 2, delta: { text: "Héllo ✓" } }),
    event("contentBlockStart", { contentBlockIndex: 3, start: { toolUse: { toolUseId: "tooluse_1", name: "read" } } }),
    event("contentBlockDelta", { contentBlockIndex: 3, delta: { toolUse: { input: "{\"path\":" } } }),
    event("contentBlockDelta", { contentBlockIndex: 3, delta: { toolUse: { input: "\"a\"}" } } }),
    event("contentBlockStop", { contentBlockIndex: 3 }),
    event("messageStop", { stopReason: "tool_use" }),
    event("metadata", { usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheWriteInputTokens: 2 }, metrics: { latencyMs: 1 } }),
  ]
  const remembered: Array<{ ids: string[]; payload: ReasoningPayload }> = []
  const out = bedrockTranslator.streamToChat(bytesStream(frames, 7), { route, stream: true, remember: (ids, payload) => remembered.push({ ids, payload }) })
  const { events, json } = await readSse(out)
  assert.equal(events.at(-1), "[DONE]")
  assert.deepEqual(json[0]?.openwork_route, route)
  const all = deltas(json)
  assert.deepEqual(all[0], { role: "assistant", content: "" })
  assert.equal(all.flatMap((delta) => typeof delta === "object" && delta && "reasoning_content" in delta ? [delta.reasoning_content] : []).join(""), "Let me think.")
  assert.equal(all.flatMap((delta) => typeof delta === "object" && delta && "content" in delta ? [delta.content] : []).join(""), "Héllo ✓")
  assert.deepEqual(all.filter((delta) => typeof delta === "object" && delta && "tool_calls" in delta), [
    { tool_calls: [{ index: 0, id: "tooluse_1", type: "function", function: { name: "read", arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "\"a\"}" } }] },
  ])
  const finish = json.at(-2)
  assert.deepEqual(finish?.choices, [{ index: 0, delta: {}, finish_reason: "tool_calls" }])
  assert.deepEqual(json.at(-1)?.usage, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } })
  assert.deepEqual(remembered, [{
    ids: ["tooluse_1"],
    payload: { kind: "bedrock", blocks: [
      { reasoningContent: { reasoningText: { text: "Let me think.", signature: "SIG" } } },
      { reasoningContent: { redactedContent: "UkVE" } },
    ] },
  }])
})

test("a stream without metadata still finishes; no tool calls means nothing remembered", async () => {
  const frames = [
    event("messageStart", { role: "assistant" }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "hm", } } }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "S" } } }),
    event("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "ok" } }),
    event("messageStop", { stopReason: "max_tokens" }),
  ]
  let calls = 0
  const { events, json } = await readSse(bedrockTranslator.streamToChat(bytesStream(frames, 1), { route, stream: true, remember: () => { calls++ } }))
  assert.equal(events.at(-1), "[DONE]")
  assert.deepEqual(json.at(-2)?.choices, [{ index: 0, delta: {}, finish_reason: "length" }])
  assert.equal(calls, 0)
})

test("exception events become a chat error event", async () => {
  const frames = [
    event("messageStart", { role: "assistant" }),
    frame({ ":exception-type": "throttlingException", ":content-type": "application/json", ":message-type": "exception" }, { message: "Too many requests, please wait." }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "ignored" } }),
  ]
  const { events, json } = await readSse(bedrockTranslator.streamToChat(bytesStream(frames, 64), { route, stream: true, remember: () => {} }))
  assert.notEqual(events.at(-1), "[DONE]")
  assert.deepEqual(json.at(-1), { error: { message: "Too many requests, please wait.", type: "throttlingException", code: "throttlingException" } })
  assert.equal(json.length, 2)
})

test("a malformed event stream becomes a chat error event", async () => {
  const garbage = new Uint8Array(16)
  new DataView(garbage.buffer).setUint32(0, 2)
  const { json } = await readSse(bedrockTranslator.streamToChat(bytesStream([garbage], 16), { route, stream: true, remember: () => {} }))
  assert.equal(json.length, 1)
  assert.equal(Reflect.get(json[0]?.error ?? {}, "type"), "api_error")
})

test("a Converse JSON response becomes a chat completion", () => {
  const remembered: Array<{ ids: string[]; payload: ReasoningPayload }> = []
  const reasoningBlock = { reasoningContent: { reasoningText: { text: "Plan.", signature: "SIG" } } }
  const chat = converseJsonToChat({
    output: { message: { role: "assistant", content: [
      reasoningBlock,
      { reasoningContent: { reasoningText: { text: "unsigned" } } },
      { text: "Reading " },
      { text: "now." },
      { toolUse: { toolUseId: "tooluse_9", name: "read", input: { path: "b" } } },
    ] } },
    stopReason: "tool_use",
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10, cacheReadInputTokens: 1 },
  }, route, (ids, payload) => remembered.push({ ids, payload }))
  assert.equal(chat.object, "chat.completion")
  assert.deepEqual(chat.openwork_route, route)
  assert.deepEqual(chat.choices, [{
    index: 0,
    message: {
      role: "assistant",
      content: "Reading now.",
      reasoning_content: "Plan.unsigned",
      tool_calls: [{ id: "tooluse_9", type: "function", function: { name: "read", arguments: "{\"path\":\"b\"}" } }],
    },
    finish_reason: "tool_calls",
  }])
  assert.deepEqual(chat.usage, { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11, prompt_tokens_details: { cached_tokens: 1 } })
  assert.deepEqual(remembered, [{ ids: ["tooluse_9"], payload: { kind: "bedrock", blocks: [reasoningBlock] } }])

  const filtered = converseJsonToChat({ output: { message: { content: [{ text: "" }] } }, stopReason: "guardrail_intervened" }, route)
  assert.deepEqual(Reflect.get(Array.isArray(filtered.choices) ? filtered.choices[0] : {}, "finish_reason"), "content_filter")
})

test("Bedrock error bodies become chat errors", () => {
  assert.deepEqual(converseErrorToChat({ message: "Model not ready" }, 400), { error: { message: "Model not ready", type: "api_error", code: null } })
  assert.deepEqual(converseErrorToChat({ Message: "Denied" }, 403), { error: { message: "Denied", type: "api_error", code: null } })
  const existing = { error: { message: "Gateway said no", type: "invalid_request_error", code: "x" } }
  assert.deepEqual(converseErrorToChat(existing, 400), existing)
  assert.deepEqual(bedrockTranslator.errorToChat(null, 503), { error: { message: "The provider failed with HTTP 503.", type: "api_error", code: null } })
})
