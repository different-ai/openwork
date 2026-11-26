import assert from "node:assert/strict"
import { test } from "node:test"
import { BEDROCK_GUARDRAIL_BLOCKED_MESSAGE, normalizeBedrockGuardrailResponse } from "../src/index.js"
import { converseJsonToChat, converseStreamToChat } from "../src/providers/bedrock.js"
import { encodeEventStreamFrame, readEventStreamFrames } from "../src/usage/bedrock-converse.js"
import type { AutoRouteInfo } from "../src/chat.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const route: AutoRouteInfo = { provider: "bedrock", model: "test-model", thinking: "default", reason: "jev" }
const message = BEDROCK_GUARDRAIL_BLOCKED_MESSAGE

function event(type: string, payload: unknown) {
  return encodeEventStreamFrame(new Map([[":event-type", type], [":message-type", "event"], [":content-type", "application/json"]]), encoder.encode(JSON.stringify(payload)))
}

function response(frames: Uint8Array[], split = 7) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) for (let i = 0; i < frame.length; i += split) controller.enqueue(frame.slice(i, i + split))
      controller.close()
    },
  }), { headers: { "content-type": "application/vnd.amazon.eventstream", "content-length": "123", "x-amzn-requestid": "test-request" } })
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function framesOf(result: Response) {
  const bytes = new Uint8Array(await result.arrayBuffer())
  const frames: { type: string | undefined; messageType: string | undefined; payload: unknown }[] = []
  const remaining = readEventStreamFrames(bytes, (frame, raw) => {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    assert.equal(view.getUint32(8), crc32(raw.subarray(0, 8)), "valid prelude CRC")
    assert.equal(view.getUint32(raw.length - 4), crc32(raw.subarray(0, raw.length - 4)), "valid message CRC")
    const payload: unknown = JSON.parse(decoder.decode(frame.payload))
    frames.push({ type: frame.headers.get(":event-type"), messageType: frame.headers.get(":message-type"), payload })
  })
  assert.equal(remaining?.length, 0)
  return frames
}

function streamFrames(stopReason: string, tool = false) {
  return [
    event("messageStart", { role: "assistant" }),
    ...(tool ? [
      event("contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tool-1", name: "unsafe_tool" } } }),
      event("contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } }),
      event("contentBlockStop", { contentBlockIndex: 0 }),
    ] : []),
    event("messageStop", { stopReason }),
    event("metadata", { usage: { inputTokens: 2, outputTokens: 1 } }),
  ]
}

for (const source of ["prompt", "response"]) {
  test(`Converse ${source} block is plain assistant text natively and translated, with no tools`, async () => {
    const original = { stopReason: "guardrail_intervened", output: { message: { role: "assistant", content: [
      { text: "provider-specific blocked text" }, { toolUse: { toolUseId: "tool-1", name: "unsafe_tool", input: {} } },
    ] } }, usage: { inputTokens: 2, outputTokens: 1 }, trace: { guardrail: { [source]: {} } } }
    const result = await normalizeBedrockGuardrailResponse(Response.json(original), "Converse")
    const payload: unknown = await result.json()
    assert.deepEqual(payload, { ...original, output: { message: { role: "assistant", content: [{ text: message }] } } })
    const translated = converseJsonToChat(payload, route)
    assert.ok(JSON.stringify(translated).includes(message))
    assert.ok(!JSON.stringify(translated).includes("tool_calls"))
  })

  test(`ConverseStream ${source} block injects text before stop and drops pending tools`, async () => {
    const result = await normalizeBedrockGuardrailResponse(response(streamFrames("guardrail_intervened", source === "response")), "ConverseStream")
    assert.equal(result.headers.get("content-length"), null)
    assert.equal(result.headers.get("x-amzn-requestid"), "test-request")
    const frames = await framesOf(result)
    assert.ok(!JSON.stringify(frames).includes("unsafe_tool"))
    const textIndex = frames.findIndex((frame) => JSON.stringify(frame.payload).includes(message))
    assert.ok(textIndex > 0)
    assert.ok(textIndex < frames.findIndex((frame) => frame.type === "messageStop"))
    const translated = await normalizeBedrockGuardrailResponse(response(streamFrames("guardrail_intervened", source === "response")), "ConverseStream")
    assert.ok(translated.body)
    const sse = await new Response(converseStreamToChat(translated.body, route)).text()
    assert.ok(sse.includes(message))
    assert.ok(sse.includes("content_filter"))
    assert.ok(sse.includes("[DONE]"))
    assert.ok(!sse.includes("tool_calls"))
  })
}

