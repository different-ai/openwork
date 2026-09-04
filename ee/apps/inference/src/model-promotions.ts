import { createPromotionStore, preparePromotionRequest, promotionUsageCost, PromotionError } from "@openwork-ee/model-promotions"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { eq } from "@openwork-ee/den-db/drizzle"
import { z } from "zod"
import { db } from "./db.js"
import { env } from "./env.js"
import type { findActiveInferenceKey } from "./keys.js"
import { resolveModelAlias } from "./model-catalog.js"

type Key = NonNullable<Awaited<ReturnType<typeof findActiveInferenceKey>>>
const promotions = createPromotionStore(db)
async function identity(key: Key) {
  const [member] = await db.select().from(MemberTable).where(eq(MemberTable.id, key.org_membership_id))
  if (!member?.userId || member.removedAt || member.organizationId !== key.organization_id) throw new PromotionError("membership_required", "Your workspace membership is no longer active.", 403)
  return { userId: member.userId, memberId: key.org_membership_id, organizationId: key.organization_id }
}
export async function listPromotionModels(key: Key) { return promotions.executableModels(await identity(key)) }

const completionSchema = z.object({ id: z.string().max(255).optional(), usage: z.unknown().optional() })
export async function proxyPromotion(request: Request, key: Key, requestId: string): Promise<Response | null> {
  // Clone preserves the ordinary managed-model path and its existing validation.
  const json: unknown = await request.clone().json().catch(() => null)
  const requested = z.object({ model: z.string() }).safeParse(json)
  if (!requested.success || resolveModelAlias(requested.data.model)) return null
  if (!await promotions.isPromotionAlias(requested.data.model)) return null
  try {
    const reserved = await promotions.reserveRequest(requested.data.model, await identity(key), requestId, (terms) => preparePromotionRequest(json, terms, requestId))
    let upstream: Response
    try {
      upstream = await fetch(`${env.openRouterUpstreamUrl}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${reserved.apiKey}`, "content-type": "application/json", "x-title": "OpenWork Models" },
        body: reserved.body, signal: AbortSignal.timeout(180000),
      })
    } catch {
      // Dispatch may have reached the provider. Never refund an unknown charge.
      return Response.json({ error: { code: "promotion_usage_pending", message: "The provider response was interrupted. Reserved credit will remain held until usage is confirmed." } }, { status: 502 })
    }
    const headers = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-openwork-request-id": requestId })
    if (!upstream.ok) {
      // Even a failed HTTP response can follow upstream work; only provider
      // accounting or explicit operator reconciliation releases this reservation.
      return Response.json({ error: { code: "promotion_provider_error", message: "The promotional model could not complete this request. Try again shortly or choose another model. Credit awaiting confirmation remains reserved." } }, { status: upstream.status >= 500 ? 502 : 429, headers })
    }
    let generationId: string | undefined
    async function observe(value: unknown) {
      const completion = completionSchema.safeParse(value)
      if (!completion.success) return
      if (completion.data.id && !generationId) {
        generationId = completion.data.id
        await promotions.noteGeneration(requestId, generationId)
      }
      const cost = promotionUsageCost(completion.data.usage)
      if (cost !== null) await promotions.settle(requestId, cost, completion.data.id)
    }
    if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
      const text = await upstream.text()
      try { await observe(JSON.parse(text)) } catch { /* Keep the reservation on ambiguous provider accounting. */ }
      return new Response(text, { status: upstream.status, headers })
    }
    if (!upstream.body) return new Response(null, { status: 502, headers })
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) { controller.close(); return }
          pending += decoder.decode(chunk.value, { stream: true })
          const lines = pending.split("\n")
          pending = lines.pop() ?? ""
          if (pending.length > 1_000_000) throw new Error("provider_frame_too_large")
          for (const line of lines) {
            if (!line.startsWith("data:")) continue
            const data = line.slice(5).trim()
            if (data === "[DONE]") continue
            try { await observe(JSON.parse(data)) } catch { /* Keep unconfirmed reservations for reconciliation. */ }
          }
          controller.enqueue(chunk.value)
        } catch (error) { await reader.cancel().catch(() => {}); controller.error(error) }
      },
      async cancel(reason) { await reader.cancel(reason) },
    })
    return new Response(stream, { status: upstream.status, headers })
  } catch (error) {
    if (error instanceof PromotionError) return Response.json({ error: { type: "invalid_request_error", code: error.code, message: error.message } }, { status: error.status })
    throw error
  }
}
