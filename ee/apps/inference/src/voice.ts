import { randomUUID } from "node:crypto"
import type { Hono } from "hono"
import { z } from "zod"
import { inferenceBearerKey } from "@openwork-ee/utils/inference-bearer-key"
import { INFERENCE_USAGE_CONVERSION_FACTOR, INFERENCE_WINDOW_TYPES } from "@openwork/types/den/inference"
import { inferenceError } from "./chat-response.js"
import { env } from "./env.js"
import { assertOrganizationManagedModelsAllowed, findActiveInferenceKey, findInferenceKeyById, getOpenRouterProviderKey, readVoiceMembership } from "./keys.js"
import { ensureUsableBuckets } from "./limits.js"
import { VOICE_SPEECH_MODEL, VOICE_TRANSCRIPTION_MODEL } from "./model-catalog.js"
import { pendingVoiceRequests, recordInferenceRequest, type SettleUsageInput } from "./webhooks.js"

const MAX_AUDIO_BYTES = 3 * 1024 * 1024
const MAX_SPEECH_BYTES = 2 * 1024 * 1024
const MAX_SPEECH_SECONDS = 120
const unavailableMessage = "Voice is temporarily unavailable. Check OpenWork Models or try again later."
const accountingMessage = "Voice usage could not be recorded. Try again later."
const membershipMessage = "Voice requires an active OpenWork Models membership."
const transcriptionSchema = z.strictObject({ input_audio: z.strictObject({
  data: z.string().min(4).max(MAX_AUDIO_BYTES * 4 / 3),
  format: z.enum(["webm", "wav", "mp3", "m4a", "ogg"]),
}) })
const speechSchema = z.strictObject({ input: z.string().max(600).trim().min(1) })

export type VoiceDependencies = {
  findActiveInferenceKey: typeof findActiveInferenceKey
  findInferenceKeyById: typeof findInferenceKeyById
  assertOrganizationManagedModelsAllowed: typeof assertOrganizationManagedModelsAllowed
  readVoiceMembership: typeof readVoiceMembership
  getOpenRouterProviderKey: typeof getOpenRouterProviderKey
  ensureUsableBuckets: typeof ensureUsableBuckets
  pendingVoiceRequests: typeof pendingVoiceRequests
  recordInferenceRequest: typeof recordInferenceRequest
  fetch: typeof fetch
  timeoutMs: number
}
const defaults: VoiceDependencies = {
  findActiveInferenceKey, findInferenceKeyById, assertOrganizationManagedModelsAllowed, readVoiceMembership,
  getOpenRouterProviderKey, ensureUsableBuckets, pendingVoiceRequests, recordInferenceRequest, fetch,
  timeoutMs: Math.min(env.upstreamTimeoutMs, 60_000),
}

class VoiceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}
function unavailable() { return new VoiceError("voice_unavailable", 503, unavailableMessage) }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function generationId(value: string | null) {
  return value && /^[a-zA-Z0-9_-]{1,255}$/.test(value) ? value : null
}
function costUnits(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  const amount = Math.max(1, Math.ceil(value * INFERENCE_USAGE_CONVERSION_FACTOR))
  return Number.isSafeInteger(amount) ? amount : null
}
function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    operation.then((value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) })
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort() }
  })
}

async function readBytes(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, maxBytes: number) {
  if (!body) throw new Error("Missing body")
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await waitFor(reader.read(), signal)
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxBytes) throw new VoiceError("voice_payload_too_large", 413, "The audio request exceeds the size limit.")
      chunks.push(chunk.value)
    }
    return new Uint8Array(Buffer.concat(chunks, length))
  } finally { void reader.cancel().catch(() => {}) }
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}