test("allowed JSON and event streams retain upstream payload bytes and headers", async () => {
  const json = '{ "stopReason": "end_turn", "output": {} }'
  const result = await normalizeBedrockGuardrailResponse(new Response(json, { headers: { "x-amzn-requestid": "test-request" } }), "converse")
  assert.equal(await result.text(), json)
  const frames = streamFrames("tool_use", true)
  const expected = await response(frames).arrayBuffer()
  const normalized = await normalizeBedrockGuardrailResponse(response(frames, 1), "converse-stream")
  assert.deepEqual(await normalized.arrayBuffer(), expected)
})

test("ConverseStream delivers text before the stream ends but withholds tool calls", async () => {
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller } })
  const normalized = await normalizeBedrockGuardrailResponse(new Response(body), "ConverseStream")
  assert.ok(normalized.body)
  const reader = normalized.body.getReader()
  upstream?.enqueue(event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Allowed text" } }))
  const first = await reader.read()
  assert.ok(first.value && decoder.decode(first.value).includes("Allowed text"))
  await reader.cancel()
})

test("InvokeModel intervention uses a model-independent 403 error and removes model/tool content", async () => {
  const result = await normalizeBedrockGuardrailResponse(Response.json({ "amazon-bedrock-guardrailAction": "INTERVENED", generations: [{ text: "unsafe_tool" }] }), "InvokeModel")
  assert.equal(result.status, 403)
  assert.equal(result.headers.get("x-amzn-errortype"), "AccessDeniedException")
  assert.deepEqual(await result.json(), { message })
})

function invokeChunk(payload: unknown) {
  return event("chunk", { bytes: Buffer.from(JSON.stringify(payload)).toString("base64") })
}

for (const source of ["prompt", "response"]) {
  test(`InvokeModelWithResponseStream ${source} block is an AWS exception with no earlier model/tool content`, async () => {
    const result = await normalizeBedrockGuardrailResponse(response([
      ...(source === "response" ? [invokeChunk({ type: "tool_use", name: "unsafe_tool" })] : []),
      invokeChunk({ "amazon-bedrock-guardrailAction": "INTERVENED" }),
    ]), "InvokeModelWithResponseStream")
    const frames = await framesOf(result)
    assert.equal(frames.length, 1)
    assert.equal(frames[0]?.messageType, "exception")
    assert.ok(JSON.stringify(frames).includes(message))
    assert.ok(!JSON.stringify(frames).includes("unsafe_tool"))
  })
}

test("allowed InvokeModel stream is byte-identical after its final guardrail verdict", async () => {
  const frames = [invokeChunk({ text: "Allowed" }), invokeChunk({ "amazon-bedrock-guardrailAction": "NONE" })]
  const result = await normalizeBedrockGuardrailResponse(response(frames), "InvokeModelWithResponseStream")
  assert.deepEqual(await result.arrayBuffer(), await response(frames).arrayBuffer())
})

test("truncated streams cannot release pending tool calls", async () => {
  const result = await normalizeBedrockGuardrailResponse(response(streamFrames("tool_use", true).slice(0, 4)), "ConverseStream")
  const frames = await framesOf(result)
  assert.ok(frames.some((frame) => frame.messageType === "exception"))
  assert.ok(!JSON.stringify(frames).includes("unsafe_tool"))
})

test("native Invoke URL operation names are recognized", async () => {
  const json = await normalizeBedrockGuardrailResponse(Response.json({ "amazon-bedrock-guardrailAction": "INTERVENED" }), "invoke")
  assert.equal(json.status, 403)
  const streamed = await normalizeBedrockGuardrailResponse(response([invokeChunk({ "amazon-bedrock-guardrailAction": "INTERVENED" })]), "invoke-with-response-stream")
  assert.ok(JSON.stringify(await framesOf(streamed)).includes(message))
})

test("oversized declared frames fail closed without waiting for their payload", async () => {
  const prelude = new Uint8Array(12)
  new DataView(prelude.buffer).setUint32(0, 16 * 1024 * 1024 + 1)
  const result = await normalizeBedrockGuardrailResponse(response([prelude]), "ConverseStream")
  const frames = await framesOf(result)
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.messageType, "exception")
})

test("guarded Invoke buffering has a hard ceiling and never releases partial tool data", async () => {
  const large = invokeChunk({ type: "tool_use", name: "unsafe_tool", input: "x".repeat(256 * 1024) })
  const result = await normalizeBedrockGuardrailResponse(response(Array.from({ length: 65 }, () => large), large.length), "InvokeModelWithResponseStream")
  const frames = await framesOf(result)
  assert.equal(frames.length, 1)
  assert.equal(frames[0]?.messageType, "exception")
  assert.ok(JSON.stringify(frames).includes("buffering limit"))
  assert.ok(!JSON.stringify(frames).includes("unsafe_tool"))
})

