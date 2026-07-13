import { createHash, createHmac, randomUUID } from "node:crypto"
import {
  EGRESS_DIAGNOSTIC_RUN_HEADER,
  EGRESS_DIAGNOSTIC_SIGNATURE_HEADER,
  EGRESS_DIAGNOSTIC_STEP_HEADER,
} from "@openwork/types/den/egress-diagnostics"
import type { DiagnosticsProfile, WireBody, WireExchange } from "./contracts"
import { diagnosticsConfig } from "./config"
import { verifyDiagnosticRunSignature } from "./run-correlation"

const visibleHeaders = new Set([
  "accept",
  "cache-control",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "origin",
  "retry-after",
  "user-agent",
  "www-authenticate",
])
const sensitiveHeaderPattern = /(authorization|cookie|token|secret|password|code|verifier|session)/i
const sensitiveBodyKeyPattern = /(authorization|cookie|token|secret|password|code|verifier|session)/i
const visibleStringKeys = new Set(["error", "grant_type", "jsonrpc", "method", "protocolVersion", "response_type", "token_type"])
const maximumPreviewCharacters = 8_000
const maximumCollectionItems = 30
const diagnosticRunPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const diagnosticStepPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function keyedSourceProof(value: string, secret: string): string {
  return `hmac-sha256:${createHmac("sha256", secret).update(value).digest("hex")}`
}

function sanitizeHeaders(headers: Headers): Readonly<Record<string, string>> {
  const safe: Record<string, string> = {}
  for (const [rawName, value] of headers.entries()) {
    const name = rawName.toLowerCase()
    if (sensitiveHeaderPattern.test(name)) {
      safe[name] = name === "mcp-session-id" ? hash(value) : "[REDACTED; PRESENT]"
    } else if (visibleHeaders.has(name)) {
      safe[name] = value.slice(0, 500)
    } else {
      safe[name] = "[VALUE REDACTED]"
    }
  }
  return safe
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeJson(value: unknown, key = "", depth = 0): unknown {
  if (sensitiveBodyKeyPattern.test(key)) return "[REDACTED]"
  if (key === "arguments") {
    if (!isRecord(value)) return "[REDACTED]"
    return Object.fromEntries(Object.keys(value).slice(0, maximumCollectionItems).map((name) => [name, "[VALUE REDACTED]"]))
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return visibleStringKeys.has(key) ? value.slice(0, 500) : "[VALUE REDACTED]"
  if (depth >= 8) return "[DEPTH REDACTED]"
  if (Array.isArray(value)) return value.slice(0, maximumCollectionItems).map((item) => safeJson(item, key, depth + 1))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, maximumCollectionItems)
        .map(([nestedKey, nestedValue]) => [nestedKey, safeJson(nestedValue, nestedKey, depth + 1)]),
    )
  }
  return "[VALUE REDACTED]"
}

function bodySummary(value: unknown): string {
  if (!isRecord(value)) return "Structured body received"
  if (typeof value.method === "string" && value.jsonrpc === "2.0") return `JSON-RPC ${value.method}`
  if (isRecord(value.error)) return "JSON error response"
  if (isRecord(value.result)) return "JSON-RPC result"
  return `JSON object (${Object.keys(value).slice(0, 12).join(", ") || "no keys"})`
}

function safeBody(raw: string, contentType: string): WireBody | null {
  if (raw.length === 0) return null
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  let preview: string | null = null
  let summary = "Body content withheld"
  if (mediaType === "application/json") {
    try {
      const parsed: unknown = JSON.parse(raw)
      summary = bodySummary(parsed)
      preview = JSON.stringify(safeJson(parsed), null, 2)
    } catch {
      summary = "Malformed JSON body"
    }
  }
  const bounded = preview && preview.length > maximumPreviewCharacters
    ? `${preview.slice(0, maximumPreviewCharacters - 3)}...`
    : preview
  return {
    bytes: Buffer.byteLength(raw, "utf8"),
    mediaType: mediaType || "unknown",
    preview: bounded,
    summary,
    truncated: preview !== null && preview.length > maximumPreviewCharacters,
  }
}

export function createWireExchange(input: {
  profile: DiagnosticsProfile
  request: Request
  requestBody: string
  response: Response
  responseBody: string
  startedAt: number
  correlationId?: string
}): WireExchange {
  const completedAt = Date.now()
  const url = new URL(input.request.url)
  const forwarded = input.request.headers.get("x-vercel-forwarded-for")
    ?? input.request.headers.get("x-forwarded-for")
    ?? input.request.headers.get("x-real-ip")
    ?? "vercel-gateway-received"
  const suppliedRunId = input.request.headers.get(EGRESS_DIAGNOSTIC_RUN_HEADER) ?? ""
  const suppliedStep = input.request.headers.get(EGRESS_DIAGNOSTIC_STEP_HEADER) ?? ""
  const suppliedSignature = input.request.headers.get(EGRESS_DIAGNOSTIC_SIGNATURE_HEADER) ?? ""
  const config = diagnosticsConfig()
  const hasValidCorrelation = diagnosticRunPattern.test(suppliedRunId)
    && diagnosticStepPattern.test(suppliedStep)
    && verifyDiagnosticRunSignature({
      runId: suppliedRunId,
      secret: config.bearerToken,
      signature: suppliedSignature,
      step: suppliedStep,
    })
  return {
    completedAt: new Date(completedAt).toISOString(),
    correlationId: input.correlationId ?? randomUUID(),
    durationMs: Math.max(0, completedAt - input.startedAt),
    id: randomUUID(),
    profile: input.profile,
    runId: hasValidCorrelation ? suppliedRunId : null,
    step: hasValidCorrelation ? suppliedStep : null,
    receivedAt: new Date(input.startedAt).toISOString(),
    request: {
      body: safeBody(input.requestBody, input.request.headers.get("content-type") ?? ""),
      headers: sanitizeHeaders(input.request.headers),
      method: input.request.method,
      path: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())].sort(),
    },
    response: {
      body: safeBody(input.responseBody, input.response.headers.get("content-type") ?? ""),
      headers: sanitizeHeaders(input.response.headers),
      status: input.response.status,
    },
    sourceProof: keyedSourceProof(forwarded, config.signingSecret),
  }
}
