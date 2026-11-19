import * as Sentry from "@sentry/node"
import { randomBytes } from "node:crypto"
import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import type { FreeAllowanceStore, FreeUsageReceipt } from "./allowance.js"
import { FREE_OPENAI_CHAT_URL, FREE_OPENAI_RESPONSES_URL, type AutoConfig } from "./config.js"
import type { FreePrincipal } from "./principal.js"
import { meterFreeResponse, upstreamErrorDetails, type UpstreamErrorDetails } from "./meter.js"
import { retryFreeSettlement } from "./settlement.js"
import { freeError } from "./errors.js"
import type { FreeProtocol } from "./request.js"
import { REQUEST_LOG_UNAVAILABLE_MESSAGE, type RequestLogRecorder } from "../../request-log.js"
import { gatewayLog } from "../../log.js"

const log = gatewayLog.child({ component: "free-auto" })
const UPSTREAM_ERROR_BODY_BYTES = 16 * 1024
const UPSTREAM_ERROR_BODY_TIMEOUT_MS = 2_000

/** Reads a bounded slice of OpenAI's error body for its type and code, then aborts the request. */
async function readUpstreamError(response: Response, controller: AbortController): Promise<UpstreamErrorDetails> {
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_ERROR_BODY_TIMEOUT_MS)
  const reader = response.body?.getReader()
  try {
    if (!reader) return {}
    const decoder = new TextDecoder()
    let text = ""
    while (text.length < UPSTREAM_ERROR_BODY_BYTES) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    return upstreamErrorDetails(JSON.parse(text))
  } catch {
    return {}
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await reader?.cancel().catch(() => undefined)
  }
}
function errorCode(error: unknown) {
  const cause = error instanceof Error && typeof error.cause === "object" && error.cause !== null ? error.cause : undefined
  const code = cause && "code" in cause ? cause.code : undefined
  return typeof code === "string" && /^[\w.-]{1,64}$/.test(code) ? code : undefined
}

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
  if (!admission.ok) {
    const response = freeError(admission.code === "free_principal_rejected" ? 403 : 429, admission.code)
    // Keep desktop error bodies compatible. These headers distinguish a signed-in
    // person's exhausted allowance from temporary capacity and guest limits.
    if (principal.kind === "member" && admission.code === "anonymous_limit_exceeded") {
      response.headers.set("X-OpenWork-Error-Code", "free_allowance_exhausted")
      response.headers.set("X-OpenWork-Usage-State", "blocked")
    }
    return response
  }
  const charge = (receipt: FreeUsageReceipt | null) => retryFreeSettlement(
    () => store.charge({ requestId, principal, windows: admission.windows, receipt }),
    () => Sentry.captureMessage("Free Auto charge pending database recovery", {
      level: "error", tags: { route: principal.kind === "member" ? "openwork_free" : "anonymous_free" },
      extra: { requestId, receipt, principal, windows: admission.windows },
    }),
  )
  const usageLog = input.startUsageLog?.(requestId, prepared.stream) ?? null
  const startedAt = Date.now()
  // One line per failure, with what is needed to find it at OpenAI. Never the prompt, output, keys, or OpenAI's message text.
  const logFailure = (level: "info" | "error", message: string, fields: Record<string, string | number | undefined>) => log[level](message, {
    request_id: requestId, route: principal.kind === "member" ? "openwork_free" : "anonymous_free",
    organization_id: principal.kind === "member" ? principal.organizationId : undefined,
    model: config.upstreamModel, protocol: prepared.protocol ?? "chat", stream: prepared.stream,
    duration_ms: Date.now() - startedAt, ...fields,
  })
  const upstreamFields = (details: UpstreamErrorDetails) => ({
    upstream_error_type: details.type, upstream_error_code: details.code,
  })
  // Like every Gateway route: no durable accounting record, no upstream call.
  if (usageLog && await usageLog.whenStarted?.() === false) {
    return freeError(503, "request_log_unavailable", `${REQUEST_LOG_UNAVAILABLE_MESSAGE} No allowance was consumed.`)
  }
  let response: Response
  let headerTimedOut = false
  const headerTimeout = setTimeout(() => { headerTimedOut = true; controller.abort() }, config.requestTimeoutMs)
  try {
    signal.throwIfAborted()
    response = await input.fetch(prepared.protocol === "responses" ? FREE_OPENAI_RESPONSES_URL : FREE_OPENAI_CHAT_URL, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: prepared.stream ? "text/event-stream" : "application/json" },
      body: prepared.body,
    })
  } catch (error) {
    clearTimeout(headerTimeout)
    const reason = headerTimedOut ? "upstream_timeout" : signal.aborted ? "client_cancelled" : "upstream_unreachable"
    logFailure(reason === "client_cancelled" ? "info" : "error", "free Auto request did not reach OpenAI", {
      reason, error_name: error instanceof Error ? error.name : undefined, error_code: errorCode(error),
    })
    // The request may have reached OpenAI, so the estimate is charged.
    controller.abort()
    await charge(null)
    await usageLog?.finish({ status: null, outcome: "upstream_unreachable", errorCode: "free_inference_upstream_error" }).catch(() => undefined)
    return freeError(502, "free_inference_upstream_error", "Auto did not finish.")
  }
  clearTimeout(headerTimeout)
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const upstreamRequestId = response.headers.get("x-request-id")?.slice(0, 128)
  if (!response.ok) {
    // OpenAI does not bill a request it answers with an error.
    const details = await readUpstreamError(response, controller)
    logFailure("error", "free Auto upstream request failed", {
      reason: "upstream_status", http_status_code: response.status, upstream_request_id: upstreamRequestId, ...upstreamFields(details),
    })
    await usageLog?.finish({ status: response.status, outcome: "upstream_error", errorCode: "free_inference_upstream_unavailable" }).catch(() => undefined)
    return freeError(503, "free_inference_upstream_unavailable", "Auto is temporarily unavailable. No allowance was consumed.")
  }
  if (!response.body || contentType !== (prepared.stream ? "text/event-stream" : "application/json")) {
    // A successful but unreadable response may have been billed, just like a broken stream.
    logFailure("error", "free Auto upstream response was unreadable", {
      reason: "invalid_response", http_status_code: response.status, upstream_request_id: upstreamRequestId, content_type: contentType?.slice(0, 80),
    })
    controller.abort()
    await response.body?.cancel().catch(() => undefined)
    await charge(null)
    await usageLog?.finish({ status: response.status, outcome: "upstream_error", errorCode: "free_usage_unconfirmed" }).catch(() => undefined)
    return freeError(502, "free_inference_upstream_error", "Auto did not finish.")
  }
  usageLog?.markFirstByte()
  const body = meterFreeResponse(response.body, { config, protocol: prepared.protocol, streaming: prepared.stream, choices: prepared.choices, maxBytes: config.maxResponseBytes, signal,
    onFailure: (failure) => logFailure(failure.reason === "client_cancelled" ? "info" : "error",
      failure.reason === "client_cancelled" ? "free Auto response cancelled" : "free Auto response failed", {
        reason: failure.reason, http_status_code: response.status, upstream_request_id: upstreamRequestId, ...upstreamFields(failure.upstream),
      }),
    settle: async (receipt) => {
      await charge(receipt)
      if (!usageLog) return
      if (receipt) usageLog.setUsage({ complete: true, usageSource: prepared.stream ? "stream" : "json", inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens,
        costUsd: receipt.amount / INFERENCE_USAGE_CONVERSION_FACTOR, upstreamRequestId: receipt.eventId })
      await usageLog.finish(receipt ? { status: 200, outcome: "ok" } : { status: 200, outcome: "upstream_error", errorCode: "free_usage_unconfirmed" })
    } })
  return new Response(body, { headers: { "content-type": contentType!, "cache-control": "no-store", "x-openwork-request-id": requestId } })
}
