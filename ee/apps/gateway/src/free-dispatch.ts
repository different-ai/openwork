import { randomBytes } from "node:crypto"
import type { FreeAllowanceStore } from "./free-allowance.js"
import { FREE_OPENAI_CHAT_URL, type AutoConfig } from "./free-config.js"
import type { FreePrincipal } from "./free-principal.js"
import { meterFreeResponse } from "./free-response.js"

export function freeError(status: number, code: string, message = "Auto is unavailable. No request was sent.") {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } })
}

// OpenAI does not bill a request it refuses before generating.
const NOT_BILLED = new Set([401, 403, 429])

/**
 * Reserve the allowance, send one request to OpenAI with the dedicated free key,
 * and settle from the reported token usage. Guests and members only differ in
 * which store (and so which tables) holds their allowance.
 */
export async function dispatchFreeCompletion(input: {
  config: AutoConfig; store: FreeAllowanceStore; fetch: typeof fetch;
  principal: FreePrincipal; ipHash: string | null; prepared: { body: string; stream: boolean };
  signal: AbortSignal; controller: AbortController; deadlineAt: number;
}) {
  const { config, store, principal, prepared, signal, controller } = input
  signal.throwIfAborted()
  const requestId = randomBytes(16).toString("hex")
  const admission = await store.reserve(principal, input.ipHash, requestId, input.deadlineAt)
  if (!admission.ok) return freeError(admission.code === "free_request_in_progress" ? 423 : 429, admission.code)
  let dispatched = false
  try {
    signal.throwIfAborted()
    if (!await store.dispatch(requestId, principal, admission.deadlineAt)) return freeError(403, "free_principal_rejected")
    dispatched = true
    signal.throwIfAborted()
    const response = await input.fetch(FREE_OPENAI_CHAT_URL, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: prepared.stream ? "text/event-stream" : "application/json" },
      body: prepared.body,
    })
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    if (!response.ok || !response.body || contentType !== (prepared.stream ? "text/event-stream" : "application/json")) {
      controller.abort()
      await response.body?.cancel().catch(() => undefined)
      if (NOT_BILLED.has(response.status)) {
        await store.release(requestId)
        return freeError(503, "free_inference_upstream_unavailable", "Auto is temporarily unavailable. No allowance was consumed.")
      }
      await store.settle(requestId, null)
      return freeError(502, "free_inference_upstream_error", "Auto did not finish. Unconfirmed usage is retained conservatively.")
    }
    const body = meterFreeResponse(response.body, { config, streaming: prepared.stream, maxBytes: config.maxResponseBytes, signal,
      settle: async (receipt) => { await store.settle(requestId, receipt) } })
    return new Response(body, { headers: { "content-type": contentType, "cache-control": "no-store", "x-openwork-request-id": requestId } })
  } catch {
    controller.abort()
    const cancelled = !dispatched && await store.cancelUndispatched(requestId).catch(() => false)
    if (!cancelled) await store.settle(requestId, null).catch(() => undefined)
    return freeError(502, "free_inference_upstream_error", cancelled
      ? "Auto was not dispatched. No allowance was consumed." : "Auto did not finish. Unconfirmed usage is retained conservatively.")
  }
}
