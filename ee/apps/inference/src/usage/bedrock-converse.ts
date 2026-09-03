// Usage parser for Amazon Bedrock Converse (`/model/{id}/converse[-stream]`).
// JSON: `usage.{inputTokens,outputTokens,totalTokens,cacheRead/WriteInputTokens}`.
// Stream: AWS event-stream binary frames (not SSE); usage arrives on the
// `metadata` event. Frame layout (big-endian):
//   total length (4) | headers length (4) | prelude CRC (4) | headers | payload | message CRC (4)
// Headers: name length (1) | name | value type (1) | value. CRCs are not verified.
import { defaultMaxBufferLength, emptyUsage, isRecord, readNumber } from "./shared.js"
import type { ParsedUsage, UsageParser } from "./shared.js"

const preludeLength = 12
const messageCrcLength = 4
const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function isAwsEventStreamContentType(contentType: string | null) {
  return contentType?.split(";")[0].trim().toLowerCase() === "application/vnd.amazon.eventstream"
}

function applyUsage(target: ParsedUsage, usage: unknown) {
  if (!isRecord(usage)) return
  target.found = true
  target.inputTokens = readNumber(usage.inputTokens)
  target.outputTokens = readNumber(usage.outputTokens)
  target.totalTokens = readNumber(usage.totalTokens)
  target.cacheReadTokens = readNumber(usage.cacheReadInputTokens)
  target.cacheWriteTokens = readNumber(usage.cacheWriteInputTokens)
}

export function parseBedrockConverseJsonUsage(body: unknown): ParsedUsage {
  const usage = emptyUsage()
  if (isRecord(body)) applyUsage(usage, body.usage)
  return usage
}

export type EventStreamFrame = { headers: Map<string, string>; payload: Uint8Array }

// Value lengths by header type; string/bytes (6, 7) carry a 2-byte length prefix.
function headerValueLength(type: number, view: DataView, offset: number) {
  switch (type) {
    case 0:
    case 1:
      return 0
    case 2:
      return 1
    case 3:
      return 2
    case 4:
      return 4
    case 5:
    case 8:
      return 8
    case 9:
      return 16
    case 6:
    case 7:
      return 2 + view.getUint16(offset)
    default:
      return null
  }
}

function parseHeaders(bytes: Uint8Array) {
  const headers = new Map<string, string>()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset < bytes.byteLength) {
    const nameLength = view.getUint8(offset)
    offset += 1
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength))
    offset += nameLength
    const type = view.getUint8(offset)
    offset += 1
    const length = headerValueLength(type, view, offset)
    if (length === null || offset + length > bytes.byteLength) return null
    if (type === 7) headers.set(name, decoder.decode(bytes.subarray(offset + 2, offset + length)))
    offset += length
  }
  return headers
}

// Pulls complete frames off the front of `buffer`; returns the leftover bytes
// or null when the stream is malformed.
export function readEventStreamFrames(buffer: Uint8Array, onFrame: (frame: EventStreamFrame) => void): Uint8Array | null {
  let rest = buffer
  while (rest.byteLength >= preludeLength) {
    const view = new DataView(rest.buffer, rest.byteOffset, rest.byteLength)
    const totalLength = view.getUint32(0)
    const headersLength = view.getUint32(4)
    if (totalLength < preludeLength + messageCrcLength || headersLength > totalLength - preludeLength - messageCrcLength) return null
    if (rest.byteLength < totalLength) break
    const headers = parseHeaders(rest.subarray(preludeLength, preludeLength + headersLength))
    if (!headers) return null
    onFrame({ headers, payload: rest.subarray(preludeLength + headersLength, totalLength - messageCrcLength) })
    rest = rest.subarray(totalLength)
  }
  return rest
}

export function createBedrockConverseEventStreamUsageParser(options: { maxBufferLength?: number } = {}): UsageParser {
  const maxBufferLength = options.maxBufferLength ?? defaultMaxBufferLength
  const usage = emptyUsage()
  let buffer: Uint8Array = new Uint8Array(0)
  let failed = false

  function onFrame(frame: EventStreamFrame) {
    if (frame.headers.get(":event-type") !== "metadata") return
    let event: unknown
    try {
      event = JSON.parse(decoder.decode(frame.payload))
    } catch {
      return
    }
    if (isRecord(event)) applyUsage(usage, event.usage)
  }

  function pushBytes(chunk: Uint8Array) {
    if (failed) return
    const joined = new Uint8Array(buffer.byteLength + chunk.byteLength)
    joined.set(buffer)
    joined.set(chunk, buffer.byteLength)
    const rest = readEventStreamFrames(joined, onFrame)
    if (rest === null || rest.byteLength > maxBufferLength) {
      failed = true
      buffer = new Uint8Array(0)
      return
    }
    buffer = rest
  }

  return {
    pushBytes,
    push(chunkText) {
      pushBytes(encoder.encode(chunkText))
    },
    result() {
      return failed ? emptyUsage() : { ...usage }
    },
  }
}