for (const operation of ["Converse", "InvokeModel"]) {
  for (const body of ["{", "null", "[]", '"unexpected scalar"']) {
    test(`${operation} malformed/non-object JSON fails closed: ${body}`, async () => {
      const result = await normalizeBedrockGuardrailResponse(new Response(body, { headers: { "content-type": "text/plain", "content-length": "123" } }), operation)
      assert.equal(result.status, 502)
      assert.equal(result.headers.get("content-type"), "application/json")
      assert.equal(result.headers.get("x-amzn-errortype"), "ModelErrorException")
      assert.equal(result.headers.get("content-length"), null)
      assert.deepEqual(await result.json(), { message: "The provider sent a malformed guarded response." })
    })
  }
}

for (const stopReason of ["content_filtered", "malformed_tool_use", "unknown", undefined]) {
  test(`ConverseStream never releases tools without an affirmative tool_use verdict: ${stopReason}`, async () => {
    const original = streamFrames("tool_use", true)
    original[4] = event("messageStop", { stopReason })
    const result = await normalizeBedrockGuardrailResponse(response(original), "ConverseStream")
    assert.ok(!JSON.stringify(await framesOf(result)).includes("unsafe_tool"))
  })
}

test("malformed base64/JSON model chunks discard all held Invoke tool content", async () => {
  for (const bytes of ["%%%", Buffer.from("{").toString("base64")]) {
    const result = await normalizeBedrockGuardrailResponse(response([
      invokeChunk({ type: "tool_use", name: "unsafe_tool" }),
      event("chunk", { bytes }),
    ]), "InvokeModelWithResponseStream")
    const frames = await framesOf(result)
    assert.equal(frames.length, 1)
    assert.equal(frames[0]?.messageType, "exception")
    assert.ok(!JSON.stringify(frames).includes("unsafe_tool"))
  }
})

for (const operation of ["Converse", "InvokeModel"]) {
  test(`${operation} caps non-stream reads at 16 MiB and cancels the upstream reader`, async () => {
    let cancelled = false
    let pulls = 0
    const block = new Uint8Array(1024 * 1024).fill(120)
    const original = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(block) },
      cancel() { cancelled = true },
    }), { headers: { "content-length": "123", "content-type": "text/plain" } })
    const result = await normalizeBedrockGuardrailResponse(original, operation)
    assert.equal(result.status, 502)
    assert.equal(result.headers.get("content-length"), null)
    assert.equal(result.headers.get("content-type"), "application/json")
    assert.deepEqual(await result.json(), { message: "The guarded response exceeded the safe buffering limit." })
    assert.equal(cancelled, true)
    assert.ok(pulls <= 18)
  })
}

test("non-stream reads allow a response exactly at the 16 MiB ceiling", async () => {
  const empty = JSON.stringify({ padding: "" })
  const body = JSON.stringify({ padding: "x".repeat(16 * 1024 * 1024 - empty.length) })
  const result = await normalizeBedrockGuardrailResponse(new Response(body), "InvokeModel")
  assert.equal(result.status, 200)
  assert.equal(await result.text(), body)
})

for (const operation of ["ConverseStream", "InvokeModelWithResponseStream"]) {
  for (const checksum of ["prelude", "message"]) {
    test(`${operation} rejects corrupted ${checksum} CRC and discards held tools`, async () => {
      const corrupt = operation === "ConverseStream"
        ? event("messageStop", { stopReason: "tool_use" })
        : invokeChunk({ "amazon-bedrock-guardrailAction": "NONE" })
      const index = checksum === "prelude" ? 8 : corrupt.length - 1
      corrupt[index] = (corrupt[index] ?? 0) ^ 1
      const prior = operation === "ConverseStream"
        ? streamFrames("tool_use", true).slice(0, 4)
        : [invokeChunk({ type: "tool_use", name: "unsafe_tool" })]
      const result = await normalizeBedrockGuardrailResponse(response([...prior, corrupt]), operation)
      const frames = await framesOf(result)
      assert.ok(frames.some((frame) => frame.messageType === "exception"))
      assert.ok(JSON.stringify(frames).includes("malformed guarded event stream"))
      assert.ok(!JSON.stringify(frames).includes("unsafe_tool"))
    })
  }
}

test("unknown operations and unsuccessful responses are untouched", async () => {
  const unknown = Response.json({ stopReason: "guardrail_intervened" })
  assert.equal(await normalizeBedrockGuardrailResponse(unknown, "CountTokens"), unknown)
  const failure = Response.json({ message: "upstream error" }, { status: 400 })
  assert.equal(await normalizeBedrockGuardrailResponse(failure, "Converse"), failure)
})
