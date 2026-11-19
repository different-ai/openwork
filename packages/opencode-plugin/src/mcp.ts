/**
 * OpenWork Cloud MCP through Den's MCP gateway, the same way the desktop does:
 *
 * - `openwork-cloud` → `<api>/mcp/agent` (search_capabilities / execute_capability …)
 * - `openwork-direct-<slug>-<hash>` → `<api>/mcp/agent/connections/<id>` for each
 *   connection an administrator exposed directly.
 *
 * Both carry the member's first-party MCP token (`POST /v1/mcp/token`, 7 days).
 * The connection list is an MCP resource on /mcp/agent; with an ordinary token
 * Den returns only directly exposed, ready connections.
 */
import { createHash } from "node:crypto"
import { DenUrlError, denRequest, isAllowedApiBaseUrl, isRecord, normalizeBaseUrl, type DenSession, type Fetch } from "./den.ts"
import type { RemoteMcpConfig } from "./opencode.ts"

export const CLOUD_SERVER_NAME = "openwork-cloud"
export const DIRECT_SERVER_PREFIX = "openwork-direct-"
export const SERVER_INDEX_URI = "openwork://connect/mcp-servers/index.json"
const SERVER_INDEX_SCHEMA = "openwork.connect/mcp-servers/1"
/** Re-mint inside the last day, like the desktop (cloud-mcp-reconciler CLOUD_MCP_REFRESH_MARGIN_MS). */
export const MCP_TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000