// Count complete MPEG Layer III frames, not a bitrate estimate or an untrusted
// duration header. The bounded buffer also prevents sending partial/corrupt MP3.
export function validateSpeechAudio(bytes: Uint8Array) {
  let offset = 0
  if (bytes.length >= 10 && bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    if (![2, 3, 4].includes(bytes[3]) || bytes.slice(6, 10).some((byte) => byte > 127)) throw unavailable()
    offset = 10 + bytes[6] * 2 ** 21 + bytes[7] * 2 ** 14 + bytes[8] * 128 + bytes[9]
    if (bytes[3] === 4 && (bytes[5] & 16)) offset += 10
  }
  let frames = 0
  let duration = 0
  while (offset < bytes.length) {
    if (bytes.length - offset === 128 && bytes[offset] === 84 && bytes[offset + 1] === 65 && bytes[offset + 2] === 71) { offset += 128; break }
    if (offset + 4 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1] & 224) !== 224) throw unavailable()
    const version = (bytes[offset + 1] >> 3) & 3
    const layer = (bytes[offset + 1] >> 1) & 3
    const bitrateIndex = bytes[offset + 2] >> 4
    const rateIndex = (bytes[offset + 2] >> 2) & 3
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) throw unavailable()
    const bitrate = (version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex]
    const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const size = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((bytes[offset + 2] >> 1) & 1)
    offset += size
    duration += (version === 3 ? 1152 : 576) / sampleRate
    if (offset > bytes.length || duration > MAX_SPEECH_SECONDS) throw unavailable()
    frames += 1
  }
  if (!frames || offset !== bytes.length || bytes.length > MAX_SPEECH_BYTES) throw unavailable()
}

function receipt(key: SettleUsageInput["inferenceKey"], requestId: string, model: string, occurredAt: Date): SettleUsageInput {
  return { inferenceKey: key, costAmount: null, span: {
    orgMembershipId: key.org_membership_id, inferenceKeyId: key.id, openworkRequestId: requestId,
    occurredAt, reportedModel: model, requestModel: model, responseModel: null,
    inputCost: null, outputCost: null, externalEventId: null, generationId: null,
    usageMetadata: { requestModel: model, responseModel: null, inputCost: null, outputCost: null, totalCost: null,
      inputTokens: null, outputTokens: null, totalTokens: null, generationId: null, spanId: null, traceId: requestId, spanName: null, currency: "USD" },
  } }
}

async function generationCost(input: SettleUsageInput, providerKey: string, dependencies: VoiceDependencies, signal: AbortSignal) {
  if (!input.span.generationId) return null
  const url = new URL(`${env.openRouterUpstreamUrl}/generation`)
  url.searchParams.set("id", input.span.generationId)
  try {
    const response = await waitFor(dependencies.fetch(url, {
      headers: { authorization: `Bearer ${providerKey}`, accept: "application/json" }, redirect: "error", signal,
    }), signal)
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return null }
    const payload = json(await readBytes(response.body, signal, 64 * 1024))
    const data = object(payload) ? payload.data : null
    if (!object(data) || data.id !== input.span.generationId || data.model !== input.span.reportedModel
      || data.api_type != null && data.api_type !== (input.span.reportedModel === VOICE_SPEECH_MODEL ? "tts" : "stt")) return null
    return costUnits(data.total_cost)
  } catch { return null }
}

