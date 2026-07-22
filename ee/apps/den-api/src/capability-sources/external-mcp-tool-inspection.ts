import { Buffer } from "node:buffer"
import type { ExternalMcpDiagnostic } from "./external-mcp-diagnostics.js"

const INSPECTION_BODY_LIMIT_BYTES = 512 * 1024
// How long snapshotting waits for a response body that the remote has not
// finished sending. A stream the server holds open must not delay returning
// the inspection after the tool call itself has settled.
const INSPECTION_BODY_SETTLE_TIMEOUT_MS = 1_000
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
    || normalized === "dpop"
    || normalized === "last-event-id"
    || normalized.endsWith("-key")
    || normalized.includes("api-key")
    || normalized.includes("apikey")
    || normalized.includes("access-key")
    || normalized.includes("private-key")
    || normalized.includes("credential")
    || normalized.includes("password")
    || normalized.includes("session")
    || normalized.includes("signature")
    || normalized.includes("token")
    || normalized.includes("secret")
}

function redactedHeaderValue(name: string, value: string): string {
  if (name.toLowerCase() !== "authorization") return REDACTED_VALUE
  const match = /^([A-Za-z][A-Za-z0-9+.-]*)\s+.+$/.exec(value.trim())
  return match ? `${match[1]} ${REDACTED_VALUE}` : REDACTED_VALUE
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

type ResponseBodyCapture = {
  settle: () => Promise<ExternalMcpInspectionBody>
}

const UNAVAILABLE_BODY: ExternalMcpInspectionBody = { text: "", bytes: 0, truncated: false, unavailable: true }

/**
 * Captures a bounded copy of the response body without consuming or delaying
 * the stream the MCP transport reads. The capture must never change the
 * behavior it observes: the transport receives the response immediately, the
 * copy stops pulling at the inspection cap, and settle() abandons a stream
 * the remote is still holding open instead of waiting for it to end.
 */
function captureBoundedResponseBody(response: Response): ResponseBodyCapture {
  let stream: ReadableStream<Uint8Array> | null
  try {
    stream = response.clone().body
  } catch {
    return { settle: async () => UNAVAILABLE_BODY }
  }
  if (!stream) return { settle: async () => ({ text: "", bytes: 0, truncated: false }) }

  const reader = stream.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let text = ""
  let observedBytes = 0
  let capturedBytes = 0
  let ended = false
  let errored = false

  const reading = (async () => {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) {
          ended = true
          return
        }
        observedBytes += next.value.byteLength
        const remaining = INSPECTION_BODY_LIMIT_BYTES - capturedBytes
        const slice = next.value.byteLength > remaining ? next.value.subarray(0, Math.max(0, remaining)) : next.value
        text += decoder.decode(slice, { stream: true })
        capturedBytes += slice.byteLength
        if (observedBytes > capturedBytes) {
          ended = true
          // Do not await: a cloned branch's cancel promise resolves only when
          // the transport's branch is also done with the stream.
          reader.cancel().catch(() => undefined)
          return
        }
      }
    } catch {
      errored = true
    }
  })()

  let settled: Promise<ExternalMcpInspectionBody> | null = null
  return {
    settle: () => {
      settled ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          reading,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, INSPECTION_BODY_SETTLE_TIMEOUT_MS)
          }),
        ])
        if (timer !== undefined) clearTimeout(timer)
        if (!ended && !errored) reader.cancel().catch(() => undefined)
        if (errored && capturedBytes === 0) return UNAVAILABLE_BODY
        return {
          text: text + decoder.decode(),
          bytes: observedBytes,
          // The capture is incomplete when bytes exceeded the cap or the
          // cloned stream never reached EOF before settle stopped waiting.
          truncated: observedBytes > capturedBytes || !ended,
        }
      })()
      return settled
    },
  }
}

export class ExternalMcpToolCallInspector {
  private request?: ExternalMcpInspectionRequest
  private response?: ExternalMcpInspectionResponse
  private responseBodyCapture?: { capture: ResponseBodyCapture; target: ExternalMcpInspectionResponse }

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
      // A retried tools/call must not pair its request with the previous
      // attempt's response, so the failing attempt is the one displayed.
      this.response = undefined
      this.responseBodyCapture = undefined

