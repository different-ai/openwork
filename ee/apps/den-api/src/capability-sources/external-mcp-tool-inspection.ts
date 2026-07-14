import { Buffer } from "node:buffer"
import type { ExternalMcpDiagnostic } from "./external-mcp-diagnostics.js"

const INSPECTION_BODY_LIMIT_BYTES = 512 * 1024
const REDACTED_VALUE = "[redacted]"

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

export type ExternalMcpInspectionHeader = {
  name: string
  value: string
  redacted: boolean
}

export type ExternalMcpInspectionBody = {
  text: string
  bytes: number
  truncated: boolean
  unavailable?: boolean
}

export type ExternalMcpInspectionRequest = {
  method: string
  url: string
  startedAt: string
  headers: ExternalMcpInspectionHeader[]
  body: ExternalMcpInspectionBody
}

export type ExternalMcpInspectionResponse = {
  status: number
  statusText: string
  durationMs: number
  headers: ExternalMcpInspectionHeader[]
  body: ExternalMcpInspectionBody
}

export type ExternalMcpToolCallWireInspection = {
  request?: ExternalMcpInspectionRequest
  response?: ExternalMcpInspectionResponse
}

export type ExternalMcpToolCallDiagnosis = {
  status: "succeeded" | "failed"
  layer: "openwork" | "network" | "mcp_connection" | "remote_http" | "mcp_tool"
  summary: string
}

export type ExternalMcpToolCallInspection = ExternalMcpToolCallWireInspection & {
  diagnosis: ExternalMcpToolCallDiagnosis
}

const inspectionByError = new WeakMap<object, ExternalMcpToolCallWireInspection>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function requestBodyText(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  return null
}

function isToolCallRequest(init?: RequestInit): boolean {
  const body = requestBodyText(init?.body)
  if (!body) return false
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) && parsed.method === "tools/call"
  } catch {
    return false
  }
}

function sanitizedUrl(rawUrl: string | URL): string {
  try {
    const url = new URL(String(rawUrl))
    url.username = ""
    url.password = ""
    url.hash = ""
    const parameterNames = Array.from(new Set(url.searchParams.keys()))
    for (const name of parameterNames) url.searchParams.set(name, REDACTED_VALUE)
    return url.toString()
  } catch {
    return "unavailable"
  }
}

function isSecretHeader(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized === "authorization"
    || normalized === "proxy-authorization"
    || normalized === "cookie"
    || normalized === "set-cookie"
    || normalized === "mcp-session-id"
    || normalized === "last-event-id"
    || normalized === "x-api-key"
    || normalized === "x-auth-token"
    || normalized.includes("access-token")
    || normalized.includes("refresh-token")
    || normalized.includes("client-secret")
}

function redactedHeaderValue(name: string, value: string): string {
  if (name.toLowerCase() !== "authorization") return REDACTED_VALUE
  const scheme = value.trim().split(/\s+/, 1)[0]
  return scheme ? `${scheme} ${REDACTED_VALUE}` : REDACTED_VALUE
}

function inspectionHeaders(rawHeaders?: HeadersInit): ExternalMcpInspectionHeader[] {
  if (!rawHeaders) return []
  try {
    return Array.from(new Headers(rawHeaders).entries()).map(([name, value]) => {
      const redacted = isSecretHeader(name)
      return {
        name,
        value: redacted ? redactedHeaderValue(name, value) : value,
        redacted,
      }
    })
  } catch {
    return []
  }
}

function boundedBody(text: string): ExternalMcpInspectionBody {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= INSPECTION_BODY_LIMIT_BYTES) return { text, bytes, truncated: false }
  return {
    text: Buffer.from(text, "utf8").subarray(0, INSPECTION_BODY_LIMIT_BYTES).toString("utf8"),
    bytes,
    truncated: true,
  }
}

function requestBody(init?: RequestInit): ExternalMcpInspectionBody {
  const text = requestBodyText(init?.body)
  if (text !== null) return boundedBody(text)
  return { text: "", bytes: 0, truncated: false, unavailable: init?.body !== undefined }
}

