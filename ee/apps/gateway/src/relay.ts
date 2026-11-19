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

export type UpstreamFetchFailure = {
  outcome: "client_aborted" | "upstream_unreachable"
  status: 502 | 504
  code: "request_cancelled" | "upstream_timeout" | "upstream_unreachable"
  /** Plain words for the person who sent the request. */
  message: string
  /** The network error code (ECONNRESET, ENOTFOUND, ...), for logs. */
  cause: string | undefined
}

const NETWORK_CAUSES: Record<string, string> = {
  ENOTFOUND: "its address could not be found",
  EAI_AGAIN: "its address could not be looked up",
  ECONNREFUSED: "it refused the connection",
  ECONNRESET: "the connection was dropped",
  EPIPE: "the connection was dropped",
  UND_ERR_SOCKET: "the connection was dropped",
  UND_ERR_CLOSED: "the connection was dropped",
  ETIMEDOUT: "the connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
  UND_ERR_HEADERS_TIMEOUT: "it took too long to answer",
  EHOSTUNREACH: "the network path to it is down",
  ENETUNREACH: "the network path to it is down",
  CERT_HAS_EXPIRED: "its security certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "its security certificate could not be verified",
  SELF_SIGNED_CERT_IN_CHAIN: "its security certificate could not be verified",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its security certificate could not be verified",
  ERR_TLS_CERT_ALTNAME_INVALID: "its security certificate does not match its address",
}

function networkErrorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current !== "object") break
    const code = "code" in current ? current.code : undefined
    if (typeof code === "string" && /^[\w.-]{1,64}$/.test(code)) return code
    current = "cause" in current ? current.cause : undefined
  }
  return undefined
}

/**
 * A provider that cannot be reached is the provider's problem, not ours: describe it
 * to the caller in plain words instead of reporting it as a Gateway error.
 */
export function describeUpstreamFetchFailure(error: unknown, input: { clientAborted: boolean; timedOut: boolean; target: string }): UpstreamFetchFailure {
  const cause = networkErrorCode(error) ?? (error instanceof Error && error.name !== "Error" ? error.name : undefined)
  if (input.clientAborted && !input.timedOut) {
    return { outcome: "client_aborted", status: 502, code: "request_cancelled", message: "Request cancelled.", cause }
  }
  if (input.timedOut) {
    return { outcome: "upstream_unreachable", status: 504, code: "upstream_timeout", message: `${input.target} took too long to respond. Your work is preserved; try again.`, cause }
  }
  const reason = cause === "InferenceEgressError" ? "its address is not allowed" : cause ? NETWORK_CAUSES[cause] : undefined
  return {
    outcome: "upstream_unreachable",
    status: 502,
    code: "upstream_unreachable",
    message: `Couldn't reach ${input.target}${reason ? `: ${reason}` : ""}. Your work is preserved; try again in a moment.`,
    cause,
  }
}

export class RequestBodyLimitError extends Error {}

export async function readBoundedBody(request: Pick<Request, "body" | "signal">, maxBytes = 32 * 1024 * 1024): Promise<Uint8Array<ArrayBuffer>> {
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
    // A caller that went away reads nothing. Erroring its stream would only make the HTTP server log a crash.
    if (lifetime?.timedOut) streamController.error(new Error("Inference upstream timed out"))
    else streamController.close()
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
