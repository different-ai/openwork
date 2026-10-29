import { z } from "zod"
import type { Config } from "./config.js"
import { createModelAdapter, ModelError } from "./model.js"
import { headlessModelAccessSchema, type HeadlessModelAccess } from "@openwork-ee/headless-protocol"

export const MODEL_PROBE_TIMEOUT_MS = 8_000
export const MODEL_PROBE_OUTPUT_TOKENS = 32
const MAX_RESPONSE_BYTES = 16_384
const modelId = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)
const bodySchema = z.strictObject({ model: modelId, modelAccess: headlessModelAccessSchema.optional() })
export type ModelProbeError = "credentials_unavailable" | "authentication_failed" | "payment_required" | "provider_unavailable" | "timed_out" | "invalid_response" | "busy"
export type ModelProbeResult = { status: "answered" | "failed"; errorCode: ModelProbeError | null; requestedModel: string; reportedModel: string | null }
export type ModelProbe = (model: string, signal: AbortSignal, modelAccess?: HeadlessModelAccess) => Promise<ModelProbeResult>

/** Closed vocabulary only: neither a provider error type/code nor its text becomes a diagnostic result. */
export function sanitizeModelError(error: unknown): ModelProbeError {
  if (error instanceof ModelError) {
    if (error.code === "model_http_401" || error.code === "model_http_403") return "authentication_failed"
    if (error.code === "model_http_402" || error.code === "model_payment_required") return "payment_required"
    if (error.code === "model_bad_response") return "invalid_response"
  }
  return "provider_unavailable"
}

/** The probe never uses a session, runner instructions, tools, files, MCP or member content. */
export function createModelProbe(config: Config, transport: typeof fetch = fetch): ModelProbe {
  let active = false
  return async (requestedModel, callerSignal, modelAccess) => {
    const failed = (errorCode: ModelProbeError): ModelProbeResult => ({ status: "failed", errorCode, requestedModel, reportedModel: null })
    const apiKey = modelAccess?.apiKey ?? config.model.defaultApiKey
    if (!apiKey) return failed("credentials_unavailable")
    if (active) return failed("busy")
    active = true
    const deadline = AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS)
    const signal = AbortSignal.any([deadline, callerSignal])
    let reportedModel: string | null = null
    // Use the real adapter while bounding its response and observing only the provider's model identifier.
    const boundedFetch: typeof fetch = async (input, init) => {
      const response = await transport(input, { ...init, signal })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        if (reader) for (;;) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_RESPONSE_BYTES) throw new Error("probe_response_too_large")
          chunks.push(chunk.value)
        }
      } finally {
        await reader?.cancel().catch(() => undefined)
      }
      const raw = Buffer.concat(chunks).toString("utf8")
      if (response.ok) {
        try {
          const envelope = z.object({ model: modelId.optional() }).safeParse(JSON.parse(raw))
          const id = envelope.success ? envelope.data.model : undefined
          if (id && !id.includes(apiKey) && !apiKey.includes(id) && !/^(?:sk-|ow_|key[-_])/i.test(id)) reportedModel = id
        } catch { /* The adapter will reject malformed JSON. */ }
      }
      const headers = new Headers(response.headers)
      headers.delete("content-length")
      headers.delete("content-encoding")
      return new Response(raw, { status: response.status, headers })
    }
    try {
      const adapter = createModelAdapter(modelAccess ?? { baseUrl: config.model.baseUrl, protocol: config.model.protocol, apiKey }, { maxOutputTokens: MODEL_PROBE_OUTPUT_TOKENS, fetch: boundedFetch })
      const answer = await adapter.complete({
        model: requestedModel,
        apiKey,
        system: "This is a synthetic service health check. Reply with the single word READY.",
        messages: [{ role: "user", text: "Reply with READY." }],
        tools: [],
        signal,
      })
      if (signal.aborted) return failed("timed_out")
      if (!answer.text.trim() || answer.toolCalls.length > 0) return failed("invalid_response")
      return { status: "answered", errorCode: null, requestedModel, reportedModel }
    } catch (error) {
      if (signal.aborted) return failed("timed_out")
      return failed(sanitizeModelError(error))
    } finally {
      active = false
    }
  }
}

/** Mounted after existing service-token and body-limit middleware; never forwarded into an owner's cell. */
export async function modelProbeResponse(request: Request, probe: ModelProbe | undefined): Promise<Response> {
  const headers = { "cache-control": "no-store" }
  const body = bodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400, headers })
  if (!probe) return Response.json({ error: "model_probe_unavailable" }, { status: 503, headers })
  return Response.json(await probe(body.data.model, request.signal, body.data.modelAccess), { headers })
}