async function responseBody(response: Response): Promise<ExternalMcpInspectionBody> {
  try {
    return boundedBody(await response.clone().text())
  } catch {
    return { text: "", bytes: 0, truncated: false, unavailable: true }
  }
}

export class ExternalMcpToolCallInspector {
  private request?: ExternalMcpInspectionRequest
  private response?: ExternalMcpInspectionResponse

  observeFetch(fetchImpl: FetchLike): FetchLike {
    return async (url, init) => {
      if (!isToolCallRequest(init)) return fetchImpl(url, init)

      const startedAtMs = Date.now()
      this.request = {
        method: (init?.method ?? "POST").toUpperCase(),
        url: sanitizedUrl(url),
        startedAt: new Date(startedAtMs).toISOString(),
        headers: inspectionHeaders(init?.headers),
        body: requestBody(init),
      }

      const response = await fetchImpl(url, init)
      this.response = {
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAtMs,
        headers: inspectionHeaders(response.headers),
        body: await responseBody(response),
      }
      return response
    }
  }

  snapshot(): ExternalMcpToolCallWireInspection {
    return {
      ...(this.request ? { request: this.request } : {}),
      ...(this.response ? { response: this.response } : {}),
    }
  }
}

export function attachExternalMcpToolCallInspection(
  error: unknown,
  inspection: ExternalMcpToolCallWireInspection,
): void {
  if (typeof error === "object" && error !== null) inspectionByError.set(error, inspection)
}

export function externalMcpToolCallInspectionForError(error: unknown): ExternalMcpToolCallWireInspection {
  if (typeof error !== "object" || error === null) return {}
  return inspectionByError.get(error) ?? {}
}

export function diagnoseExternalMcpToolCall(input: {
  inspection: ExternalMcpToolCallWireInspection
  succeeded: boolean
  diagnostic?: Pick<ExternalMcpDiagnostic, "phase">
}): ExternalMcpToolCallDiagnosis {
  if (input.succeeded) {
    return {
      status: "succeeded",
      layer: "mcp_tool",
      summary: "The remote MCP received tools/call and returned a successful tool result.",
    }
  }
  if (!input.inspection.request) {
    if (input.diagnostic?.phase.startsWith("NETWORK_")) {
      return {
        status: "failed",
        layer: "network",
        summary: "OpenWork could not reach the remote MCP while preparing the session, so tools/call was not sent.",
      }
    }
    if (
      input.diagnostic?.phase.startsWith("AUTH_")
      || input.diagnostic?.phase.startsWith("CONTINUITY_")
      || input.diagnostic?.phase === "HTTP_ROUTING"
      || input.diagnostic?.phase === "MCP_TRANSPORT"
      || input.diagnostic?.phase === "MCP_VERSION"
      || input.diagnostic?.phase === "MCP_INITIALIZE"
      || input.diagnostic?.phase === "MCP_INITIALIZED"
    ) {
      return {
        status: "failed",
        layer: "mcp_connection",
        summary: "The remote MCP session, authentication, or initialization failed before tools/call could be sent.",
      }
    }
    return {
      status: "failed",
      layer: "openwork",
      summary: "The call failed inside OpenWork before an outbound tools/call request was sent.",
    }
  }
  if (!input.inspection.response) {
    return {
      status: "failed",
      layer: "network",
      summary: "OpenWork sent tools/call but did not receive an HTTP response from the remote MCP.",
    }
  }
  if (input.inspection.response.status < 200 || input.inspection.response.status >= 300) {
    return {
      status: "failed",
      layer: "remote_http",
      summary: `The remote MCP returned HTTP ${input.inspection.response.status} before the tool completed.`,
    }
  }
  return {
    status: "failed",
    layer: "mcp_tool",
    summary: input.diagnostic?.phase === "MCP_TOOL_EXECUTION" || input.diagnostic?.phase === "PROVIDER_EXECUTION"
      ? "The remote MCP answered, but the MCP tool result reported a provider or tool failure."
      : "The remote MCP answered, but OpenWork could not accept the MCP response as a successful tool result.",
  }
}
