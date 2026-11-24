import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { isEventStreamContentType, readBoundedBody } from "./relay.js"

export type EarlyStreamProtocol = Extract<GatewayRequestProtocol, "openai_chat" | "openai_responses" | "anthropic_messages" | "google_generate_content">

type JsonRecord = Record<string, unknown>

export type EarlyResponseOptions = {
  pending: Promise<Response>
  protocol: EarlyStreamProtocol
  commitAfterMs: number
  heartbeatMs: number
  headers: Record<string, string>
  onCommit?(): void
  onCancel?(): void
}

const encoder = new TextEncoder()
const heartbeat = encoder.encode(": processing\n\n")
const errorBodyLimit = 65_536

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

export async function respondBeforeUpstream(options: EarlyResponseOptions): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.commitAfterMs) })
  const settled = await Promise.race([options.pending, deadline]).finally(() => clearTimeout(timer))
  if (settled) return settled
  try { options.onCommit?.() } catch {}
  const headers = new Headers(options.headers)
  headers.set("content-type", "text/event-stream; charset=utf-8")
  headers.set("cache-control", "no-store")
  headers.set("x-accel-buffering", "no")
  return new Response(heldStream(options), { status: 200, headers })
}

function heldStream(options: EarlyResponseOptions): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let cancelled = false
  let beat: ReturnType<typeof setInterval> | undefined
  const stopBeating = () => { if (beat) clearInterval(beat); beat = undefined }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(heartbeat)
      beat = setInterval(() => {
        try { controller.enqueue(heartbeat) } catch { stopBeating() }
      }, options.heartbeatMs)
      let response: Response | null
      try { response = await options.pending } catch { response = null }
      finally { stopBeating() }
      if (cancelled) {
        await response?.body?.cancel().catch(() => {})
        return
      }
      try {
        if (response?.ok && response.body && isEventStreamContentType(response.headers.get("content-type"))) {
          reader = response.body.getReader()
          return
        }
        const status = response === null ? 502 : response.ok ? 502 : response.status
        const payload = response === null ? null : response.ok ? (await response.body?.cancel().catch(() => {}), null) : await readErrorPayload(response)
        controller.enqueue(encoder.encode(earlyErrorEvent(options.protocol, status, payload)))
        controller.close()
      } catch {
        try { controller.close() } catch {}
      }
    },
    async pull(controller) {
      if (!reader) return
      try {
        const chunk = await reader.read()
        if (chunk.done) controller.close()
        else controller.enqueue(chunk.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      stopBeating()
      if (reader) await reader.cancel(reason).catch(() => {})
      else try { options.onCancel?.() } catch {}
    },
  }, { highWaterMark: 0 })
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    const bytes = await readBoundedBody({ body: response.body, signal: AbortSignal.timeout(5000) }, errorBodyLimit)
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    await response.body?.cancel().catch(() => {})
    return null
  }
}

function anthropicErrorType(status: number) {
  if (status === 400 || status === 413 || status === 422) return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 429) return "rate_limit_error"
  if (status === 503 || status === 529) return "overloaded_error"
  return "api_error"
}

export function earlyErrorEvent(protocol: EarlyStreamProtocol, status: number, payload: unknown): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  const message = text(error?.message) ?? (isRecord(payload) ? text(payload.message) : null)
    ?? `The provider failed with HTTP ${status} after the response started. Your work is preserved; retry when it recovers.`
  const code = text(error?.code) ?? (typeof error?.code === "number" ? String(error.code) : null) ?? text(error?.type) ?? `http_${status}`
  switch (protocol) {
    case "anthropic_messages": {
      const type = text(error?.type) ?? anthropicErrorType(status)
      return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`
    }
    case "openai_responses":
      return `event: error\ndata: ${JSON.stringify({ type: "error", code, message, param: null, sequence_number: 0 })}\n\n`
    case "google_generate_content":
      return `data: ${JSON.stringify({ error: { code: status, message, status: text(error?.status) ?? "UNAVAILABLE" } })}\n\n`
    case "openai_chat":
      return `data: ${JSON.stringify({ error: { ...(error ?? {}), message, code, type: text(error?.type) ?? (status >= 500 ? "api_error" : "invalid_request_error") } })}\n\n`
  }
}
