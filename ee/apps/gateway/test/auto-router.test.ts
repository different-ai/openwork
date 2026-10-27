import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { autoRouterOptionKey, autoRouterThinkingLevels } from "@openwork/types/den/auto-router"
import { anthropicJsonToChat, anthropicStreamToChat, claudeTakesEffort, toAnthropicBody } from "../src/auto-router/anthropic.js"
import { createMemoryReasoningStore } from "../src/auto-router/reasoning-store.js"
import { injectRouteIntoChatStream, readAutoPrompt, toOpenAiChatBody, type AutoRouteInfo } from "../src/auto-router/chat.js"
import { clearAutoTurnChoices, decideAutoRoute, fallbackDecision, type AutoCandidate } from "../src/auto-router/decide.js"
import { jevRequestBody, type AskJev } from "../src/auto-router/jev.js"

const route: AutoRouteInfo = { provider: "anthropic", model: "claude-opus-5", thinking: "high", reason: "jev" }

const candidates: AutoCandidate[] = [
  { routeIndex: 0, routeId: "arr_fast", modelName: "Claude Haiku 5", prompt: "Quick questions and small edits", thinkingLevels: ["default", "low"] },
  { routeIndex: 1, routeId: "arr_deep", modelName: "Claude Opus 5", prompt: "Hard coding and planning", thinkingLevels: ["medium", "high", "max"] },
]

function stream(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-event to prove buffering.
      const bytes = new TextEncoder().encode(text)
      controller.enqueue(bytes.slice(0, 37))
      controller.enqueue(bytes.slice(37))
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

beforeEach(() => {
  clearAutoTurnChoices()
})

test("the fallback is the first route allowing High, at High", () => {
  const decision = fallbackDecision(candidates)
  assert.equal(decision?.candidate.routeId, "arr_deep")
  assert.equal(decision?.thinkingLevel, "high")
  assert.equal(fallbackDecision([candidates[0]!])?.thinkingLevel, "default")
})

test("Jev's choice picks the route and thinking level by option id", async () => {
  const asked: string[][] = []
  const askJev: AskJev = async ({ options }) => {
    asked.push(options.map((option) => option.key))
    return { key: autoRouterOptionKey(0, "low"), confidence: 0.9, model: "jev-1" }
  }
  const decision = await decideAutoRoute({ candidates, prompt: "rename this variable", context: null, continuation: false, turnKey: "t1", askJev })
  assert.equal(decision?.candidate.routeId, "arr_fast")
  assert.equal(decision?.thinkingLevel, "low")
  assert.equal(decision?.reason, "jev")
  assert.deepEqual(asked[0], ["route_1_default", "route_1_low", "route_2_medium", "route_2_high", "route_2_max"])
})

test("a continuation of the same turn reuses the choice without asking Jev", async () => {
  let calls = 0
  const askJev: AskJev = async () => { calls++; return { key: autoRouterOptionKey(1, "max"), confidence: 1, model: null } }
  await decideAutoRoute({ candidates, prompt: "design a system", context: null, continuation: false, turnKey: "turn", askJev })
  const next = await decideAutoRoute({ candidates, prompt: "design a system", context: null, continuation: true, turnKey: "turn", askJev })
  assert.equal(calls, 1)
  assert.equal(next?.reason, "turn")
  assert.equal(next?.thinkingLevel, "max")
})

test("Jev failing or answering nothing usable falls back", async () => {
  const errors: unknown[] = []
  const failing: AskJev = async () => { throw new Error("jev_http_500") }
  const decision = await decideAutoRoute({ candidates, prompt: "hi", context: null, continuation: false, turnKey: null, askJev: failing, onJevError: (error) => errors.push(error) })
  assert.equal(decision?.reason, "fallback")
  assert.equal(errors.length, 1)
  const unknown: AskJev = async () => ({ key: "route_9_high", confidence: 1, model: null })
  assert.equal((await decideAutoRoute({ candidates, prompt: "hi", context: null, continuation: false, turnKey: null, askJev: unknown }))?.reason, "fallback")
})

test("the Jev request carries option ids and descriptions, never provider ids", () => {
  const body = jevRequestBody({
    prompt: "fix the failing test",
    context: null,
    model: "jev-latest",
    options: [{ key: "route_1_high", modelName: "Claude Opus 5", useWhen: "Hard coding", thinkingLevel: "high" }],
  })
  assert.equal(body.questions.route.type, "choice")
  assert.deepEqual(Object.keys(body.questions.route.criteria), ["route_1_high"])
  assert.equal(body.state.latest_request, "fix the failing test")
  assert.doesNotMatch(JSON.stringify(body), /ipr_|gwm_/)
})

test("the prompt is the latest user message; tool results continue the turn", () => {
  const first = readAutoPrompt({ messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "list files" }] },
  ] })
  assert.equal(first.prompt, "list files")
  assert.equal(first.continuation, false)
  const later = readAutoPrompt({ messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "list files" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "a.ts" },
  ] })
  assert.equal(later.prompt, "list files")
  assert.equal(later.continuation, true)
  assert.equal(later.turnFingerprint, first.turnFingerprint)
})

