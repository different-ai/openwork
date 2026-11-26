import type { Hono } from "hono"
import { PERSONAL_AGENT_UNAPPROVABLE_WRITE, personalAgentMayUseBuiltInConnectors, personalAgentPolicyRefusal, personalAgentRunDispatchRefusal } from "../personal-agents/permissions-dispatch.js"
import { personalAgentRunId } from "./workbot-turn-limits.js"
import { createInternalCapabilityConnectorHeader, createInternalMcpPrincipalHeader, INTERNAL_CAPABILITY_CONNECTOR_HEADER } from "../session.js"
import { mcpPrincipalCredentialId, type McpPrincipal } from "./auth.js"
import type { McpToolOperation } from "./catalog.js"
import { requiredScopeForMethod } from "./policy.js"
import { buildRestToolContent } from "./tool-content.js"

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

export function normalizeToolRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? normalizeToolBody(value) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(parsed)) {
    record[key] = entry
  }
  return record
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
  nativeConnectionId?: string
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
      credentialId: mcpPrincipalCredentialId(input.principal),
    }),
  })
  if (input.nativeConnectionId) {
    headers.set(INTERNAL_CAPABILITY_CONNECTOR_HEADER, createInternalCapabilityConnectorHeader({
      userId: input.principal.userId,
      organizationId: input.principal.organizationId,
      connectorId: input.nativeConnectionId,
    }))
  }

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

export type McpOperationResult = {
  isError: boolean
  content: Awaited<ReturnType<typeof buildRestToolContent>>
  payload?: unknown
}

export async function invokeMcpOperation(input: {
  app: Hono
  env: unknown
  operation: McpToolOperation
  principal: McpPrincipal
  nativeConnectionId?: string
  toolInput: ToolInput
  includePayload?: boolean
}): Promise<McpOperationResult> {
  if (personalAgentRunId(input.principal.scopes) !== undefined) {
    const refusal = await personalAgentRunDispatchRefusal(input.principal.scopes, input.principal.organizationId)
      ?? (input.nativeConnectionId && !await personalAgentMayUseBuiltInConnectors(input.principal.scopes, input.principal.organizationId)
        ? personalAgentPolicyRefusal("Built-in connectors are not available to this agent.") : null)
      ?? (input.operation.method === "GET" ? null : personalAgentPolicyRefusal(input.nativeConnectionId
        ? "Built-in connectors cannot ask first yet, so an agent can only read them."
        : PERSONAL_AGENT_UNAPPROVABLE_WRITE))
    if (refusal) return { isError: true, content: [{ type: "text", text: JSON.stringify(refusal) }], payload: refusal }
  }
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

  return {
    isError: response.status >= 400,
    content: await buildRestToolContent(payload),
    ...(input.includePayload ? { payload } : {}),
  }
}
