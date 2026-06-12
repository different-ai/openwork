import type { Hono } from "hono"
import { createInternalMcpPrincipalHeader } from "../session.js"
import type { McpPrincipal } from "./auth.js"
import type { McpToolOperation } from "./catalog.js"
import { requiredScopeForMethod } from "./policy.js"

type ToolInput = {
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
}

function encodeQueryValue(value: unknown) {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return JSON.stringify(value)
}

/**
 * MCP clients sometimes pass `body` as a JSON-encoded string instead of an
 * object (the tool input schema accepts unknown). Forwarding that string
 * as-is double-encodes the payload and route validators reject it with
 * "expected object, received string". Parse such strings back into JSON.
 */
export function normalizeToolBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body
  }
  const trimmed = body.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return body
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return body
  }
}

function buildPath(template: string, values: Record<string, unknown>) {
  return template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = values[key]
    if (value === null || value === undefined) {
      throw new Error(`Missing path parameter: ${key}`)
    }
    return encodeURIComponent(String(value))
  })
}

function buildInternalRequest(input: {
  operation: McpToolOperation
  toolInput: ToolInput
  principal: McpPrincipal
}) {
  const path = buildPath(input.operation.path, input.toolInput.path ?? {})
  const url = new URL(path, "http://den-api.local")

  for (const [key, value] of Object.entries(input.toolInput.query ?? {})) {
    const encoded = encodeQueryValue(value)
    if (encoded !== null) {
      url.searchParams.set(key, encoded)
    }
  }

  const headers = new Headers({
    accept: "application/json",
    "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({
      userId: input.principal.userId,
      organizationId: input.principal.organizationId,
    }),
  })

  let body: BodyInit | undefined
  if (input.operation.method !== "GET" && input.operation.method !== "HEAD" && input.toolInput.body !== undefined) {
    headers.set("content-type", "application/json")
    body = JSON.stringify(normalizeToolBody(input.toolInput.body))
  }

  return new Request(url, {
    method: input.operation.method,
    headers,
    body,
  })
}

export async function invokeMcpOperation(input: {
  app: Hono
  env: unknown
  operation: McpToolOperation
  principal: McpPrincipal
  toolInput: ToolInput
}) {
  const requiredScope = requiredScopeForMethod(input.operation.method)
  if (!input.principal.scopes.has(requiredScope)) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: "insufficient_mcp_scope", requiredScope }) }],
    }
  }

  let request: Request
  try {
    request = buildInternalRequest(input)
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ error: "invalid_tool_input", message: error instanceof Error ? error.message : String(error) }) }],
    }
  }

  const response = await input.app.fetch(request, input.env)
  const contentType = response.headers.get("content-type") ?? ""
  const payload = contentType.includes("application/json") ? await response.json() : await response.text()
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)

  return {
    isError: response.status >= 400,
    content: [{ type: "text" as const, text }],
  }
}