test("OpenAI routes get the chosen reasoning effort and the member's alias", () => {
  const body = toOpenAiChatBody({ model: "openwork-auto", messages: [], reasoning_effort: "low" }, { model: "gwm_x", thinkingLevel: "high", reasoningStyle: "reasoning_effort" })
  assert.equal(body.model, "gwm_x")
  assert.equal(body.reasoning_effort, "high")
  const plain = toOpenAiChatBody({ model: "openwork-auto", messages: [] }, { model: "gwm_x", thinkingLevel: "default", reasoningStyle: "reasoning_effort" })
  assert.equal(plain.reasoning_effort, undefined)
  const openrouter = toOpenAiChatBody({ model: "openwork-auto", messages: [] }, { model: "gwm_x", thinkingLevel: "medium", reasoningStyle: "openrouter" })
  assert.deepEqual(openrouter.reasoning, { effort: "medium" })
})

test("a chat request becomes a Messages request with tools, results and effort", () => {
  const body = toAnthropicBody({
    model: "openwork-auto",
    stream: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "read a.ts" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    tool_choice: "auto",
  }, { model: "gwm_x", upstreamModel: "claude-opus-5", thinkingLevel: "high", maxOutputTokens: 64000 })
  assert.deepEqual(body.system, [{ type: "text", text: "You are helpful." }])
  assert.equal(body.max_tokens, 64000)
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" })
  assert.deepEqual(body.output_config, { effort: "high" })
  assert.equal(body.temperature, undefined, "thinking requires the default temperature")
  assert.deepEqual(body.tools, [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }])
  assert.deepEqual(body.tool_choice, { type: "auto" })
  assert.deepEqual(body.messages, [{ role: "user", content: [
    { type: "text", text: "read a.ts" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ] }])
})

test("a tool-use turn without its signed thinking continues with thinking off", () => {
  const body = toAnthropicBody({ messages: [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
    { role: "tool", tool_call_id: "toolu_1", content: "export {}" },
  ] }, { model: "gwm_x", upstreamModel: "claude-opus-5", thinkingLevel: "high", maxOutputTokens: null })
  assert.deepEqual(body.thinking, { type: "disabled" })
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "read a.ts" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export {}" }] },
  ])
})

