// Shared helpers for relaying upstream responses (OpenRouter route + org
// provider gateway).
import { createHash } from "node:crypto"

export type StreamHooks = {
  chunk(value: Uint8Array): void
  done(): void
  fail(): void
}

export function buildRequestId() {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32)
}

export function isJsonContentType(contentType: string | null) {
  if (!contentType) return false
  const mediaType = contentType.split(";")[0].trim().toLowerCase()
  if (mediaType === "application/json") return true
  const applicationPrefix = "application/"
  const jsonSuffix = "+json"
  return mediaType.startsWith(applicationPrefix)
    && mediaType.endsWith(jsonSuffix)
    && mediaType.length > applicationPrefix.length + jsonSuffix.length
}

export function isEventStreamContentType(contentType: string | null) {
  return contentType?.split(";")[0].trim().toLowerCase() === "text/event-stream"
}

export function trackStream(body: ReadableStream<Uint8Array>, hooks: StreamHooks) {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          hooks.done()
          controller.close()
          return
        }
        hooks.chunk(chunk.value)
        controller.enqueue(chunk.value)
      } catch (error) {
        hooks.fail()
        controller.error(error)
      }
    },
    async cancel(reason) {
      hooks.fail()
      await reader.cancel(reason)
    },
  })
}
