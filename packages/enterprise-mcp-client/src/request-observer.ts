import { z } from "zod"
import type {
  EnterpriseMcpDiagnosticSink,
  EnterpriseMcpClock,
  EnterpriseMcpFetch,
  EnterpriseMcpOperationPhase,
  EnterpriseMcpRequestPhase,
} from "./contracts.js"

const jsonRpcRequestSchema = z.object({
  method: z.string(),
}).passthrough()

function requestBodyText(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  return null
}

function bodyRequestPhase(body: BodyInit | null | undefined): EnterpriseMcpRequestPhase | null {
  const text = requestBodyText(body)
  if (!text) return null

  const form = new URLSearchParams(text)
  const grantType = form.get("grant_type")
  if (grantType === "authorization_code") return "oauth-token-exchange"
  if (grantType === "refresh_token") return "oauth-token-refresh"

  try {
    const parsed: unknown = JSON.parse(text)
    const request = jsonRpcRequestSchema.safeParse(parsed)
    if (!request.success) {
      if (typeof parsed === "object" && parsed !== null && "redirect_uris" in parsed) {
        return "oauth-client-registration"
      }
      return null
    }
    if (request.data.method === "initialize") return "mcp-initialize"
    if (request.data.method === "tools/list") return "mcp-tool-discovery"
    if (request.data.method === "tools/call") return "mcp-tool-execution"
  } catch {
    return null
  }

  return null
}

export function classifyEnterpriseMcpRequest(url: URL, init?: RequestInit): EnterpriseMcpRequestPhase {
  const bodyPhase = bodyRequestPhase(init?.body)
  if (bodyPhase) return bodyPhase

  if (url.pathname.includes("/.well-known/oauth-protected-resource")) {
    return "oauth-resource-discovery"
  }
  if (url.pathname.includes("/.well-known/oauth-authorization-server") || url.pathname.includes("/.well-known/openid-configuration")) {
    return "oauth-server-discovery"
  }
  if (init?.method === "POST" && url.pathname.includes("register")) {
    return "oauth-client-registration"
  }
  return "endpoint-request"
}

export type EnterpriseMcpRequestObserver = {
  fetch: EnterpriseMcpFetch
  lastRequestPhase(): EnterpriseMcpRequestPhase | null
  lastFailedRequestPhase(): EnterpriseMcpRequestPhase | null
}

export function createEnterpriseMcpRequestObserver(input: {
  connectionId: string
  operationPhase: EnterpriseMcpOperationPhase
  fetch: EnterpriseMcpFetch
  diagnosticSink?: EnterpriseMcpDiagnosticSink
  signal: AbortSignal
  clock: EnterpriseMcpClock
}): EnterpriseMcpRequestObserver {
  let lastRequestPhase: EnterpriseMcpRequestPhase | null = null
  let lastFailedRequestPhase: EnterpriseMcpRequestPhase | null = null

  return {
    lastRequestPhase: () => lastRequestPhase,
    lastFailedRequestPhase: () => lastFailedRequestPhase,
    fetch: async (rawUrl, init) => {
      const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl)
      const requestPhase = classifyEnterpriseMcpRequest(url, init)
      lastRequestPhase = requestPhase
      const startedAt = input.clock.now()
      input.diagnosticSink?.({
        kind: "request",
        connectionId: input.connectionId,
        operationPhase: input.operationPhase,
        requestPhase,
        outcome: "started",
      })

      try {
        const signal = init?.signal
          ? AbortSignal.any([init.signal, input.signal])
          : input.signal
        const response = await input.fetch(rawUrl, { ...init, signal })
        if (!response.ok) lastFailedRequestPhase = requestPhase
        input.diagnosticSink?.({
          kind: "request",
          connectionId: input.connectionId,
          operationPhase: input.operationPhase,
          requestPhase,
          outcome: response.ok ? "succeeded" : "failed",
          durationMs: input.clock.now() - startedAt,
          httpStatus: response.status,
        })
        return response
      } catch (error) {
        lastFailedRequestPhase = requestPhase
        input.diagnosticSink?.({
          kind: "request",
          connectionId: input.connectionId,
          operationPhase: input.operationPhase,
          requestPhase,
          outcome: "failed",
          durationMs: input.clock.now() - startedAt,
        })
        throw error
      }
    },
  }
}