test("a Messages stream becomes a chat stream, and its thinking is replayed on the next request", async () => {
  const sse = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 5 } } })}`,
    ": processing",
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look." } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading." } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "read" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n")
  const store = createMemoryReasoningStore()
  const remembered: Promise<void>[] = []
  const text = await readAll(anthropicStreamToChat(stream(sse), route, (ids, payload) => { remembered.push(store.remember("org_1", ids, payload)) }))
  await Promise.all(remembered)
  assert.match(text, /^: processing$/m)
  const events = dataEvents(text)
  assert.equal(events.at(-1), "[DONE]")
  const chunks = events.slice(0, -1).map((event) => JSON.parse(event))
  assert.deepEqual(chunks[0].openwork_route, route)
  assert.equal(chunks[0].choices[0].delta.role, "assistant")
  assert.equal(chunks[1].choices[0].delta.reasoning_content, "Let me look.")
  assert.equal(chunks[2].choices[0].delta.content, "Reading.")
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].id, "toolu_9")
  const args = chunks.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? []).join("")
  assert.equal(args, "{\"path\":\"a.ts\"}")
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls")
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22, prompt_tokens_details: { cached_tokens: 5 } })

  const next = toAnthropicBody({ messages: [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "Reading.", tool_calls: [{ id: "toolu_9", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
    { role: "tool", tool_call_id: "toolu_9", content: "export {}" },
  ] }, { model: "gwm_x", upstreamModel: "claude-opus-5", thinkingLevel: "high", maxOutputTokens: null, reasoning: await store.recall("org_1", ["toolu_9"]) })
  assert.deepEqual(next.output_config, { effort: "high" })
  const assistant = Array.isArray(next.messages) ? next.messages[1] : null
  assert.deepEqual(assistant?.content[0], { type: "thinking", thinking: "Let me look.", signature: "sig" })
})

test("a Messages error event becomes a chat error", async () => {
  const text = await readAll(anthropicStreamToChat(stream(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`), route))
  assert.deepEqual(JSON.parse(dataEvents(text)[0] ?? "null"), { error: { message: "Overloaded", type: "overloaded_error", code: "overloaded_error" } })
})

test("a complete Messages response becomes a chat completion", () => {
  const chat = anthropicJsonToChat({ id: "msg_2", content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } }, route)
  assert.deepEqual(chat.choices, [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }])
  assert.deepEqual(chat.openwork_route, route)
})

test("OpenAI streams get the route on their first chunk only", async () => {
  const sse = `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "a" } }] })}\n\ndata: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "b" } }] })}\n\ndata: [DONE]\n\n`
  const events = dataEvents(await readAll(injectRouteIntoChatStream(stream(sse), route)))
  assert.deepEqual(JSON.parse(events[0] ?? "null").openwork_route, route)
  assert.equal(JSON.parse(events[1] ?? "null").openwork_route, undefined)
  assert.equal(events[2], "[DONE]")
})

test("effort is only sent to Claude models that take it", () => {
  assert.equal(claudeTakesEffort("claude-opus-5"), true)
  assert.equal(claudeTakesEffort("claude-sonnet-4-6"), true)
  assert.equal(claudeTakesEffort("claude-sonnet-4-5"), false)
  assert.equal(claudeTakesEffort("claude-3-7-sonnet"), false)
  assert.equal(claudeTakesEffort("anthropic.claude-3-7-sonnet-20250219-v1:0"), false)
  assert.equal(claudeTakesEffort("claude-sonnet-4-5-20250929"), false)
  assert.equal(claudeTakesEffort("claude-opus-4-6-20260101"), true)
})

test("a model allows default plus its catalog effort levels, in order", () => {
  assert.deepEqual(autoRouterThinkingLevels("claude-opus-5", { reasoning: true, reasoning_options: [{ type: "effort", values: ["max", "low", "high", "bogus"] }] }), ["default", "low", "high", "max"])
  assert.deepEqual(autoRouterThinkingLevels("claude-sonnet-4-5", { reasoning: true, reasoning_options: [{ type: "effort", values: ["low"] }] }), ["default"])
  assert.deepEqual(autoRouterThinkingLevels("gpt-5", { reasoning: false, reasoning_options: [{ type: "effort", values: ["low"] }] }), ["default"])
})
