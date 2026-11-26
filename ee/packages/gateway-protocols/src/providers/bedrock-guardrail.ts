import { isJsonObject, type JsonObject } from "@openwork-ee/gateway-protocols/chat"
import { encodeEventStreamFrame, eventStreamFrameChecksumsValid, readEventStreamFrames } from "@openwork-ee/gateway-protocols/usage/bedrock-converse"

export const BEDROCK_GUARDRAIL_BLOCKED_MESSAGE = "Your organization’s guardrail blocked this prompt or response. Contact your administrator if you need help."

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const maxBufferedBytes = 16 * 1024 * 1024
const safeLimitMessage = "The guarded response exceeded the safe buffering limit."

async function readBoundedBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader()
  let bytes = new Uint8Array(0)
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const size = length + next.value.length
      if (size > maxBufferedBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      if (size > bytes.length) {
        const grown = new Uint8Array(Math.min(maxBufferedBytes, Math.max(size, bytes.length * 2, 65536)))
        grown.set(bytes)
        bytes = grown
      }
      bytes.set(next.value, length)
      length = size
    }
    return bytes.subarray(0, length)
  } finally {
    reader.releaseLock()
  }
}

function json(bytes: Uint8Array): JsonObject | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes))
    return isJsonObject(value) ? value : null
  } catch {
    return null
  }
}

function event(type: string, payload: JsonObject) {
  return encodeEventStreamFrame(new Map([
    [":message-type", "event"], [":event-type", type], [":content-type", "application/json"],
  ]), encoder.encode(JSON.stringify(payload)))
}

function exception(message: string) {
  return encodeEventStreamFrame(new Map([
    [":message-type", "exception"], [":exception-type", "modelStreamErrorException"], [":content-type", "application/json"],
  ]), encoder.encode(JSON.stringify({ message, originalMessage: message, originalStatusCode: 403 })))
}

function transformedResponse(response: Response, body: BodyInit, status = response.status) {
  const headers = new Headers(response.headers)
  for (const name of ["content-length", "content-encoding", "etag", "content-md5"]) headers.delete(name)
  return new Response(body, { status, statusText: status === response.status ? response.statusText : undefined, headers })
}