export interface McpToken {
  readonly token: string
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

export interface DirectServer {
  readonly connectionId: string
  readonly name: string
  readonly url: string
}

export async function mintMcpToken(fetcher: Fetch, session: DenSession): Promise<McpToken> {
  const body = await denRequest(fetcher, session, "/v1/mcp/token", {
    method: "POST",
    body: { scopes: ["mcp:read", "mcp:write"] },
  })
  const token = isRecord(body) && typeof body.token === "string" ? body.token : null
  const expiresAt = isRecord(body) && typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN
  if (!token || !Number.isFinite(expiresAt)) throw new Error("OpenWork returned an unusable MCP token.")
  return { token, expiresAt }
}

export function mcpTokenNeedsRenewal(token: McpToken | null, now: number): boolean {
  return !token || token.expiresAt - now <= MCP_TOKEN_REFRESH_MARGIN_MS
}

export function agentUrl(apiBaseUrl: string): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/mcp/agent`
}

/** Same naming as the desktop (apps/server/src/connect-mcp-server-catalog.ts connectDirectMcpRuntimeName). */
export function directServerName(server: { connectionId: string; name: string }): string {
  const slug = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  const digest = createHash("sha256").update(server.connectionId).digest("hex").slice(0, 6)
  return `${DIRECT_SERVER_PREFIX}${slug ? `${slug}-` : ""}${digest}`
}

export function isOwnedServerName(name: string): boolean {
  return name === CLOUD_SERVER_NAME || name.startsWith(DIRECT_SERVER_PREFIX)
}

export function mcpServerEntries(input: {
  apiBaseUrl: string
  token: string
  servers: readonly DirectServer[]
}): Record<string, RemoteMcpConfig> {
  // Never hand OpenCode a bearer for a plain-HTTP remote host.
  if (!isAllowedApiBaseUrl(input.apiBaseUrl)) return {}
  const headers = { Authorization: `Bearer ${input.token}` }
  // oauth:false — the bearer is ours; OpenCode must not start its own MCP OAuth flow on a 401.
  const entries: Record<string, RemoteMcpConfig> = {
    [CLOUD_SERVER_NAME]: { type: "remote", url: agentUrl(input.apiBaseUrl), headers, oauth: false },
  }
  for (const server of input.servers) {
    entries[directServerName(server)] = { type: "remote", url: server.url, headers, oauth: false }
  }
  return entries
}

// ---- Minimal Streamable HTTP client for the index resource ----
// Ported from apps/server/src/connect-mcp-transport.ts.

function parseJsonOrText(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function readMcpPayload(response: Response, requestId?: number): Promise<unknown> {
  const matches = (payload: unknown) =>
    requestId === undefined ||
    (isRecord(payload) && payload.jsonrpc === "2.0" && payload.id === requestId && (payload.result !== undefined || payload.error !== undefined))
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const raw = await response.text()
    const payload = raw.trim() ? parseJsonOrText(raw) : null
    return matches(payload) ? payload : null
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let data: string[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return null
      pending += decoder.decode(chunk.value, { stream: true })
      let end = pending.search(/\r\n|\r|\n/)
      while (end !== -1) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + (pending.startsWith("\r\n", end) ? 2 : 1))
        if (line === "") {
          if (data.length) {
            const payload = parseJsonOrText(data.join("\n"))
            data = []
            if (matches(payload)) return payload
          }
        } else if (line === "data" || line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""))
        }
        end = pending.search(/\r\n|\r|\n/)
      }
    }
  } finally {
    // A server may keep the stream open after the result. Never wait for EOF.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function jsonRpcResult(payload: unknown): Record<string, unknown> | null {
  const record = Array.isArray(payload) ? payload.find(isRecord) : payload
  if (!isRecord(record) || record.error !== undefined || !isRecord(record.result)) return null
  return record.result
}

async function mcpPost(fetcher: Fetch, url: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  const id = typeof body.id === "number" ? body.id : undefined
  return { response, payload: await readMcpPayload(response, id) }
}

export class McpIndexError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = "McpIndexError"
    this.status = status
  }
}

async function readResourceText(fetcher: Fetch, url: string, token: string, uri: string): Promise<string> {
  const base = { authorization: `Bearer ${token}` }
  const initialized = await mcpPost(fetcher, url, base, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "opencode-openwork", version: "0.1.0" },
      protocolVersion: "2025-06-18",
    },
  })
  if (!initialized.response.ok) throw new McpIndexError("OpenWork MCP rejected the session.", initialized.response.status)
  const protocolVersion = jsonRpcResult(initialized.payload)?.protocolVersion
  if (protocolVersion !== "2025-06-18" && protocolVersion !== "2025-03-26") {
    throw new McpIndexError(`Unsupported MCP protocol version ${String(protocolVersion)}.`)
  }
  const sessionId = initialized.response.headers.get("mcp-session-id")
  const headers: Record<string, string> = {
    ...base,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "mcp-protocol-version": protocolVersion,
  }
  const notified = await mcpPost(fetcher, url, headers, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
  if (notified.response.status >= 400) throw new McpIndexError("OpenWork MCP rejected the session.", notified.response.status)
  const read = await mcpPost(fetcher, url, headers, { id: 2, jsonrpc: "2.0", method: "resources/read", params: { uri } })
  if (!read.response.ok) throw new McpIndexError("OpenWork MCP could not list connections.", read.response.status)
  const contents = jsonRpcResult(read.payload)?.contents
  const text = Array.isArray(contents)
    ? contents.find((item) => isRecord(item) && item.uri === uri && typeof item.text === "string")
    : undefined
  if (!isRecord(text) || typeof text.text !== "string") throw new McpIndexError("OpenWork MCP returned no connection list.")
  return text.text
}

/** Directly exposed connections, restricted to the API origin we signed in to. */
export function parseServerIndex(text: string, apiBaseUrl: string): DirectServer[] {
  const value = parseJsonOrText(text)
  if (!isRecord(value) || value.schemaVersion !== SERVER_INDEX_SCHEMA || !Array.isArray(value.servers)) {
    throw new McpIndexError("OpenWork returned an unrecognized connection list.")
  }
  const origin = new URL(normalizeBaseUrl(apiBaseUrl)).origin
  const servers: DirectServer[] = []
  for (const entry of value.servers) {
    if (!isRecord(entry) || entry.exposeDirectly !== true) continue
    const connectionId = typeof entry.connectionId === "string" ? entry.connectionId : ""
    const name = typeof entry.name === "string" ? entry.name : ""
    const url = typeof entry.url === "string" ? entry.url : ""
    if (!connectionId || !name || !url) continue
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    // Only ever send the member's token to the Den it was issued by.
    if (parsed.origin !== origin || !parsed.pathname.startsWith("/mcp/agent/connections/")) continue
    servers.push({ connectionId, name, url: parsed.toString() })
  }
  return servers.sort((left, right) => left.name.localeCompare(right.name) || left.connectionId.localeCompare(right.connectionId))
}

export async function fetchDirectServers(fetcher: Fetch, apiBaseUrl: string, token: string): Promise<DirectServer[]> {
  if (!isAllowedApiBaseUrl(apiBaseUrl)) throw new DenUrlError(apiBaseUrl)
  const text = await readResourceText(fetcher, agentUrl(apiBaseUrl), token, SERVER_INDEX_URI)
  return parseServerIndex(text, apiBaseUrl)
}
