import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { anthropicModel, ModelError, openAIModel, toAnthropicMessages } from "../src/model.js"
import type { Message } from "../src/types.js"

type Captured = { url: string; headers: Headers; body: unknown }

function fakeFetch(responses: Array<() => Response>) {
  const captured: Captured[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    const next = responses.shift()
    if (!next) throw new Error("no response scripted")
    return next()
  }
  return { fetchImpl, captured }
}
const json = (value: unknown, status = 200) => () =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const noSleep = async () => {}

const history: Message[] = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "list_files", input: {} }] },
  { role: "tool", callId: "t1", name: "list_files", output: "empty", isError: false },
  { role: "user", text: "next turn after an unfinished one" },
]

test("anthropic: gateway URL, x-api-key only, alternating roles, tool parsing", async () => {
  const { fetchImpl, captured } = fakeFetch([
    json({
      content: [
        { type: "thinking", thinking: "…", signature: "s" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t2", name: "read_file", input: { path: "a.md" } },
      ],
      usage: { input_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 2, output_tokens: 3 },
    }),
  ])
  const model = anthropicModel({ baseUrl: "https://gateway.example/api/v1/providers/ipr_x", maxOutputTokens: 1000, fetch: fetchImpl, sleep: noSleep })
  const step = await model.complete({
    system: "sys",
    messages: history,
    tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
    model: "gwm_a",
    apiKey: "ow_gw_key",
    signal: new AbortController().signal,
  })
  assert.equal(captured[0].url, "https://gateway.example/api/v1/providers/ipr_x/messages")
  assert.equal(captured[0].headers.get("x-api-key"), "ow_gw_key")
  assert.equal(captured[0].headers.get("authorization"), null, "the gateway rejects two differing key headers")
  const body = z.object({ system: z.array(z.object({ cache_control: z.object({ type: z.string() }) })), messages: z.array(z.object({ content: z.array(z.record(z.string(), z.unknown())) })) }).parse(captured[0].body)
  assert.equal(body.system[0].cache_control.type, "ephemeral")
  assert.ok("cache_control" in (body.messages.at(-1)?.content.at(-1) ?? {}), "the newest block is a cache breakpoint")
  assert.deepEqual(step, {
    text: "Checking.",
    toolCalls: [{ id: "t2", name: "read_file", input: { path: "a.md" } }],
    usage: { inputTokens: 12, cachedInputTokens: 8, outputTokens: 3 },
  })
})

test("anthropic message conversion merges adjacent user entries", () => {
  const converted = toAnthropicMessages(history)
  assert.deepEqual(converted.map((message) => message.role), ["user", "assistant", "user"])
  assert.deepEqual(converted[2].content.map((block) => block.type), ["tool_result", "text"])
})

test("openai: chat completions, bearer auth, tool call arguments", async () => {
  const { fetchImpl, captured } = fakeFetch([
    json({
      choices: [{ message: { content: null, tool_calls: [{ id: "t9", function: { name: "write_file", arguments: "{\"path\":\"x\",\"content\":\"y\"}" } }] } }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    }),
  ])
  const model = openAIModel({ baseUrl: "https://gateway.example/api/v1", fetch: fetchImpl, sleep: noSleep })
  const step = await model.complete({ system: "sys", messages: history, tools: [], model: "gwm_o", apiKey: "ow_inf_key", signal: new AbortController().signal })
  assert.equal(captured[0].url, "https://gateway.example/api/v1/chat/completions")
  assert.equal(captured[0].headers.get("authorization"), "Bearer ow_inf_key")
  assert.deepEqual(step.toolCalls, [{ id: "t9", name: "write_file", input: { path: "x", content: "y" } }])
  const body = captured[0].body
  assert.ok(typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages))
  assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ["system", "user", "assistant", "tool", "user"])
})

test("retries transient gateway errors, not client errors", async () => {
  const ok = json({ choices: [{ message: { content: "fine" } }] })
  const retried = fakeFetch([json({}, 429), json({}, 503), ok])
  const model = openAIModel({ baseUrl: "https://g.example", fetch: retried.fetchImpl, sleep: noSleep })
  const request = { system: "", messages: history, tools: [], model: "m", apiKey: "k", signal: new AbortController().signal }
  assert.equal((await model.complete(request)).text, "fine")
  assert.equal(retried.captured.length, 3)

  const rejected = fakeFetch([json({ error: "bad" }, 400)])
  const strict = openAIModel({ baseUrl: "https://g.example", fetch: rejected.fetchImpl, sleep: noSleep })
  await assert.rejects(strict.complete(request), (error) => error instanceof ModelError && error.code === "model_http_400")
  assert.equal(rejected.captured.length, 1)
})

test("malformed tool arguments become a tool error instead of a crash", async () => {
  const { fetchImpl } = fakeFetch([json({ choices: [{ message: { tool_calls: [{ id: "t", function: { name: "x", arguments: "not json" } }] } }] })])
  const model = openAIModel({ baseUrl: "https://g.example", fetch: fetchImpl, sleep: noSleep })
  const step = await model.complete({ system: "", messages: history, tools: [], model: "m", apiKey: "k", signal: new AbortController().signal })
  assert.equal(step.toolCalls[0].inputError, "Tool arguments were not a JSON object.")
})
