import { captureResponseIdentity, defaultMaxBufferLength, emptyUsage, hasUsage, isRecord, readNumber } from "@openwork-ee/gateway-protocols/usage/shared"
import type { ParsedUsage, UsageParser } from "@openwork-ee/gateway-protocols/usage/shared"

const preludeLength = 12
const messageCrcLength = 4
const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function isAwsEventStreamContentType(contentType: string | null) {
  return contentType?.split(";")[0].trim().toLowerCase() === "application/vnd.amazon.eventstream"
}

function applyUsage(target: ParsedUsage, usage: unknown) {
  if (!isRecord(usage)) return
  target.inputTokens = readNumber(usage.inputTokens)
  target.outputTokens = readNumber(usage.outputTokens)
  target.totalTokens = readNumber(usage.totalTokens)
  target.cacheReadTokens = readNumber(usage.cacheReadInputTokens)
  target.cacheWriteTokens = readNumber(usage.cacheWriteInputTokens)
  target.found = hasUsage(target)
}

export function parseBedrockConverseJsonUsage(body: unknown): ParsedUsage {
  const usage = emptyUsage()
  if (isRecord(body)) {
    captureResponseIdentity(usage, body)
    if (typeof body.modelId === "string") usage.model = body.modelId
    applyUsage(usage, body.usage)
  }
  return usage
}

export type EventStreamFrame = { headers: Map<string, string>; payload: Uint8Array }

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Encode an AWS event-stream frame, including both required CRC32 checksums. */
export function encodeEventStreamFrame(headers: ReadonlyMap<string, string>, payload: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = []
  let headersLength = 0
  for (const [name, value] of headers) {
    const nameBytes = encoder.encode(name)
    const valueBytes = encoder.encode(value)
    if (nameBytes.length > 255 || valueBytes.length > 65535) throw new Error("Event stream header is too long.")
    const part = new Uint8Array(nameBytes.length + valueBytes.length + 4)
    part[0] = nameBytes.length
    part.set(nameBytes, 1)
    part[1 + nameBytes.length] = 7
    new DataView(part.buffer).setUint16(2 + nameBytes.length, valueBytes.length)
    part.set(valueBytes, 4 + nameBytes.length)
    parts.push(part)
    headersLength += part.length
  }
  const totalLength = preludeLength + headersLength + payload.length + messageCrcLength
  const bytes = new Uint8Array(totalLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, totalLength)
  view.setUint32(4, headersLength)
  view.setUint32(8, crc32(bytes.subarray(0, 8)))
  let offset = preludeLength
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  bytes.set(payload, offset)
  view.setUint32(totalLength - messageCrcLength, crc32(bytes.subarray(0, totalLength - messageCrcLength)))
  return bytes
}

/** Validate both CRC32 checksums on a complete AWS event-stream frame. */
export function eventStreamFrameChecksumsValid(bytes: Uint8Array): boolean {
  if (bytes.length < preludeLength + messageCrcLength) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== bytes.length) return false
  return view.getUint32(8) === crc32(bytes.subarray(0, 8))
    && view.getUint32(bytes.length - messageCrcLength) === crc32(bytes.subarray(0, bytes.length - messageCrcLength))
}

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
      return offset + 2 <= view.byteLength ? 2 + view.getUint16(offset) : null
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
    if (offset + nameLength + 1 > bytes.byteLength) return null
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

export function readEventStreamFrames(buffer: Uint8Array, onFrame: (frame: EventStreamFrame, bytes: Uint8Array) => void): Uint8Array | null {
  let rest = buffer
  while (rest.byteLength >= preludeLength) {
    const view = new DataView(rest.buffer, rest.byteOffset, rest.byteLength)
    const totalLength = view.getUint32(0)
    const headersLength = view.getUint32(4)
    if (totalLength < preludeLength + messageCrcLength || headersLength > totalLength - preludeLength - messageCrcLength) return null
    if (rest.byteLength < totalLength) break
    const headers = parseHeaders(rest.subarray(preludeLength, preludeLength + headersLength))
    if (!headers) return null
    onFrame({ headers, payload: rest.subarray(preludeLength + headersLength, totalLength - messageCrcLength) }, rest.subarray(0, totalLength))
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
    if (["error", "exception"].includes(frame.headers.get(":message-type") ?? "")) usage.streamError = "upstream_stream_error"
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
    let offset = 0
    while (offset < chunk.byteLength && !failed) {
      const take = Math.min(chunk.byteLength - offset, maxBufferLength - buffer.byteLength)
      if (take <= 0) { failed = true; break }
      const joined = new Uint8Array(buffer.byteLength + take)
      joined.set(buffer)
      joined.set(chunk.subarray(offset, offset + take), buffer.byteLength)
      offset += take
      const rest = readEventStreamFrames(joined, onFrame)
      if (rest === null || (rest.byteLength >= preludeLength && new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getUint32(0) > maxBufferLength)) {
        failed = true
        break
      }
      buffer = rest.slice()
    }
    if (failed) buffer = new Uint8Array(0)
  }

  return {
    pushBytes,
    push(chunkText) {
      pushBytes(encoder.encode(chunkText))
    },
    complete() { return !failed && buffer.length === 0 && usage.found && !usage.streamError },
    result() {
      return failed ? { ...emptyUsage(), ...(usage.streamError ? { streamError: usage.streamError } : {}) } : { ...usage }
    },
  }
}
