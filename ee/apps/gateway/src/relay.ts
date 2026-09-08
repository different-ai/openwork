// Shared helpers for relaying upstream responses (OpenRouter route + org
// provider gateway).
import { createHash } from "node:crypto"

export type StreamHooks = {
  chunk(value: Uint8Array): void
  done(): void
  fail(): void
}

export function upstreamLifetime(signal: AbortSignal, timeoutMs = 30 * 60_000) {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    abort,
    dispose() { clearTimeout(timer); signal.removeEventListener("abort", abort) },
  }
}

export class RequestBodyLimitError extends Error {}

export async function readBoundedBody(request: Request, maxBytes = 32 * 1024 * 1024): Promise<Uint8Array<ArrayBuffer>> {
  if (!request.body) return new Uint8Array()
  const lifetime = upstreamLifetime(request.signal)
  const reader = request.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  lifetime.signal.addEventListener("abort", abort, { once: true })
  if (lifetime.signal.aborted) abort()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    lifetime.signal.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      lifetime.signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) {
        abort()
        throw new RequestBodyLimitError("Request body exceeds the gateway limit")
      }
      chunks.push(chunk.value)
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return body
  } finally {
    lifetime.signal.removeEventListener("abort", abort)
    lifetime.dispose()
    reader.releaseLock()
  }
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

export function trackStream(body: ReadableStream<Uint8Array>, hooks: StreamHooks, lifetime?: ReturnType<typeof upstreamLifetime>) {
  const reader = body.getReader()
  let ended = false
  const observe = (run: () => void) => { try { run() } catch { /* Accounting must never interrupt bytes. */ } }
  const finish = (failed: boolean) => {
    if (ended) return
    ended = true
    lifetime?.signal.removeEventListener("abort", abort)
    lifetime?.dispose()
    observe(failed ? hooks.fail : hooks.done)
  }
  let streamController: ReadableStreamDefaultController<Uint8Array>
  const abort = () => {
    finish(true)
    streamController.error(new Error("Inference upstream cancelled"))
    void reader.cancel().catch(() => {})
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      lifetime?.signal.addEventListener("abort", abort, { once: true })
      if (lifetime?.signal.aborted) abort()
    },
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (ended) return
        if (chunk.done) {
          finish(false)
          controller.close()
          return
        }
        observe(() => hooks.chunk(chunk.value))
        controller.enqueue(chunk.value)
      } catch {
        if (ended) return
        finish(true)
        lifetime?.abort()
        controller.error(new Error("Inference upstream body failed"))
      }
    },
    async cancel(reason) {
      // Mark cancellation before observers classify the completed request.
      lifetime?.signal.removeEventListener("abort", abort)
      lifetime?.abort()
      finish(true)
      await reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
}
