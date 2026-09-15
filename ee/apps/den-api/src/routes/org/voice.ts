import { and, eq } from "@openwork-ee/den-db/drizzle"
import { LlmProviderTable } from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { orgMemberRoute } from "../../middleware/route-access.js"
import type { OrganizationContext } from "../../orgs.js"
import { organizationHasActiveInferenceSubscription } from "../../stripe-billing.js"
import type { OrgRouteVariables } from "./shared.js"

const MAX_AUDIO_BYTES = 3 * 1024 * 1024
const MAX_MP3_BYTES = 2 * 1024 * 1024
const transcriptionSchema = z.strictObject({ input_audio: z.strictObject({
  data: z.string().min(4).max(MAX_AUDIO_BYTES * 4 / 3),
  format: z.enum(["webm", "wav", "mp3", "m4a", "ogg"]),
}) })
const speechSchema = z.strictObject({ input: z.string().max(600).trim().min(1) })
const errors = {
  voice_membership_required: { status: 403, message: "Voice requires an active OpenWork Models membership." },
  voice_unavailable: { status: 503, message: "Voice is temporarily unavailable. Try again later." },
  voice_quota_exhausted: { status: 429, message: "Your shared Models allowance is exhausted. Try again after it resets." },
  voice_invalid_request: { status: 400, message: "Use audio up to 3 MiB, or nonempty speech text up to 600 characters." },
  voice_payload_too_large: { status: 413, message: "The audio exceeds the size limit." },
  voice_request_cancelled: { status: 408, message: "Voice request cancelled." },
  voice_timeout: { status: 504, message: "Voice request timed out." },
}
class VoiceError extends Error {
  constructor(readonly code: keyof typeof errors) { super(errors[code].message) }
}
type Identity = { organizationId: OrganizationContext["organization"]["id"]; memberId: OrganizationContext["currentMember"]["id"] }

async function memberKey({ organizationId, memberId }: Identity): Promise<string | null> {
  const [provider] = await db.select({ key: LlmProviderTable.apiKey }).from(LlmProviderTable).where(and(
    eq(LlmProviderTable.organizationId, organizationId),
    eq(LlmProviderTable.createdByOrgMembershipId, memberId),
    eq(LlmProviderTable.source, "openwork"),
    eq(LlmProviderTable.providerId, "openwork"),
  )).limit(1)
  return provider?.key ?? null
}

export type VoiceDependencies = {
  subscribed: typeof organizationHasActiveInferenceSubscription
  memberKey: typeof memberKey
  fetch: (url: string, init: RequestInit) => Promise<Response>
  baseUrl: string
  timeoutMs: number
}
const defaults: VoiceDependencies = {
  subscribed: organizationHasActiveInferenceSubscription, memberKey, fetch,
  baseUrl: env.inferenceProxyBaseUrl, timeoutMs: 75_000,
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) })
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort() }
  })
}