      const response = await fetchImpl(url, init)
      const captured: ExternalMcpInspectionResponse = {
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAtMs,
        headers: inspectionHeaders(response.headers),
        body: UNAVAILABLE_BODY,
      }
      this.response = captured
      this.responseBodyCapture = { capture: captureBoundedResponseBody(response), target: captured }
      return response
    }
  }

  /** Finalize the bounded response-body copy. Call after the tool call settles, before snapshot(). */
  async settle(): Promise<void> {
    if (!this.responseBodyCapture) return
    try {
      this.responseBodyCapture.target.body = await this.responseBodyCapture.capture.settle()
    } catch {
      // Inspection is diagnostic-only and must never change the tool call's
      // success or preserve a provider failure as a different local error.
      this.responseBodyCapture.target.body = UNAVAILABLE_BODY
    }
  }

  snapshot(): ExternalMcpToolCallWireInspection {
    return {
      ...(this.request ? { request: this.request } : {}),
      ...(this.response ? { response: this.response } : {}),
    }
  }
}

/**
 * Shared inspect wrapper for the current and enterprise client entry points:
 * run the tool call with a fresh inspector, settle the bounded body capture,
 * and either return or attach the wire snapshot alongside the outcome.
 */
export async function withExternalMcpToolCallInspection<T>(
  run: (inspector: ExternalMcpToolCallInspector) => Promise<T>,
): Promise<{ result: T; inspection: ExternalMcpToolCallWireInspection }> {
  const inspector = new ExternalMcpToolCallInspector()
  try {
    const result = await run(inspector)
    await inspector.settle()
    return { result, inspection: inspector.snapshot() }
  } catch (error) {
    await inspector.settle()
    attachExternalMcpToolCallInspection(error, inspector.snapshot())
    throw error
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
  diagnostic?: Pick<ExternalMcpDiagnostic, "phase"> & Partial<Pick<ExternalMcpDiagnostic, "category" | "code">>
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
    // The inspector records the request before the SSRF guard and lifecycle
    // deadline run, so "request captured, no response" does not always mean
    // the request reached the network.
    if (
      input.diagnostic?.category === "security_blocked"
      || input.diagnostic?.code === "MCP_URL_BLOCKED"
      || input.diagnostic?.code === "MCP_FETCH_FORBIDDEN_PORT"
    ) {
      return {
        status: "failed",
        layer: "openwork",
        summary: "OpenWork's outbound network safety policy blocked this tools/call request, so it was not sent to the remote MCP.",
      }
    }
    if (input.diagnostic?.code === "MCP_PROVIDER_AUTH_REQUIRED") {
      return {
        status: "failed",
        layer: "mcp_tool",
        summary: "The remote MCP responded and requires user authorization for the downstream provider.",
      }
    }
    if (input.diagnostic?.code === "MCP_LIFECYCLE_DEADLINE" || input.diagnostic?.code === "MCP_REQUEST_TIMEOUT") {
      return {
        status: "failed",
        layer: "network",
        summary: "OpenWork sent the request, but the remote MCP did not respond before OpenWork’s deadline.",
      }
    }
    return {
      status: "failed",
      layer: "network",
      summary: "OpenWork started tools/call but did not capture an HTTP response. This does not prove the remote MCP caused the failure.",
    }
  }
  if (input.inspection.response.status < 200 || input.inspection.response.status >= 300) {
    return {
      status: "failed",
      layer: "remote_http",
      summary: `The remote MCP returned HTTP ${input.inspection.response.status}.`,
    }
  }
  return {
    status: "failed",
    layer: "mcp_tool",
    summary: input.diagnostic?.code === "MCP_PROVIDER_AUTH_REQUIRED"
      ? "The remote MCP responded and requires user authorization for the downstream provider."
      : input.diagnostic?.phase === "PROVIDER_AUTHORIZATION" || input.diagnostic?.phase === "PROVIDER_EXECUTION"
      ? "The remote MCP responded, but the downstream provider rejected the operation."
      : input.diagnostic?.phase === "MCP_TOOL_EXECUTION"
        ? "The remote MCP responded, but the MCP tool returned an error."
      : "The remote MCP answered, but OpenWork could not accept the MCP response as a successful tool result.",
  }
}
