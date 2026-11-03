import assert from "node:assert/strict"
import test from "node:test"
import { CUT_OFF_CALL, ModelError, openAIResponsesModel, streamedDescription, toResponsesInput } from "../src/model.js"
import type { Message } from "../src/types.js"

const tool = { name: "mail_search", description: "Search mail", inputSchema: { type: "object", properties: { query: { type: "string" } } } }
const request = (extra: Partial<Parameters<ReturnType<typeof openAIResponsesModel>["complete"]>[0]> = {}) => ({
  system: "You are helpful.",
  messages: [{ role: "user", text: "Find the Blue Harbor email" }] as Message[],
  tools: [tool],
  model: "gpt-6.1-sol",
  apiKey: "key",
  signal: new AbortController().signal,
  ...extra,
})
const recorder = (respond: (body: Record<string, unknown>) => Response) => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url: String(url), body })
    return respond(body)
  }) as typeof globalThis.fetch
  return { calls, fetch }
}
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })

test("transcript maps to Responses input: calls follow the assistant, outputs follow their call, media follows as user content", () => {
  const input = toResponsesInput([
    { role: "user", text: "hi" },
    { role: "assistant", text: "Looking.", toolCalls: [{ id: "call_1", name: "mail_search", input: { query: "Blue Harbor" } }] },
    { role: "tool", callId: "call_1", name: "mail_search", output: "[]", isError: false, images: [{ mediaType: "image/png", data: "AAAA" }] },
  ])
  assert.deepEqual(input, [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
    { type: "function_call", call_id: "call_1", name: "mail_search", arguments: JSON.stringify({ query: "Blue Harbor" }) },
    { type: "function_call_output", call_id: "call_1", output: "[]" },
    { role: "user", content: [{ type: "input_text", text: "Images returned by mail_search:" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
  ])
})

test("non-streamed call: posts to /responses with non-strict function tools and reads text, calls and usage", async () => {
  const { calls, fetch } = recorder(() => Response.json({
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "Searching." }] },
      { type: "function_call", call_id: "call_9", name: "mail_search", arguments: "{\"query\":\"Blue Harbor\"}" },
    ],
    usage: { input_tokens: 120, output_tokens: 15, input_tokens_details: { cached_tokens: 100 } },
  }))
  const step = await openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 4096, fetch }).complete(request())
  assert.equal(calls[0]!.url, "https://gateway.test/v1/responses")
  assert.equal(calls[0]!.body.instructions, "You are helpful.")
  assert.equal(calls[0]!.body.max_output_tokens, 4096)
  assert.equal(calls[0]!.body.store, false)
  assert.deepEqual(calls[0]!.body.tools, [{ type: "function", name: "mail_search", description: "Search mail", parameters: tool.inputSchema, strict: false }])
  assert.equal("max_tokens" in calls[0]!.body || "messages" in calls[0]!.body, false)
  assert.deepEqual(step, { text: "Searching.", toolCalls: [{ id: "call_9", name: "mail_search", input: { query: "Blue Harbor" } }], usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 15 } })
})

test("streamed call: forwards text deltas and tool starts, and returns the completed response", async () => {
  const { calls, fetch } = recorder(() => sse([
    { type: "response.created", response: { status: "in_progress", output: [] } },
    { type: "response.output_text.delta", delta: "Sear" },
    { type: "response.output_text.delta", delta: "ching." },
    { type: "response.output_item.added", item: { type: "function_call", name: "mail_search" } },
    { type: "response.function_call_arguments.delta", delta: "{\"query\":" },
    { type: "response.completed", response: { status: "completed", output: [
      { type: "message", content: [{ type: "output_text", text: "Searching." }] },
      { type: "function_call", call_id: "call_2", name: "mail_search", arguments: "{\"query\":\"x\"}" },
    ], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]))
  const deltas: string[] = []
  const tools: string[] = []
  const step = await openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 100, fetch })
    .complete(request({ onText: (delta) => deltas.push(delta), onTool: (name) => tools.push(name) }))
  assert.equal(calls[0]!.body.stream, true)
  assert.deepEqual(deltas, ["Sear", "ching."])
  assert.deepEqual(tools, ["mail_search"])
  assert.deepEqual(step.toolCalls, [{ id: "call_2", name: "mail_search", input: { query: "x" } }])
  assert.equal(step.text, "Searching.")
})

