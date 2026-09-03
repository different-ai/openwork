import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createBedrockConverseEventStreamUsageParser,
  isAwsEventStreamContentType,
  parseBedrockConverseJsonUsage,
  readEventStreamFrames,
} from "../src/usage/bedrock-converse.js"
import { bedrockStreamFrames } from "./helpers/event-stream.js"

function joinFrames(frames: Uint8Array[]) {
  const out = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0))
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.byteLength
  }
  return out
}

test("event-stream frames: headers and payloads decode", () => {
  const frames: Array<{ type: string | undefined; payload: string }> = []
  const joined = joinFrames(bedrockStreamFrames)
  const rest = readEventStreamFrames(joined, (frame) => {
    frames.push({ type: frame.headers.get(":event-type"), payload: new TextDecoder().decode(frame.payload) })
  })
  assert.equal(rest?.byteLength, 0)
  assert.deepEqual(frames.map((frame) => frame.type), ["messageStart", "contentBlockDelta", "messageStop", "metadata"])
  assert.equal(frames[0]?.payload, '{"role":"assistant"}')
})

test("bedrock stream parser: usage from the metadata event, frames split across chunks", () => {
  const parser = createBedrockConverseEventStreamUsageParser()
  const joined = joinFrames(bedrockStreamFrames)
  // Split at awkward boundaries (inside preludes and payloads).
  const cuts = [3, 20, 57, 100, joined.length - 5, joined.length]
  let start = 0
  for (const cut of cuts) {
    assert.ok(parser.pushBytes)
    parser.pushBytes(joined.subarray(start, cut))
    start = cut
  }
  const usage = parser.result()
  assert.equal(usage.found, true)
  assert.equal(usage.inputTokens, 12)
  assert.equal(usage.outputTokens, 7)
  assert.equal(usage.totalTokens, 19)
  assert.equal(usage.cacheReadTokens, 4)
  assert.equal(usage.cacheWriteTokens, 2)
  assert.equal(usage.model, null)
})

test("bedrock stream parser: malformed prelude → empty usage; incomplete trailing frame ignored", () => {
  const bad = createBedrockConverseEventStreamUsageParser()
  bad.pushBytes?.(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]))
  assert.equal(bad.result().found, false)

  const partial = createBedrockConverseEventStreamUsageParser()
  const metadata = bedrockStreamFrames[3]
  assert.ok(metadata)
  partial.pushBytes?.(metadata.subarray(0, metadata.byteLength - 10))
  assert.equal(partial.result().found, false)
  partial.pushBytes?.(metadata.subarray(metadata.byteLength - 10))
  assert.equal(partial.result().inputTokens, 12)
})

test("bedrock json usage + content type detection", () => {
  const usage = parseBedrockConverseJsonUsage({ output: {}, usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } })
  assert.equal(usage.found, true)
  assert.equal(usage.inputTokens, 5)
  assert.equal(usage.outputTokens, 6)
  assert.equal(usage.totalTokens, 11)
  assert.equal(usage.cacheReadTokens, null)
  assert.equal(parseBedrockConverseJsonUsage({ output: {} }).found, false)
  assert.equal(isAwsEventStreamContentType("application/vnd.amazon.eventstream"), true)
  assert.equal(isAwsEventStreamContentType("text/event-stream"), false)
})