async function readBytes(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, limit: number) {
  if (!body) throw new VoiceError("voice_invalid_request")
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await withSignal(reader.read(), signal)
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) throw new VoiceError("voice_payload_too_large")
      chunks.push(chunk.value)
    }
    return new Uint8Array(Buffer.concat(chunks, length))
  } finally { void reader.cancel().catch(() => {}) }
}
function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function registerOrgVoiceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>, dependencies: VoiceDependencies = defaults) {
  async function handle(request: Request, context: OrgRouteVariables["organizationContext"], kind: "status" | "transcriptions" | "speech") {
    const headers = { "cache-control": "no-store" }
    const deadline = new AbortController()
    const signal = AbortSignal.any([deadline.signal, request.signal])
    const timer = setTimeout(() => deadline.abort(), kind === "status" ? Math.min(dependencies.timeoutMs, 10_000) : dependencies.timeoutMs)
    try {
      if (new URL(request.url).search) throw new VoiceError("voice_invalid_request")
      if (!context) return Response.json({ error: "unauthorized" }, { status: 401, headers })
      const identity = { organizationId: context.organization.id, memberId: context.currentMember.id }
      // Unsubscribed organizations often have no key yet. Do not mistake that for an outage.
      if (!await withSignal(dependencies.subscribed(identity.organizationId), signal)) throw new VoiceError("voice_membership_required")
      const key = await withSignal(dependencies.memberKey(identity), signal)
      if (!key) throw new VoiceError("voice_unavailable")
      let body: z.infer<typeof speechSchema> | z.infer<typeof transcriptionSchema> | undefined
      if (kind !== "status") {
        try {
          if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new VoiceError("voice_invalid_request")
          const payload = json(await readBytes(request.body, signal, kind === "speech" ? 8 * 1024 : MAX_AUDIO_BYTES * 4 / 3 + 1024))
          if (kind === "speech") body = speechSchema.parse(payload)
          else {
            body = transcriptionSchema.parse(payload)
            const data = body.input_audio.data
            if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new VoiceError("voice_invalid_request")
            const bytes = Buffer.from(data, "base64")
            if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.toString("base64") !== data) throw new VoiceError("voice_invalid_request")
          }
        } catch (error) {
          if (signal.aborted || error instanceof VoiceError) throw error
          throw new VoiceError("voice_invalid_request")
        }
      }
      signal.throwIfAborted()
      const upstream = await withSignal(dependencies.fetch(`${dependencies.baseUrl.replace(/\/+$/, "")}/api/v1/${kind === "status" ? "voice" : `audio/${kind}`}`, {
        method: kind === "status" ? "GET" : "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${key}`, accept: kind === "speech" ? "audio/mpeg" : "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), signal)
      const bytes = await readBytes(upstream.body, signal, upstream.ok && kind === "speech" ? MAX_MP3_BYTES : 64 * 1024)
      signal.throwIfAborted()
      if (!upstream.ok) {
        const payload = json(bytes)
        const code = object(payload) ? (object(payload.error) ? payload.error.code : payload.error) : null
        // Provider text and headers are never relayed; only known public error codes survive.
        if (code === "voice_membership_required" && upstream.status === 403) throw new VoiceError("voice_membership_required")
        if (code === "voice_quota_exhausted" && upstream.status === 429) throw new VoiceError("voice_quota_exhausted")
        if (code === "voice_timeout" || code === "voice_request_cancelled" || code === "voice_invalid_request" || code === "voice_payload_too_large") throw new VoiceError(code)
        throw new VoiceError("voice_unavailable")
      }
      if (kind === "speech") {
        if (!bytes.length || upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "audio/mpeg") throw new VoiceError("voice_unavailable")
        return new Response(bytes, { headers: { ...headers, "content-type": "audio/mpeg" } })
      }
      const payload = json(bytes)
      if (kind === "status") {
        if (object(payload) && payload.access === "ready") return Response.json({ access: "ready" }, { headers })
        throw new VoiceError(object(payload) && payload.access === "membership_required" ? "voice_membership_required" : "voice_unavailable")
      }
      if (!object(payload) || typeof payload.text !== "string" || payload.text.length > 16000) throw new VoiceError("voice_unavailable")
      return Response.json({ text: payload.text }, { headers })
    } catch (error) {
      const code = request.signal.aborted ? "voice_request_cancelled" : deadline.signal.aborted ? "voice_timeout" : error instanceof VoiceError ? error.code : "voice_unavailable"
      const { message, status } = errors[code]
      return kind === "status"
        ? Response.json({ access: code === "voice_membership_required" ? "membership_required" : "unavailable", message }, { headers })
        : Response.json({ error: code, message }, { status, headers })
    } finally { clearTimeout(timer); deadline.abort() }
  }
  app.get("/v1/voice", describeRoute({ tags: ["Voice"], summary: "Check voice access for the current member" }), orgMemberRoute(), (c) => handle(c.req.raw, c.get("organizationContext"), "status"))
  app.post("/v1/voice/transcriptions", describeRoute({ tags: ["Voice"], summary: "Transcribe bounded audio with the member's Models access" }), orgMemberRoute(), (c) => handle(c.req.raw, c.get("organizationContext"), "transcriptions"))
  app.post("/v1/voice/speech", describeRoute({ tags: ["Voice"], summary: "Speak a short reply with the member's Models access" }), orgMemberRoute(), (c) => handle(c.req.raw, c.get("organizationContext"), "speech"))
}