test("a streamed call says what it is doing once its description is written, before the rest of its input", async () => {
  const { fetch } = recorder(() => sse([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", name: "desktop" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"view\":\"computer\",\"descrip" },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "tion\":\"Drawing the \\\"ground\\\"" },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: " and trunk\",\"args\":{\"code\":\"bpy." },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "ops\"}}" },
    { type: "response.completed", response: { status: "completed", output: [
      { type: "function_call", call_id: "call_1", name: "desktop", arguments: "{\"view\":\"computer\",\"description\":\"Drawing the \\\"ground\\\" and trunk\",\"args\":{\"code\":\"bpy.ops\"}}" },
    ], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]))
  const tools: Array<[string, string | undefined]> = []
  await openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 100, fetch })
    .complete(request({ onText: () => undefined, onTool: (name, description) => tools.push([name, description]) }))
  assert.deepEqual(tools, [["desktop", undefined], ["desktop", 'Drawing the "ground" and trunk']])
})

test("only a call's own top-level description counts, once it is complete", () => {
  assert.equal(streamedDescription('{"view":"browser","description":"Checking listings"'), "Checking listings")
  assert.equal(streamedDescription('{"view":"browser","description":"Checking list'), null)
  assert.equal(streamedDescription('{"args":{"description":"a field of the page"},"view":"browser"}'), null)
  assert.equal(streamedDescription('{"args":{"text":"\\"description\\":\\"no\\""},"description":"Typing a note"}'), "Typing a note")
  assert.equal(streamedDescription('{"description":"   "}'), null)
  assert.equal(streamedDescription(`{"args":{"code":"${"x".repeat(5_000)}"},"description":"Late"}`), null)
})

test("a failed response is a model error, not an empty answer", async () => {
  const { fetch } = recorder(() => sse([{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "The model crashed" } } }]))
  await assert.rejects(
    openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 100, fetch }).complete(request({ onText: () => undefined })),
    (error: unknown) => error instanceof ModelError && error.code === "model_failed" && /The model crashed/.test(error.message),
  )
})

test("a response stopped at the output cap is marked cut off, and the call it was writing is not run", async () => {
  const { fetch } = recorder(() => sse([
    { type: "response.output_item.added", item: { type: "function_call", name: "mail_search" } },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [
      { type: "function_call", call_id: "call_3", name: "mail_search", arguments: "{\"query\":\"Blue Har" },
    ], usage: { input_tokens: 10, output_tokens: 100 } } },
  ]))
  const step = await openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 100, fetch }).complete(request({ onText: () => undefined }))
  assert.equal(step.cutOff, true)
  assert.deepEqual(step.toolCalls, [{ id: "call_3", name: "mail_search", input: {}, inputError: CUT_OFF_CALL }])

  const { fetch: empty } = recorder(() => Response.json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }))
  const bare = await openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 100, fetch: empty }).complete(request())
  assert.equal(bare.cutOff, true)
  assert.deepEqual(bare.toolCalls, [])
})

/** A Responses stream the test writes to; the runner's abort errors it, as a real fetch body does. */
function liveStream() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({ start: (opened) => void (controller = opened) })
    init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }) as typeof globalThis.fetch
  return { fetch, send: (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)), end: () => controller.close() }
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("a streamed reply may take longer than the call limit while it keeps writing; a silent one is ended", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const writing = liveStream()
  const reply = openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 100, fetch: writing.fetch, sleep: async () => undefined })
    .complete(request({ onText: () => undefined }))
  await settle()
  // Ten minutes in all, never three minutes without a word.
  for (let minute = 0; minute < 4; minute += 1) {
    writing.send({ type: "response.output_text.delta", delta: "x" })
    await settle()
    t.mock.timers.tick(150_000)
    await settle()
  }
  writing.send({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "xxxx" }] }] } })
  writing.end()
  assert.equal((await reply).text, "xxxx")

  const silent = liveStream()
  const stalled = openAIResponsesModel({ baseUrl: "https://gateway.test/v1", maxOutputTokens: 100, fetch: silent.fetch, sleep: async () => undefined })
    .complete(request({ onText: () => undefined }))
  const failed = assert.rejects(stalled, (error: unknown) => error instanceof ModelError && error.code === "model_stream_interrupted")
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await settle()
    t.mock.timers.tick(180_000)
    await settle()
  }
  await failed
})