export function registerVoiceRoutes(app: Hono, dependencies: VoiceDependencies = defaults) {
  for (const path of ["/api/v1/voice", "/api/v1/audio/transcriptions", "/api/v1/audio/speech"]) {
    app.all(path, async (c) => {
      const statusRead = path === "/api/v1/voice" && c.req.method === "GET"
      const requestId = randomUUID()
      const headers = new Headers({ "cache-control": "no-store", "x-openwork-request-id": requestId })
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), dependencies.timeoutMs)
      const signal = AbortSignal.any([deadline.signal, c.req.raw.signal])
      let requestReceipt: SettleUsageInput | null = null
      let providerKey = ""
      let dispatched = false
      let response: Response
      try {
        try {
          const authorization = c.req.header("authorization")
          const rawKey = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : c.req.header("x-api-key")?.trim()
          if (!rawKey || rawKey.length > 4096) throw new VoiceError("invalid_api_key", 401, "A valid OpenWork inference key is required.")
          const bearer = inferenceBearerKey(rawKey)
          const key = await waitFor(dependencies.findActiveInferenceKey(bearer), signal)
          if (!key) throw new VoiceError("invalid_api_key", 401, "A valid OpenWork inference key is required.")
          if (c.req.method !== (path === "/api/v1/voice" ? "GET" : "POST")) throw new VoiceError("method_not_allowed", 405, "Unsupported voice request method.")
          if (new URL(c.req.url).search) throw new VoiceError("voice_invalid_request", 400, "Voice requests do not accept query parameters.")
          const checkAccess = async () => {
            const access = await waitFor(dependencies.readVoiceMembership(key.organization_id), signal)
            if (access === "membership_required") throw new VoiceError("voice_membership_required", 403, membershipMessage)
            if (access !== "ready") throw unavailable()
            await waitFor(dependencies.assertOrganizationManagedModelsAllowed(key.organization_id), signal)
          }
          await checkAccess()
          const provider = await waitFor(dependencies.getOpenRouterProviderKey(key.organization_id), signal)
          if (!provider?.encrypted_api_key) throw unavailable()
          providerKey = provider.encrypted_api_key

          // Best-effort receipt reads, never resynthesis or a readiness barrier.
          // Bound the whole batch so a lost provider receipt cannot stall voice.
          if (!statusRead) {
            const reconciliation = AbortSignal.any([signal, AbortSignal.timeout(1_000)])
            try {
              const pending = await waitFor(dependencies.pendingVoiceRequests(key.organization_id, key.org_membership_id), reconciliation)
              await waitFor(Promise.all(pending.map(async (entry) => {
                if (!entry.inference_key_id || !entry.model_id) return
                const originalKey = await waitFor(dependencies.findInferenceKeyById(entry.inference_key_id), reconciliation)
                if (!originalKey) return
                const prior = receipt(originalKey, entry.external_job_id, entry.model_id, entry.occurred_at)
                prior.span.generationId = generationId(entry.external_event_id)
                prior.span.externalEventId = prior.span.generationId
                prior.costAmount = entry.event_type === "openrouter_audio" ? entry.cost_amount : await generationCost(prior, providerKey, dependencies, reconciliation)
                if (prior.costAmount !== null) await waitFor(dependencies.recordInferenceRequest(prior), reconciliation)
              })), reconciliation)
            } catch { /* Durable holds survive a failed or timed-out receipt lookup. */ }
          }

          let body: Record<string, unknown> = {}
          if (!statusRead) {
            if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || c.req.header("content-encoding")) {
              throw new VoiceError("unsupported_media_type", 415, "Voice requires an uncompressed JSON request.")
            }
            const limit = path.endsWith("/speech") ? 4096 : MAX_AUDIO_BYTES * 4 / 3 + 256
            const contentLength = c.req.header("content-length")
            if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) throw new VoiceError("voice_payload_too_large", 413, "The audio request exceeds the size limit.")
            try {
              const value = json(await readBytes(c.req.raw.body, signal, limit))
              if (path.endsWith("/speech")) {
                body = { ...speechSchema.parse(value), model: VOICE_SPEECH_MODEL, voice: "coral", response_format: "mp3" }
              } else {
                const input = transcriptionSchema.parse(value)
                const data = input.input_audio.data
                if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid base64")
                const decoded = Buffer.from(data, "base64")
                if (!decoded.length || decoded.length > MAX_AUDIO_BYTES || decoded.toString("base64") !== data) throw new Error("Invalid base64")
                body = { ...input, model: VOICE_TRANSCRIPTION_MODEL, response_format: "json" }
              }
            } catch (error) {
              if (error instanceof VoiceError || signal.aborted) throw error
              throw new VoiceError("voice_invalid_request", 400, "Use audio up to 3 MiB, or nonempty speech text up to 600 characters.")
            }
          }
          const limits = await waitFor(dependencies.ensureUsableBuckets(key.organization_id), signal)
          if (!limits.ok) throw new VoiceError("voice_quota_exhausted", 429, "Your shared Models allowance is exhausted. Try again after it resets.")
          if (INFERENCE_WINDOW_TYPES.some((window) => !limits.bucketIds[window])) throw unavailable()
          if (statusRead) return Response.json({ access: "ready" }, { headers })
          const model = path.endsWith("/speech") ? VOICE_SPEECH_MODEL : VOICE_TRANSCRIPTION_MODEL
          requestReceipt = receipt(key, requestId, model, limits.admittedAt)
          const admitted = await waitFor(dependencies.recordInferenceRequest({ ...requestReceipt, admitVoice: true }), signal)
          if (admitted !== "deferred") { requestReceipt = null; throw new VoiceError("voice_quota_exhausted", 429, "Voice capacity is reserved by other requests. Try again after they settle or your allowance resets.") }
          const currentProvider = await waitFor(dependencies.getOpenRouterProviderKey(key.organization_id), signal)
          if (!currentProvider?.encrypted_api_key) throw unavailable()
          providerKey = currentProvider.encrypted_api_key
          await checkAccess()
          const currentKey = await waitFor(dependencies.findActiveInferenceKey(bearer), signal)
          if (!currentKey || currentKey.id !== key.id) throw new VoiceError("invalid_api_key", 401, "The OpenWork inference key is no longer valid.")
          signal.throwIfAborted()
          dispatched = true
          // After dispatch, finish this one bounded packet under the server
          // deadline to obtain its receipt, even if the client disconnects.
          // Cancellation suppresses delivery below; it never regenerates audio.
          const upstream = await waitFor(dependencies.fetch(`${env.openRouterUpstreamUrl}${path.replace("/api/v1", "")}`, {
            method: "POST", redirect: "error", signal: deadline.signal,
            headers: { authorization: `Bearer ${providerKey}`, "content-type": "application/json", "x-openwork-request-id": requestId, "x-title": "OpenWork Inference" },
            body: JSON.stringify({ ...body, user: key.org_membership_id, session_id: requestId, trace: {
              org_membership_id: key.org_membership_id, inference_key_id: key.id,
              openwork_request_id: requestId, usage_started_at: limits.admittedAt.toISOString(),
            } }),
          }), deadline.signal)
          requestReceipt.span.generationId = generationId(upstream.headers.get("x-generation-id"))
          requestReceipt.span.externalEventId = requestReceipt.span.generationId
          if (requestReceipt.span.generationId) {
            const stored = await waitFor(dependencies.recordInferenceRequest(requestReceipt), deadline.signal)
            if (stored === "skipped") { void upstream.body?.cancel().catch(() => {}); throw unavailable() }
          }
          if (!upstream.ok) {
            // These are pre-generation rejections. A generation header (even
            // malformed), a timeout, or a server failure still needs accounting.
            if (!upstream.headers.has("x-generation-id") && [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(upstream.status)) requestReceipt.costAmount = 0
            void upstream.body?.cancel().catch(() => {})
            throw unavailable()
          }
          if (model === VOICE_SPEECH_MODEL) {
            if (upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "audio/mpeg") { void upstream.body?.cancel().catch(() => {}); throw unavailable() }
            const audio = await readBytes(upstream.body, deadline.signal, MAX_SPEECH_BYTES)
            validateSpeechAudio(audio)
            headers.set("content-type", "audio/mpeg")
            response = new Response(audio, { headers })
          } else {
            const payload = json(await readBytes(upstream.body, deadline.signal, 64 * 1024))
            if (object(payload) && object(payload.usage)) requestReceipt.costAmount = costUnits(payload.usage.cost)
            if (!object(payload) || typeof payload.text !== "string" || payload.text.length > 16000) throw unavailable()
            response = Response.json({ text: payload.text }, { headers })
          }
        } catch (error) {
          const failure = c.req.raw.signal.aborted ? new VoiceError("voice_request_cancelled", 408, "Voice request cancelled.")
            : deadline.signal.aborted ? new VoiceError("voice_timeout", 504, "Voice request timed out.")
            : error instanceof VoiceError && !(dispatched && error.status === 413) ? error : unavailable()
          response = statusRead && failure.status !== 401 && failure.status !== 400
            ? Response.json({ access: failure.code === "voice_membership_required" ? "membership_required" : "unavailable", message: failure.message }, { headers })
            : Response.json(inferenceError(failure.code, failure.message), { status: failure.status, headers })
        }
        if (requestReceipt) {
          // Settlement outlives client cancellation, but is itself bounded.
          // Process loss remains explicitly unpriced, with only its original
          // quota windows reserved. Never substitute the estimate for actual cost.
          const accounting = AbortSignal.timeout(10_000)
          try {
            if (!dispatched) requestReceipt.costAmount = 0
            else if (requestReceipt.costAmount === null) requestReceipt.costAmount = await generationCost(requestReceipt, providerKey, dependencies, accounting)
            const settled = await waitFor(dependencies.recordInferenceRequest(requestReceipt), accounting)
            if (settled === "skipped") return Response.json(inferenceError("voice_unavailable", accountingMessage), { status: 503, headers: { "cache-control": "no-store", "x-openwork-request-id": requestId } })
          } catch {
            return Response.json(inferenceError("voice_unavailable", accountingMessage), { status: 503, headers: { "cache-control": "no-store", "x-openwork-request-id": requestId } })
          }
        }
        if (c.req.raw.signal.aborted || deadline.signal.aborted) return Response.json(
          inferenceError(c.req.raw.signal.aborted ? "voice_request_cancelled" : "voice_timeout", "Voice request ended before completion."),
          { status: c.req.raw.signal.aborted ? 408 : 504, headers: { "cache-control": "no-store", "x-openwork-request-id": requestId } },
        )
        return response
      } finally { clearTimeout(timer); deadline.abort() }
    })
  }
}
