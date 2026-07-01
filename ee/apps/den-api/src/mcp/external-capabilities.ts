import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  getExternalMcpConnection,
  listExternalMcpConnections,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import { callExternalMcpTool, listExternalMcpTools } from "../capability-sources/external-mcp-client.js"
import { tokenize } from "./search.js"
import type { CapabilityMatch } from "./search.js"

/**
 * Merges org-level External MCP Connections (capability-sources/) into the
 * same search_capabilities/execute_capability surface as the REST-derived
 * catalog (catalog.ts), without touching that catalog or the rich `/mcp`
 * endpoint at all. A connected external tool is namespaced
 * `mcp:<connectionId>:<toolName>` so execute_capability can tell it apart
 * from a REST operation name and dispatch to the real MCP client
 * (external-mcp-client.ts) instead of invokeMcpOperation.
 */

const EXTERNAL_CAPABILITY_PREFIX = "mcp:"

export function buildExternalCapabilityName(connectionId: string, toolName: string): string {
  return `${EXTERNAL_CAPABILITY_PREFIX}${connectionId}:${toolName}`
}

export function parseExternalCapabilityName(name: string): { connectionId: string; toolName: string } | null {
  if (!name.startsWith(EXTERNAL_CAPABILITY_PREFIX)) return null
  const rest = name.slice(EXTERNAL_CAPABILITY_PREFIX.length)
  const separatorIndex = rest.indexOf(":")
  if (separatorIndex <= 0) return null
  return {
    connectionId: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 1),
  }
}

function isConnected(connection: ExternalMcpConnectionRow): boolean {
  if (connection.authType === "oauth") return Boolean(connection.accessToken)
  if (connection.authType === "apikey") return Boolean(connection.apiKey)
  return true
}

function redirectUriFor(redirectUriBase: string, connectionId: string): string {
  return `${redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`
}

function scoreText(nameTokens: string[], summaryTokens: string[], queryTokens: string[]): number {
  let score = 0
  for (const queryToken of queryTokens) {
    if (nameTokens.includes(queryToken)) {
      score += 5
    } else if (nameTokens.some((token) => token.startsWith(queryToken) || queryToken.startsWith(token))) {
      score += 3
    }
    if (summaryTokens.includes(queryToken)) {
      score += 2
    }
  }
  return score
}

/**
 * Live-lists tools for every connected external MCP connection in the org
 * and returns the ones matching `query`, in the same CapabilityMatch shape
 * the REST catalog uses. Each connection is best-effort: one unreachable
 * external server doesn't fail the whole search.
 */
export async function searchExternalCapabilities(input: {
  organizationId: string
  query: string
  redirectUriBase: string
  limit?: number
}): Promise<CapabilityMatch[]> {
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []

  const connections = (await listExternalMcpConnections(normalizeDenTypeId("organization", input.organizationId))).filter(isConnected)
  const matches: CapabilityMatch[] = []

  for (const connection of connections) {
    let tools: Awaited<ReturnType<typeof listExternalMcpTools>>
    try {
      tools = await listExternalMcpTools(connection, redirectUriFor(input.redirectUriBase, connection.id))
    } catch {
      continue
    }

    for (const tool of tools) {
      const summary = tool.description ?? tool.title ?? tool.name
      const nameTokens = tokenize(`${connection.name} ${tool.name}`)
      const summaryTokens = tokenize(summary)
      const score = scoreText(nameTokens, summaryTokens, queryTokens)
      if (score <= 0) continue
      matches.push({
        name: buildExternalCapabilityName(connection.id, tool.name),
        method: "MCP",
        path: connection.url,
        score,
        summary: `[${connection.name}] ${summary}`,
        pathParams: [],
        queryParams: [],
        hasBody: true,
      })
    }
  }

  matches.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
  return matches.slice(0, input.limit ?? 5)
}

export type ExternalCapabilityExecuteResult =
  | { ok: true; result: Awaited<ReturnType<typeof callExternalMcpTool>> }
  | { ok: false; error: "unknown_capability" | "connection_not_connected"; message: string }

/** Executes a namespaced external capability, scoped to the calling principal's org — a connection from another org can never be reached this way. */
export async function executeExternalCapability(input: {
  organizationId: string
  connectionId: string
  toolName: string
  args: Record<string, unknown>
  redirectUriBase: string
}): Promise<ExternalCapabilityExecuteResult> {
  let connection: Awaited<ReturnType<typeof getExternalMcpConnection>>
  try {
    connection = await getExternalMcpConnection({
      organizationId: normalizeDenTypeId("organization", input.organizationId),
      connectionId: normalizeDenTypeId("externalMcpConnection", input.connectionId),
    })
  } catch {
    // A malformed connectionId (e.g. hand-typed by an agent) isn't a server
    // error — it's the same "no such capability" outcome as a valid-shaped
    // but nonexistent id, so surface the same clean error either way.
    connection = null
  }
  if (!connection) {
    return { ok: false, error: "unknown_capability", message: `No external MCP connection "${input.connectionId}" in this organization.` }
  }
  if (!isConnected(connection)) {
    return { ok: false, error: "connection_not_connected", message: `"${connection.name}" is not connected yet.` }
  }

  const result = await callExternalMcpTool({
    connection,
    redirectUri: redirectUriFor(input.redirectUriBase, connection.id),
    toolName: input.toolName,
    args: input.args,
  })
  return { ok: true, result }
}
