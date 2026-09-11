// Hand-built AWS event-stream frame: prelude (total, headers length, prelude
// CRC) + string headers + JSON payload + message CRC. CRCs are zero: the
// parser does not verify them.
const encoder = new TextEncoder()

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function u8(value: number) {
  return new Uint8Array([value])
}

function u16(value: number) {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value)
  return out
}

function u32(value: number) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

function stringHeader(name: string, value: string) {
  const nameBytes = encoder.encode(name)
  const valueBytes = encoder.encode(value)
  return concat([u8(nameBytes.byteLength), nameBytes, u8(7), u16(valueBytes.byteLength), valueBytes])
}

export function eventStreamFrame(eventType: string, payload: unknown) {
  const headers = concat([
    stringHeader(":event-type", eventType),
    stringHeader(":content-type", "application/json"),
    stringHeader(":message-type", "event"),
  ])
  const body = encoder.encode(JSON.stringify(payload))
  const total = 12 + headers.byteLength + body.byteLength + 4
  return concat([u32(total), u32(headers.byteLength), u32(0), headers, body, u32(0)])
}

export const bedrockStreamFrames = [
  eventStreamFrame("messageStart", { role: "assistant" }),
  eventStreamFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hello" } }),
  eventStreamFrame("messageStop", { stopReason: "end_turn" }),
  eventStreamFrame("metadata", {
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19, cacheReadInputTokens: 4, cacheWriteInputTokens: 2 },
    metrics: { latencyMs: 300 },
  }),
]
