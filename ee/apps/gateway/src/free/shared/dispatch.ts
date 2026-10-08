import * as Sentry from "@sentry/node"
import { randomBytes } from "node:crypto"
import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import type { FreeAllowanceStore, FreeUsageReceipt } from "./allowance.js"
import { FREE_OPENAI_CHAT_URL, FREE_OPENAI_RESPONSES_URL, type AutoConfig } from "./config.js"
import type { FreePrincipal } from "./principal.js"
import { meterFreeResponse } from "./meter.js"
import { retryFreeSettlement } from "./settlement.js"
import { freeError } from "./errors.js"
import type { FreeProtocol } from "./request.js"
import type { RequestLogRecorder } from "../../request-log.js"

/**
 * Check the allowance, send one request to OpenAI with the dedicated free key, and charge
 * the reported cost afterwards, as paid Models does. Guests and members only differ in
 * which store (and so which tables) holds their allowance.
 */
export async function dispatchFreeCompletion(input: {
  config: AutoConfig; store: FreeAllowanceStore; fetch: typeof fetch;
  principal: FreePrincipal; prepared: { body: string; stream: boolean; choices?: number; protocol?: FreeProtocol };
  signal: AbortSignal; controller: AbortController;
  /** Members only: write-ahead Gateway usage log so Auto shows in the organization's usage. Guests are never logged. */
  startUsageLog?: (requestId: string, stream: boolean) => RequestLogRecorder;
}) {
  const { config, store, principal, prepared, signal, controller } = input
  signal.throwIfAborted()
  const requestId = randomBytes(16).toString("hex")
  const admission = await store.admit(principal)
  if (!admission.ok) return freeError(admission.code === "free_principal_rejected" ? 403 : 429, admission.code)
  const charge = (receipt: FreeUsageReceipt | null) => retryFreeSettlement(
    () => store.charge({ requestId, principal, windows: admission.windows, receipt }),
    () => Sentry.captureMessage("Free Auto charge pending database recovery", {
      level: "error", tags: { route: principal.kind === "member" ? "openwork_free" : "anonymous_free" },
      extra: { requestId, receipt, principal, windows: admission.windows },
    }),
  )
  const usageLog = input.startUsageLog?.(requestId, prepared.stream) ?? null
  // Like every Gateway route: no durable accounting record, no upstream call.
  if (usageLog && await usageLog.whenStarted?.() === false) {
    return freeError(503, "request_log_unavailable", "Inference accounting is temporarily unavailable. No allowance was consumed.")
  }
  let response: Response
  const headerTimeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)
  try {
    signal.throwIfAborted()
    response = await input.fetch(prepared.protocol === "responses" ? FREE_OPENAI_RESPONSES_URL : FREE_OPENAI_CHAT_URL, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: prepared.stream ? "text/event-stream" : "application/json" },
      body: prepared.body,
    })
  } catch {
    clearTimeout(headerTimeout)
    // The request may have reached OpenAI, so the estimate is charged.
    controller.abort()
    await charge(null)
    await usageLog?.finish({ status: null, outcome: "upstream_unreachable", errorCode: "free_inference_upstream_error" }).catch(() => undefined)
    return freeError(502, "free_inference_upstream_error", "Auto did not finish.")
  }
  clearTimeout(headerTimeout)
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (!response.ok) {
    // OpenAI does not bill a request it answers with an error.
    controller.abort()
    await response.body?.cancel().catch(() => undefined)
    await usageLog?.finish({ status: response.status, outcome: "upstream_error", errorCode: "free_inference_upstream_unavailable" }).catch(() => undefined)
    return freeError(503, "free_inference_upstream_unavailable", "Auto is temporarily unavailable. No allowance was consumed.")
  }
  if (!response.body || contentType !== (prepared.stream ? "text/event-stream" : "application/json")) {
    // A successful but unreadable response may have been billed, just like a broken stream.
    controller.abort()
    await response.body?.cancel().catch(() => undefined)
    await charge(null)
    await usageLog?.finish({ status: response.status, outcome: "upstream_error", errorCode: "free_usage_unconfirmed" }).catch(() => undefined)
    return freeError(502, "free_inference_upstream_error", "Auto did not finish.")
  }
  usageLog?.markFirstByte()
  const body = meterFreeResponse(response.body, { config, protocol: prepared.protocol, streaming: prepared.stream, choices: prepared.choices, maxBytes: config.maxResponseBytes, signal,
    settle: async (receipt) => {
      await charge(receipt)
      if (!usageLog) return
      if (receipt) usageLog.setUsage({ complete: true, usageSource: prepared.stream ? "stream" : "json", inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens,
        costUsd: receipt.amount / INFERENCE_USAGE_CONVERSION_FACTOR, upstreamRequestId: receipt.eventId })
      await usageLog.finish(receipt ? { status: 200, outcome: "ok" } : { status: 200, outcome: "upstream_error", errorCode: "free_usage_unconfirmed" })
    } })
  return new Response(body, { headers: { "content-type": contentType!, "cache-control": "no-store", "x-openwork-request-id": requestId } })
}
