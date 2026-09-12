import * as Sentry from "@sentry/node"
import { createMiddleware } from "hono/factory"
import { shouldEmitSentryLog } from "./instrumentation.js"
import type { ChatCompletionReport } from "./chat-response.js"
import type { GenerationTerminal } from "./generation-outcome.js"
import type { GatewayRequestOutcome, GatewayRequestProtocol, GatewayRequestRoute } from "@openwork/types/den/gateway"

export type InferenceTerminalReceipt = GenerationTerminal & {
  openworkRequestId: string
  upstreamRequestId: string | null
  upstreamResponseId: string | null
  firstOutputMs: number | null
  organizationId: string
  orgMembershipId: string
  route: GatewayRequestRoute
  protocol: GatewayRequestProtocol
  upstreamProviderId: string
  modelAlias: string | null
  status: number | null
  transportOutcome: GatewayRequestOutcome
  startedAt: string
  completedAt: string
  durationMs: number
  responseBytes: number | null
  inputTokens: number | null
  outputTokens: number | null
}

export type PayloadLogMode = "summary"

export type InferenceRequestReport = {
  organizationId: string
  orgMembershipId: string
  inferenceKeyId: string
  gatewayKeyId?: never
  openworkRequestId: string
  route: string
  method: string
  incomingModel: string | null
  resolvedUpstreamModel: string | null
  headers: Record<string, string>
  payloadMode: PayloadLogMode
  payload: unknown
}

export type InferenceHandledErrorReport = {
  reason: string
  organizationId?: string
  orgMembershipId?: string
  inferenceKeyId?: string
  gatewayKeyId?: string
  openworkRequestId?: string
  route: string
  method: string
  incomingModel?: string | null
  resolvedUpstreamModel?: string | null
  headers?: Record<string, string>
  status?: number
  statusText?: string
  upstreamUrl?: string
  error?: string
  exception?: unknown
}

export type InferenceReporter = {
  terminal?(report: InferenceTerminalReceipt): void
  request(report: InferenceRequestReport): void
  handledError(report: InferenceHandledErrorReport): void
  completion?(report: ChatCompletionReport & { openworkRequestId: string; organizationId: string; orgMembershipId: string; modelAlias: string }): void
}

export function sanitizeIncomingHeaders(headers: Headers) {
  return Object.fromEntries([...headers.keys()].map((name) => [name, "[REDACTED]"]))
}

export function safeAccessUrl(input: string) {
  try { const url = new URL(input); return `${url.origin}${url.pathname}` } catch { return "[invalid-url]" }
}

export const inferenceAccessLogger = createMiddleware(async (c, next) => {
  const startedAt = Date.now()
  const route = ["/api/v1/models", "/api/v1/chat/completions", "/webhooks/openrouter"].includes(c.req.path) ? c.req.path : "other"
  try { await next() } finally {
    console.log("[gateway-http]", { method: c.req.method, route, status: c.res.status, durationMs: Date.now() - startedAt })
  }
})

export function safeInferenceReporter(reporter: InferenceReporter): InferenceReporter {
  return {
    terminal(report) {
      try { reporter.terminal?.(report) } catch {}
    },
    completion(report) {
      try { reporter.completion?.(report) } catch { /* Optional reporting. */ }
    },
    request(report) {
      try { reporter.request(report) } catch { /* Optional reporting cannot break inference. */ }
    },
    handledError(report) {
      const { error, exception, statusText, ...safe } = report
      try { reporter.handledError({ ...safe, upstreamUrl: safe.upstreamUrl ? safeAccessUrl(safe.upstreamUrl) : undefined }) } catch { /* Optional reporting. */ }
    },
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function buildInferencePayloadLog(_organizationId: string, payload: unknown): { mode: PayloadLogMode; payload: unknown } {
  // Counts only, for every organization. Field names, roles, tool names and
  // other caller-provided strings can themselves contain prompt content.
  return { mode: "summary", payload: {
    bodyType: payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload,
    messageCount: isJsonObject(payload) && Array.isArray(payload.messages) ? payload.messages.length : 0,
    toolCount: isJsonObject(payload) && Array.isArray(payload.tools) ? payload.tools.length : 0,
    stream: isJsonObject(payload) && payload.stream === true,
  } }
}

export function buildUnparsedPayloadLog(reason: string, contentType: string | null): { mode: PayloadLogMode; payload: unknown } {
  return { mode: "summary", payload: { bodyType: "unparsed", reason, hasContentType: contentType !== null } }
}

function reportAttributes(report: InferenceRequestReport | InferenceHandledErrorReport) {
  return {
    organizationId: report.organizationId,
    orgMembershipId: report.orgMembershipId,
    inferenceKeyId: report.inferenceKeyId,
    gatewayKeyId: report.gatewayKeyId,
    openworkRequestId: report.openworkRequestId,
    route: report.route,
    method: report.method,
    incomingModel: report.incomingModel,
    resolvedUpstreamModel: report.resolvedUpstreamModel,
    headers: report.headers,
  }
}

export const sentryInferenceReporter: InferenceReporter = {
  terminal(report) {
    try {
      Sentry.metrics.count("gateway.generation.terminal", 1, { attributes: {
        route: report.route, protocol: report.protocol,
        transportOutcome: report.transportOutcome, generationOutcome: report.generationOutcome,
      } })
    } catch {}
    const level = report.generationOutcome === "content_filtered" || report.generationOutcome === "refused" ? "warn" : report.transportOutcome === "ok" ? "info" : "error"
    if (shouldEmitSentryLog(level)) {
      const options = Sentry.getClient()?.getOptions()
      Sentry.logger[level]("OpenWork inference terminal", { ...report, release: options?.release ?? "unknown", environment: options?.environment ?? "unknown" })
    }
  },
  completion(report) {
    if (shouldEmitSentryLog(report.outcome === "completed" ? "info" : "error")) {
      if (report.outcome === "completed") Sentry.logger.info("OpenWork inference completion", report)
      else Sentry.logger.error("OpenWork inference completion", report)
    }
  },
  request(report) {
    if (!shouldEmitSentryLog("info")) return
    Sentry.logger.info("OpenWork Gateway chat completions request", {
      ...reportAttributes(report), payloadMode: report.payloadMode, payload: report.payload,
    })
  },
  handledError(report) {
    const attributes = {
      ...reportAttributes(report), reason: report.reason, status: report.status,
      upstreamUrl: report.upstreamUrl ? safeAccessUrl(report.upstreamUrl) : undefined,
    }
    if (shouldEmitSentryLog("error")) Sentry.logger.error("OpenWork Gateway handled error", attributes)
    // Exceptions often contain request/SQL parameters. Never send them to Sentry.
    Sentry.captureMessage(`OpenWork Gateway handled error: ${report.reason}`, {
      level: "error",
      tags: { organization_id: report.organizationId, inference_key_id: report.inferenceKeyId, openwork_request_id: report.openworkRequestId, route: report.route, method: report.method },
      contexts: { inference: attributes },
    })
  },
}
