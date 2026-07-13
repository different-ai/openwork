import { timingSafeEqual } from "node:crypto"
import { diagnosticsConfig, validateProductionConfig } from "./config"
import { createSessionToken, verifySessionToken } from "./session"

const supportedVersions = ["2025-11-25", "2025-06-18", "2025-03-26"] as const
export const maximumRequestBytes = 64 * 1024

type HandledResponse = { body: string; response: Response }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function json(status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): HandledResponse {
  const body = JSON.stringify(value)
  return {
    body,
    response: new Response(body, {
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers },
      status,
    }),
  }
}

function empty(status: number, headers: Readonly<Record<string, string>> = {}): HandledResponse {
  return { body: "", response: new Response(null, { headers: { "cache-control": "no-store", ...headers }, status }) }
}

function rpcResult(id: string | number, result: unknown): unknown {
  return { id, jsonrpc: "2.0", result }
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): unknown {
  return { error: { code, message, ...(data === undefined ? {} : { data }) }, id, jsonrpc: "2.0" }
}

function authorized(request: Request, expectedToken: string): boolean {
  if (!expectedToken) return true
  const authorization = request.headers.get("authorization") ?? ""
  const prefix = "Bearer "
  if (!authorization.startsWith(prefix)) return false
  const supplied = Buffer.from(authorization.slice(prefix.length))
  const expected = Buffer.from(expectedToken)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function acceptsMcp(request: Request): boolean {
  const accept = request.headers.get("accept")?.toLowerCase() ?? ""
  return accept.includes("application/json") && accept.includes("text/event-stream")
}

function requestId(value: Record<string, unknown>): string | number | null {
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : null
}

function negotiatedVersion(message: Record<string, unknown>): string {
  const params = isRecord(message.params) ? message.params : {}
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : ""
  return supportedVersions.some((version) => version === requested) ? requested : supportedVersions[0]
}

function toolDefinition(profile: ReturnType<typeof diagnosticsConfig>["profile"]): Record<string, unknown> {
  const name = profile === "servicenow"
    ? "lookup_incidents"
    : profile === "microsoft"
      ? "search_microsoft_365"
      : "diagnostics_check"
  return {
    description: "Returns a synthetic, content-free result proving that the client completed MCP initialization and tool discovery.",
    inputSchema: {
      additionalProperties: false,
      properties: { query: { description: "Synthetic test label. Its value is never retained in wire history.", type: "string" } },
      type: "object",
    },
    name,
    title: "Diagnostics connectivity check",
  }
}

function validateSession(request: Request, signingSecret: string): boolean {
  const token = request.headers.get("mcp-session-id") ?? ""
  return Boolean(token) && verifySessionToken(token, signingSecret)
}

export async function handleMcpRequest(request: Request, rawBody: string): Promise<HandledResponse> {
  const config = diagnosticsConfig()
  const missing = validateProductionConfig()
  if (missing.length > 0) return json(503, { error: "diagnostics_not_configured", missing })

  if (request.method === "DELETE") {
    return validateSession(request, config.signingSecret)
      ? empty(204)
      : json(404, { error: "mcp_session_not_found" })
  }
  if (request.method !== "POST") return empty(405, { allow: "POST, DELETE" })
  if (!authorized(request, config.bearerToken)) {
    return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" })
  }
  if (!acceptsMcp(request)) {
    return json(406, { error: "not_acceptable", message: "Accept must include application/json and text/event-stream" })
  }
  if (Buffer.byteLength(rawBody, "utf8") > maximumRequestBytes) {
    return json(413, { error: "payload_too_large" })
  }

  let value: unknown
  try {
    value = JSON.parse(rawBody)
  } catch {
    return json(400, { error: "invalid_json" })
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return json(400, rpcError(null, -32600, "Invalid JSON-RPC request"))
  }

  const id = requestId(value)
  if (value.method === "initialize") {
    if (id === null) return json(400, rpcError(null, -32600, "Initialize requires a JSON-RPC id"))
    const version = negotiatedVersion(value)
    return json(200, rpcResult(id, {
      capabilities: { tools: { listChanged: false } },
      instructions: "Synthetic OpenWork Diagnostics endpoint. No customer content is returned or retained.",
      protocolVersion: version,
      serverInfo: { name: "openwork-diagnostics", version: "1.0.0" },
    }), {
      "mcp-protocol-version": version,
      "mcp-session-id": createSessionToken(config.signingSecret),
    })
  }

  if (!validateSession(request, config.signingSecret)) return json(404, { error: "mcp_session_not_found" })
  const protocolVersion = request.headers.get("mcp-protocol-version") ?? ""
  if (!supportedVersions.some((version) => version === protocolVersion)) {
    return json(400, { error: "mcp_protocol_version_mismatch", supportedVersions })
  }

  if (value.method === "notifications/initialized") return empty(202)
  if (id === null) return empty(202)
  if (value.method === "ping") return json(200, rpcResult(id, {}))
  if (value.method === "tools/list") return json(200, rpcResult(id, { tools: [toolDefinition(config.profile)] }))
  if (value.method === "tools/call") {
    return json(200, rpcResult(id, {
      content: [{ text: "The Diagnostics endpoint received and safely handled the synthetic tool request.", type: "text" }],
      isError: false,
      structuredContent: { connected: true, profile: config.profile },
    }))
  }
  return json(200, rpcError(id, -32601, "Method not found"))
}
