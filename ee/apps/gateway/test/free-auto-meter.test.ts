import assert from "node:assert/strict"
import { test } from "node:test"
import { FreeAutoFailure, meterFreeResponse } from "../src/free/shared/meter.js"

const config = { upstreamModel: "gpt-6-luna", inputPrice: 1, cachedInputPrice: 0.1, outputPrice: 4 }
const encoder = new TextEncoder()

function upstream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close() } })
}

async function meter(text: string, options: { protocol?: "chat" | "responses"; streaming?: boolean } = {}) {
  const failures: FreeAutoFailure[] = []
  const body = meterFreeResponse(upstream(text), {
    config, protocol: options.protocol ?? "responses", streaming: options.streaming ?? true, maxBytes: 1 << 20,
    signal: new AbortController().signal, settle: async () => {}, onFailure: (failure) => failures.push(failure),
  })
  const error = await new Response(body).text().then(() => null, (error: unknown) => error)
  return { error, failures }
}

const created = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", object: "response", model: "gpt-6-luna-2026-09-22", status: "in_progress", error: null } })}\n\n`

test("an OpenAI error event keeps its type and code", async () => {
  const event = { type: "error", error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } }
  const { error, failures } = await meter(`${created}event: error\ndata: ${JSON.stringify(event)}\n\n`)
  // The stream still fails, with a one-line error for the HTTP server's log.
  assert.equal((error as Error).stack, "Error: Auto upstream failed")
  assert.equal(failures.length, 1)
  assert.equal(failures[0]?.reason, "upstream_error")
  assert.deepEqual(failures[0]?.upstream, { type: "invalid_request_error", code: "context_length_exceeded" })
})

test("an error event cut off by the end of the stream still reports its code", async () => {
  const { failures } = await meter(`event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: "The server had an error." })}`)
  assert.equal(failures[0]?.reason, "upstream_error")
  assert.equal(failures[0]?.upstream.code, "server_error")
})

test("response.failed carries the failed response's error", async () => {
  const failed = { type: "response.failed", response: { id: "resp_1", object: "response", model: "gpt-6-luna", status: "failed", error: { code: "rate_limit_exceeded", message: "Rate limit reached for requests." } } }
  const { failures } = await meter(`${created}event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`)
  assert.equal(failures[0]?.reason, "upstream_failed")
  assert.deepEqual(failures[0]?.upstream, { type: undefined, code: "rate_limit_exceeded" })
})

test("a Chat Completions error chunk is an upstream error", async () => {
  const { failures } = await meter(`data: ${JSON.stringify({ error: { type: "server_error", code: null, message: "Overloaded" } })}\n\n`, { protocol: "chat" })
  assert.equal(failures[0]?.reason, "upstream_error")
  assert.deepEqual(failures[0]?.upstream, { type: "server_error", code: undefined })
})

test("a stream that stops early and unreadable JSON are told apart without quoting the response", async () => {
  assert.equal((await meter(created)).failures[0]?.reason, "upstream_ended")
  const unreadable = await meter("data: {not json, my secret prompt\n\n")
  assert.equal(unreadable.failures[0]?.reason, "invalid_response")
  assert.doesNotMatch(String((unreadable.error as Error).message), /secret prompt/)
})

test("a client cancellation closes the stream quietly instead of failing it", async () => {
  const controller = new AbortController()
  const failures: FreeAutoFailure[] = []
  let settled = false
  const body = meterFreeResponse(new ReadableStream<Uint8Array>(), {
    config, protocol: "responses", streaming: true, maxBytes: 1 << 20, signal: controller.signal,
    settle: async (receipt) => { settled = receipt === null }, onFailure: (failure) => failures.push(failure),
  })
  const reading = new Response(body).text()
  controller.abort()
  assert.equal(await reading, "")
  assert.equal(failures[0]?.reason, "client_cancelled")
  assert.equal(settled, true)
})

test("an OpenAI message that quotes a caller value is never kept", async () => {
  // Validation messages can echo short values from the request, such as a tool name.
  const event = { type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "Invalid 'tools[0].name': 'my-secret-tool'." } }
  const { failures } = await meter(`${created}event: error\ndata: ${JSON.stringify(event)}\n\n`)
  assert.deepEqual(failures[0]?.upstream, { type: "invalid_request_error", code: "invalid_value" })
  assert.doesNotMatch(JSON.stringify(failures[0]?.upstream), /my-secret-tool/)
})