function normalizeStream(body: ReadableStream<Uint8Array>, converse: boolean) {
  let pending: Uint8Array = new Uint8Array(0)
  let held: Uint8Array[] = []
  let heldBytes = 0
  let finished = false
  let stopped = false
  let maxIndex = -1
  const toolBlocks = new Set<number>()

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const fail = (message: string) => {
        controller.enqueue(exception(message))
        held = []
        heldBytes = 0
        pending = new Uint8Array(0)
        finished = true
        controller.terminate()
      }
      const hold = (bytes: Uint8Array) => {
        if (heldBytes + bytes.length > maxBufferedBytes) {
          fail(safeLimitMessage)
          return
        }
        held.push(bytes.slice())
        heldBytes += bytes.length
      }
      for (let offset = 0; offset < chunk.length && !finished; offset += 65536) {
        const part = chunk.subarray(offset, offset + 65536)
        const joined = new Uint8Array(pending.length + part.length)
        joined.set(pending)
        joined.set(part, pending.length)
        const rest = readEventStreamFrames(joined, (frame, bytes) => {
          if (finished) return
          if (!eventStreamFrameChecksumsValid(bytes)) { fail("The provider sent a malformed guarded event stream."); return }
          const payload = json(frame.payload)
          const type = frame.headers.get(":event-type")
          const messageType = frame.headers.get(":message-type")
          if (messageType === "exception" || messageType === "error") {
            held = []
            heldBytes = 0
            controller.enqueue(bytes.slice())
            finished = true
            controller.terminate()
            return
          }
          if (!payload) { fail("The provider sent a malformed guarded response."); return }
          if (!converse) {
            if (type === "chunk") {
              if (typeof payload.bytes !== "string") { fail("The provider sent a malformed guarded response."); return }
              let modelPayload: JsonObject | null
              try {
                const decoded = atob(payload.bytes)
                const modelBytes = new Uint8Array(decoded.length)
                for (let index = 0; index < decoded.length; index++) modelBytes[index] = decoded.charCodeAt(index)
                modelPayload = json(modelBytes)
              } catch {
                fail("The provider sent a malformed guarded response.")
                return
              }
              if (!modelPayload) { fail("The provider sent a malformed guarded response."); return }
              if (modelPayload["amazon-bedrock-guardrailAction"] === "INTERVENED") {
                fail(BEDROCK_GUARDRAIL_BLOCKED_MESSAGE)
                return
              }
            }
            hold(bytes)
            return
          }
          const index = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : -1
          maxIndex = Math.max(maxIndex, index)
          if (type === "contentBlockStart" && isJsonObject(payload.start) && isJsonObject(payload.start.toolUse)) toolBlocks.add(index)
          if (type === "contentBlockDelta" && isJsonObject(payload.delta) && isJsonObject(payload.delta.toolUse)) toolBlocks.add(index)
          if (type === "messageStop") {
            stopped = true
            if (payload.stopReason === "guardrail_intervened") {
              held = []
              heldBytes = 0
              const contentBlockIndex = maxIndex + 1
              controller.enqueue(event("contentBlockDelta", { contentBlockIndex, delta: { text: BEDROCK_GUARDRAIL_BLOCKED_MESSAGE } }))
              controller.enqueue(event("contentBlockStop", { contentBlockIndex }))
            } else {
              if (payload.stopReason === "tool_use") for (const item of held) controller.enqueue(item)
              held = []
              heldBytes = 0
            }
            controller.enqueue(bytes.slice())
          } else if (toolBlocks.has(index)) {
            if (stopped) { fail("The provider sent tool content after its guarded response ended."); return }
            hold(bytes)
          } else {
            controller.enqueue(bytes.slice())
          }
        })
        if (finished) return
        if (rest === null || rest.length > maxBufferedBytes || (rest.length >= 4 && new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getUint32(0) > maxBufferedBytes)) {
          fail("The provider sent a malformed guarded event stream.")
          return
        }
        pending = rest.slice()
      }
    },
    flush(controller) {
      if (finished) return
      if (pending.length || (converse && !stopped)) {
        controller.enqueue(exception("The provider ended the guarded response before it was complete."))
        return
      }
      for (const bytes of held) controller.enqueue(bytes)
    },
  }))
}

/** Call only after the organization guardrail configuration and feature gate have been checked. */
export async function normalizeBedrockGuardrailResponse(response: Response, operation: string): Promise<Response> {
  if (!response.ok || !response.body) return response
  const name = operation.toLowerCase().replace(/[^a-z]/g, "")
  const normalized = name === "invoke" ? "invokemodel" : name === "invokewithresponsestream" ? "invokemodelwithresponsestream" : name
  if (normalized === "conversestream" || normalized === "invokemodelwithresponsestream") {
    return transformedResponse(response, normalizeStream(response.body, normalized === "conversestream"))
  }
  if (normalized !== "converse" && normalized !== "invokemodel") return response
  const bytes = await readBoundedBody(response.body)
  const payload = bytes ? json(bytes) : null
  if (!payload || !bytes) {
    const malformed = transformedResponse(response, JSON.stringify({ message: bytes ? "The provider sent a malformed guarded response." : safeLimitMessage }), 502)
    malformed.headers.set("content-type", "application/json")
    malformed.headers.set("x-amzn-errortype", "ModelErrorException")
    return malformed
  }
  const intervened = normalized === "converse" ? payload.stopReason === "guardrail_intervened" : payload["amazon-bedrock-guardrailAction"] === "INTERVENED"
  if (!intervened) return transformedResponse(response, bytes)
  if (normalized === "converse") {
    const output = isJsonObject(payload.output) ? payload.output : {}
    return transformedResponse(response, JSON.stringify({
      ...payload,
      output: { ...output, message: { role: "assistant", content: [{ text: BEDROCK_GUARDRAIL_BLOCKED_MESSAGE }] } },
    }))
  }
  const blocked = transformedResponse(response, JSON.stringify({ message: BEDROCK_GUARDRAIL_BLOCKED_MESSAGE }), 403)
  blocked.headers.set("content-type", "application/json")
  blocked.headers.set("x-amzn-errortype", "AccessDeniedException")
  return blocked
}
