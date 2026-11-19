import assert from "node:assert/strict"
import { test } from "node:test"
import type { AutoRouteInfo } from "../src/auto-router/chat.js"
import { translatorFor } from "../src/auto-router/handler.js"
import { responsesErrorToChat, responsesJsonToChat, responsesStreamToChat, toResponsesBody } from "../src/auto-router/openai-responses.js"
import { createMemoryReasoningStore } from "../src/auto-router/reasoning-store.js"

const route: AutoRouteInfo = { provider: "openai", model: "gpt-6-luna", thinking: "high", reason: "jev" }
const reasoningItem = { type: "reasoning", id: "rs_1", encrypted_content: "enc-abc", summary: [{ type: "summary_text", text: "Looking at the file." }] }

function stream(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text)
      controller.enqueue(bytes.slice(0, 41))
      controller.enqueue(bytes.slice(41))
      controller.close()
    },
  })
}

function sse(events: Record<string, unknown>[]) {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")
}

function dataEvents(text: string) {
  return text.split("\n\n").flatMap((event) => event.startsWith("data: ") ? [event.slice(6)] : [])
}

test("OpenAI and Azure OpenAI go through Responses, like the desktop", () => {
  const openai = translatorFor("openai", "@ai-sdk/openai")?.toUpstream({ body: { messages: [] }, model: "gwm_x", upstreamModel: "gpt-6-luna", thinkingLevel: "high", maxOutputTokens: null, reasoning: new Map() })
  assert.equal(openai?.rest, "responses")
  assert.equal(openai?.protocol, "openai_responses")
  const azure = translatorFor("azure", "@ai-sdk/azure")?.toUpstream({ body: { messages: [] }, model: "gwm_x", upstreamModel: "gpt-6-luna", thinkingLevel: "high", maxOutputTokens: null, reasoning: new Map() })
  assert.equal(azure?.rest, "v1/responses")
  // OpenAI-compatible APIs (OpenRouter, vLLM, ...) stay on Chat Completions.
  assert.equal(translatorFor("openai_compatible", "@ai-sdk/openai-compatible")?.toUpstream({ body: { messages: [] }, model: "gwm_x", upstreamModel: "m", thinkingLevel: "default", maxOutputTokens: null, reasoning: new Map() }).protocol, "openai_chat")
})

test("a chat request with tools becomes a Responses request with the desktop's reasoning settings", () => {
  const body = toResponsesBody({
    model: "openwork-auto",
    stream: true,
    temperature: 0.3,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "read a.ts" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
    ],
    tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    tool_choice: "auto",
  }, { model: "gwm_x", thinkingLevel: "high", maxOutputTokens: 64000 })
  assert.equal(body.model, "gwm_x")
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.instructions, "You are helpful.")
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" })
  assert.deepEqual(body.include, ["reasoning.encrypted_content"])
  assert.equal(body.temperature, undefined, "sampling settings are refused alongside a reasoning effort")
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(body.max_output_tokens, 64000)
  assert.deepEqual(body.tools, [{ type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: false }])
  assert.equal(body.tool_choice, "auto")
  assert.deepEqual(body.input, [{ role: "user", content: [
    { type: "input_text", text: "read a.ts" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
  ] }])
})

test("Max is OpenAI's xhigh, and Default sends no reasoning", () => {
  assert.deepEqual(toResponsesBody({ messages: [] }, { model: "m", thinkingLevel: "max", maxOutputTokens: null }).reasoning, { effort: "xhigh", summary: "auto" })
  const plain = toResponsesBody({ messages: [], temperature: 0.2 }, { model: "m", thinkingLevel: "default", maxOutputTokens: null })
  assert.equal(plain.reasoning, undefined)
  assert.equal(plain.include, undefined)
  assert.equal(plain.temperature, 0.2)
})

test("a stream with reasoning, text and a tool call becomes a chat stream, and its reasoning is replayed", async () => {
  const events = sse([
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Looking at the file." },
    { type: "response.output_item.done", output_index: 0, item: reasoningItem },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Reading." },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: "{\"path\":" },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: "\"a.ts\"}" },
    { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 20, output_tokens: 9, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 5 } } } },
  ])
  const store = createMemoryReasoningStore()
  const pending: Promise<void>[] = []
  const text = await new Response(responsesStreamToChat(stream(`: processing\n\n${events}`), route, (ids, payload) => { pending.push(store.remember("org_1", ids, payload)) })).text()
  await Promise.all(pending)
  assert.match(text, /^: processing$/m)
  const data = dataEvents(text)
  assert.equal(data.at(-1), "[DONE]")
  const chunks = data.slice(0, -1).map((event) => JSON.parse(event))
  assert.deepEqual(chunks[0].openwork_route, route)
  assert.equal(chunks[1].choices[0].delta.reasoning_content, "Looking at the file.")
  assert.equal(chunks[2].choices[0].delta.content, "Reading.")
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].id, "call_9")
  const args = chunks.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? []).join("")
  assert.equal(args, "{\"path\":\"a.ts\"}")
  assert.equal(chunks.at(-2).choices[0].finish_reason, "tool_calls")
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 5 } })

  const next = toResponsesBody({ messages: [
    { role: "user", content: "read a.ts" },
    { role: "assistant", content: "Reading.", tool_calls: [{ id: "call_9", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
    { role: "tool", tool_call_id: "call_9", content: "export {}" },
  ] }, { model: "gwm_x", thinkingLevel: "high", maxOutputTokens: null, reasoning: await store.recall("org_1", ["call_9"]) })
  assert.deepEqual(next.input, [
    { role: "user", content: [{ type: "input_text", text: "read a.ts" }] },
    reasoningItem,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
    { type: "function_call", call_id: "call_9", name: "read", arguments: "{\"path\":\"a.ts\"}" },
    { type: "function_call_output", call_id: "call_9", output: "export {}" },
  ])
})

test("a truncated response finishes with length; failures become chat errors", async () => {
  const truncated = await new Response(responsesStreamToChat(stream(sse([
    { type: "response.created", response: { id: "resp_2" } },
    { type: "response.output_text.delta", delta: "Partial" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
  ])), route)).text()
  const chunks = dataEvents(truncated).slice(0, -1).map((event) => JSON.parse(event))
  assert.equal(chunks.at(-2).choices[0].finish_reason, "length")
  const failed = await new Response(responsesStreamToChat(stream(`event: error\ndata: ${JSON.stringify({ type: "error", code: "rate_limit_exceeded", message: "Slow down" })}\n\n`), route)).text()
  assert.deepEqual(JSON.parse(dataEvents(failed)[0] ?? "null"), { error: { message: "Slow down", type: "error", code: "rate_limit_exceeded" } })
  assert.deepEqual(responsesErrorToChat({ error: { message: "Bad tool", type: "invalid_request_error", code: "bad" } }, 400), { error: { message: "Bad tool", type: "invalid_request_error", code: "bad" } })
})

test("a complete Responses object becomes a chat completion", () => {
  const chat = responsesJsonToChat({
    id: "resp_3", status: "completed",
    output: [reasoningItem, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] }],
    usage: { input_tokens: 3, output_tokens: 1 },
  }, route)
  assert.deepEqual(chat.choices, [{ index: 0, message: { role: "assistant", content: "Hi", reasoning_content: "Looking at the file." }, finish_reason: "stop" }])
  assert.deepEqual(chat.openwork_route, route)
})
